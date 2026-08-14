import asyncio
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from backend import database
from backend.main import app
from backend.room import Player, Room


class FakeWebSocket:
    async def send_json(self, _message):
        return None


class HistoryPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database.DB_PATH = Path(self.temp_dir.name) / "history.db"
        database.initialize_database()
        self.black = database.create_user("black_user", "BlackPass123")
        self.white = database.create_user("white_user", "WhitePass123")

    async def asyncTearDown(self):
        for task in list(asyncio.all_tasks()):
            if task is not asyncio.current_task() and "_wait_for_timeout" in repr(task.get_coro()):
                task.cancel()
        self.temp_dir.cleanup()

    async def make_room(self) -> Room:
        room = Room("ABC123", history_writer=database.save_game_history)
        await room.connect(str(self.black.id), self.black.username, FakeWebSocket())
        await room.connect(str(self.white.id), self.white.username, FakeWebSocket())
        return room

    async def test_black_five_in_a_row_saves_one_history_and_ordered_moves(self):
        room = await self.make_room()
        for col in range(5):
            room.place_move(7, col, "black")
            if col < 4:
                room.place_move(8, col, "white")

        records = database.list_game_history_for_user(self.black.id)
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["winner_user_id"], self.black.id)
        self.assertEqual(record["winner_color"], "black")
        self.assertEqual(record["result_reason"], "five_in_a_row")
        self.assertEqual(record["move_count"], 9)
        self.assertLessEqual(record["started_at"], record["finished_at"])
        self.assertGreaterEqual(record["duration_seconds"], 0)
        moves = database.get_game_moves(record["id"])
        self.assertEqual([move["move_number"] for move in moves], list(range(1, 10)))
        self.assertEqual((moves[0]["row"], moves[0]["col"]), (7, 0))

        room._persist_history_once()
        self.assertEqual(len(database.list_game_history_for_user(self.black.id)), 1)

    async def test_white_five_in_a_row_is_saved_with_correct_winner(self):
        room = await self.make_room()
        for col in range(4):
            room.place_move(8, col, "black")
            room.place_move(7, col, "white")
        room.place_move(10, 10, "black")
        room.place_move(7, 4, "white")

        record = database.list_game_history_for_user(self.white.id)[0]
        self.assertEqual(record["winner_user_id"], self.white.id)
        self.assertEqual(record["winner_color"], "white")
        self.assertEqual(record["move_count"], 10)

    async def test_timeout_saves_history_with_no_extra_move(self):
        room = await self.make_room()
        room.place_move(7, 7, "black")
        room.turn_deadline = time.time() - 0.01

        self.assertFalse(room.place_move(7, 8, "white"))

        record = database.list_game_history_for_user(self.black.id)[0]
        self.assertEqual(record["result_reason"], "timeout")
        self.assertEqual(record["winner_color"], "black")
        self.assertEqual(record["move_count"], 1)

    async def test_draw_and_duplicate_game_id_are_stored_once(self):
        room = await self.make_room()
        room.stop_turn_timer()
        room.game.draw = True
        room.game.result_reason = "draw"
        room._persist_history_once()
        room.history_persisted = False
        room._persist_history_once()

        records = database.list_game_history_for_user(self.black.id)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["result_reason"], "draw")
        self.assertIsNone(records[0]["winner_user_id"])
        self.assertIsNone(records[0]["winner_color"])

    async def test_rematch_creates_independent_game_id_and_history(self):
        room = await self.make_room()
        room.finish_timeout()
        first_game_id = room.game_id
        room.request_rematch(str(self.black.id))
        room.accept_rematch(str(self.white.id))
        second_game_id = room.game_id
        room.finish_timeout()

        self.assertNotEqual(first_game_id, second_game_id)
        records = database.list_game_history_for_user(self.black.id)
        self.assertEqual(len(records), 2)
        self.assertEqual(len({record["game_id"] for record in records}), 2)

    async def test_history_failure_is_logged_without_breaking_game_result(self):
        def failing_writer(_history, _moves):
            raise sqlite_error

        sqlite_error = RuntimeError("simulated storage failure")
        room = Room("FAIL01", history_writer=failing_writer)
        room.players = {
            str(self.black.id): Player(str(self.black.id), self.black.username, "black", user_id=self.black.id),
            str(self.white.id): Player(str(self.white.id), self.white.username, "white", user_id=self.white.id),
        }
        room._begin_game()

        with self.assertLogs("gomoku.room", level="ERROR"):
            room.finish_timeout()

        self.assertTrue(room.game.finished)
        self.assertEqual(room.game.result_reason, "timeout")
        self.assertFalse(room.history_persisted)


class HistoryPermissionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database.DB_PATH = Path(self.temp_dir.name) / "permissions.db"
        os.environ["ADMIN_USERNAME"] = "HistoryAdmin"
        os.environ["ADMIN_INITIAL_PASSWORD"] = "HistoryAdminPass123"
        self.client = TestClient(app)
        self.client.__enter__()
        self.alice = database.create_user("history_alice", "AlicePass123")
        self.bob = database.create_user("history_bob", "BobPass123")
        self.outsider = database.create_user("history_outsider", "OutsidePass123")
        started = datetime.now(timezone.utc) - timedelta(seconds=75)
        finished = datetime.now(timezone.utc)
        self.game_id = "permission-game-1"
        database.save_game_history(
            {
                "game_id": self.game_id,
                "room_code": "ROOM01",
                "black_user_id": self.alice.id,
                "black_username": self.alice.username,
                "white_user_id": self.bob.id,
                "white_username": self.bob.username,
                "winner_user_id": self.alice.id,
                "winner_username": self.alice.username,
                "winner_color": "black",
                "result_reason": "five_in_a_row",
                "started_at": started.isoformat(),
                "finished_at": finished.isoformat(),
                "duration_seconds": 75,
                "created_at": finished.isoformat(),
            },
            [
                {"move_number": 1, "user_id": self.alice.id, "username": self.alice.username, "color": "black", "row": 7, "col": 7, "played_at": started.isoformat()},
                {"move_number": 2, "user_id": self.bob.id, "username": self.bob.username, "color": "white", "row": 7, "col": 8, "played_at": finished.isoformat()},
            ],
        )

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp_dir.cleanup()

    def login(self, username: str, password: str):
        return self.client.post("/api/login", json={"username": username, "password": password})

    def test_user_only_lists_own_games_and_can_rebuild_final_board(self):
        self.assertEqual(self.login("history_alice", "AlicePass123").status_code, 200)
        records = self.client.get("/api/history").json()
        self.assertEqual([record["game_id"] for record in records], [self.game_id])
        self.assertEqual(records[0]["outcome"], "win")
        self.assertEqual(records[0]["opponent_username"], "history_bob")

        detail = self.client.get(f"/api/history/{self.game_id}")
        self.assertEqual(detail.status_code, 200)
        body = detail.json()
        self.assertEqual(body["final_board"][7][7], "black")
        self.assertEqual(body["final_board"][7][8], "white")
        self.assertEqual([move["move_number"] for move in body["moves"]], [1, 2])
        self.assertNotIn("chat", str(body).lower())

    def test_outsider_cannot_list_or_open_another_users_game(self):
        self.assertEqual(self.login("history_outsider", "OutsidePass123").status_code, 200)
        self.assertEqual(self.client.get("/api/history").json(), [])
        self.assertEqual(self.client.get(f"/api/history/{self.game_id}").status_code, 403)
        self.assertEqual(self.client.get(f"/history/{self.game_id}").status_code, 403)

    def test_developer_can_filter_and_view_all_history(self):
        self.assertEqual(self.login("HistoryAdmin", "HistoryAdminPass123").status_code, 200)
        response = self.client.get("/api/admin/history", params={"username": "alice", "room_code": "room01"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([record["game_id"] for record in response.json()], [self.game_id])
        self.assertEqual(self.client.get(f"/api/history/{self.game_id}").status_code, 200)
        self.assertEqual(self.client.get("/admin/history").status_code, 200)

    def test_history_survives_logout_and_login(self):
        self.assertEqual(self.login("history_bob", "BobPass123").status_code, 200)
        self.assertEqual(len(self.client.get("/api/history").json()), 1)
        self.client.post("/api/logout")
        self.assertEqual(self.login("history_bob", "BobPass123").status_code, 200)
        self.assertEqual(len(self.client.get("/api/history").json()), 1)

    def test_history_schema_has_no_chat_and_survives_reinitialization(self):
        database.initialize_database()
        record = database.get_game_history(self.game_id)
        self.assertIsNotNone(record)
        with database._connect() as connection:
            history_columns = {row[1] for row in connection.execute("PRAGMA table_info(game_history)")}
            move_columns = {row[1] for row in connection.execute("PRAGMA table_info(game_moves)")}
        self.assertFalse({"chat", "message", "chat_content"} & history_columns)
        self.assertFalse({"chat", "message", "chat_content"} & move_columns)


if __name__ == "__main__":
    unittest.main()
