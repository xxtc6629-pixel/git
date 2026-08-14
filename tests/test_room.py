import asyncio
import time
import unittest

from backend.game import GameError
from backend.room import Player, Room


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(message)


class RoomRematchTests(unittest.IsolatedAsyncioTestCase):
    def make_finished_room(self):
        room = Room("ABC123")
        room.players = {
            "a": Player("a", "alice", "black"),
            "b": Player("b", "bob", "white"),
        }
        room.game.winner = "black"
        room.game.result_reason = "five_in_a_row"
        return room

    async def asyncTearDown(self):
        for task in list(asyncio.all_tasks()):
            if task is not asyncio.current_task() and "_wait_for_timeout" in repr(task.get_coro()):
                task.cancel()

    async def test_rematch_requires_opponent_and_swaps_colors(self):
        room = self.make_finished_room()
        room.request_rematch("a")

        with self.assertRaises(GameError):
            room.accept_rematch("a")

        before_restart = time.time()
        room.accept_rematch("b")
        self.assertEqual(room.players["a"].color, "white")
        self.assertEqual(room.players["b"].color, "black")
        self.assertEqual(room.game.turn, "black")
        self.assertFalse(room.game.finished)
        self.assertTrue(all(cell is None for row in room.game.board for cell in row))
        self.assertEqual(room.round_number, 2)
        self.assertIsNone(room.rematch_requester)
        self.assertGreaterEqual(room.turn_deadline, before_restart + 59)
        room.stop_turn_timer()

    async def test_decline_keeps_finished_game_and_no_new_timer(self):
        room = self.make_finished_room()
        room.request_rematch("a")
        requester = room.decline_rematch("b")

        self.assertEqual(requester, "a")
        self.assertEqual(room.game.winner, "black")
        self.assertEqual(room.players["a"].color, "black")
        self.assertIsNone(room.rematch_requester)
        self.assertIsNone(room.turn_deadline)

    async def test_rematch_only_after_game_end(self):
        room = self.make_finished_room()
        room.game.winner = None
        room.game.result_reason = None
        with self.assertRaises(GameError):
            room.request_rematch("a")


class RoomTimerTests(unittest.IsolatedAsyncioTestCase):
    async def test_timer_starts_when_second_player_joins_and_reconnect_keeps_deadline(self):
        room = Room("ABC123")
        first = FakeWebSocket()
        second = FakeWebSocket()
        self.assertEqual(await room.connect("a", "alice", first), "black")
        self.assertIsNone(room.turn_deadline)
        self.assertEqual(await room.connect("b", "bob", second), "white")
        original_deadline = room.turn_deadline
        self.assertIsNotNone(original_deadline)

        self.assertEqual(await room.connect("a", "alice", FakeWebSocket()), "black")
        self.assertEqual(room.turn_deadline, original_deadline)
        room.stop_turn_timer()

    async def test_accepted_move_switches_turn_and_resets_full_time(self):
        room = Room("ABC123")
        room.players = {"a": Player("a", "alice", "black"), "b": Player("b", "bob", "white")}
        room.start_turn_timer()
        first_deadline = room.turn_deadline
        await asyncio.sleep(0.03)

        self.assertTrue(room.place_move(7, 7, "black"))
        self.assertEqual(room.game.turn, "white")
        self.assertGreater(room.turn_deadline, first_deadline)
        room.stop_turn_timer()

    async def test_expired_move_is_rejected_and_current_player_loses(self):
        room = Room("ABC123")
        room.players = {"a": Player("a", "alice", "black"), "b": Player("b", "bob", "white")}
        room.turn_deadline = time.time() - 0.01

        self.assertFalse(room.place_move(7, 7, "black"))
        self.assertIsNone(room.game.board[7][7])
        self.assertEqual(room.game.winner, "white")
        self.assertEqual(room.game.result_reason, "timeout")
        self.assertIsNone(room.turn_deadline)

        with self.assertRaises(GameError):
            room.place_move(7, 7, "black")

    async def test_timeout_task_finishes_game_and_broadcasts(self):
        first = FakeWebSocket()
        second = FakeWebSocket()
        room = Room("ABC123", turn_seconds=0.02)
        room.players = {
            "a": Player("a", "alice", "black", first),
            "b": Player("b", "bob", "white", second),
        }
        room.start_turn_timer()
        await asyncio.sleep(0.05)

        self.assertEqual(room.game.winner, "white")
        self.assertEqual(room.game.result_reason, "timeout")
        self.assertIsNone(room.turn_deadline)
        self.assertEqual(first.messages[-1]["result_reason"], "timeout")
        self.assertEqual(second.messages[-1]["winner"], "white")

    async def test_five_in_a_row_stops_timer(self):
        room = Room("ABC123")
        room.players = {"a": Player("a", "alice", "black"), "b": Player("b", "bob", "white")}
        room.start_turn_timer()
        for index in range(5):
            room.place_move(7, index, "black")
            if index < 4:
                room.place_move(8, index, "white")

        self.assertEqual(room.game.winner, "black")
        self.assertEqual(room.game.result_reason, "five_in_a_row")
        self.assertIsNone(room.turn_deadline)


if __name__ == "__main__":
    unittest.main()
