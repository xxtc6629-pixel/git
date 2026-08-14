import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import database
from backend.main import app


class AuthAndAdminTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database.DB_PATH = Path(self.temp_dir.name) / "test.db"
        os.environ["ADMIN_USERNAME"] = "AdminOne"
        os.environ["ADMIN_INITIAL_PASSWORD"] = "AdminPass123"
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp_dir.cleanup()

    def login(self, username="AdminOne", password="AdminPass123"):
        return self.client.post("/api/login", json={"username": username, "password": password})

    def create_regular_user(self, username="friend", password="FriendPass123"):
        self.assertEqual(self.login().status_code, 200)
        response = self.client.post(
            "/api/admin/users",
            json={"username": username, "password": password},
        )
        self.assertEqual(response.status_code, 201)
        self.client.post("/api/logout")
        return response.json()

    def test_correct_and_wrong_password_login(self):
        self.assertEqual(self.login().status_code, 200)
        self.client.post("/api/logout")
        wrong = self.login(password="WrongPass123")
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(wrong.json()["detail"], "账号或密码错误")
        missing = self.login("missing-user", "WrongPass123")
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(missing.json()["detail"], "账号或密码错误")

    def test_database_stores_hash_not_plaintext(self):
        with closing(sqlite3.connect(database.DB_PATH)) as connection:
            columns = [row[1] for row in connection.execute("PRAGMA table_info(users)")]
            stored = connection.execute(
                "SELECT password_hash FROM users WHERE username = 'AdminOne'"
            ).fetchone()[0]
        self.assertNotIn("password", columns)
        self.assertIn("password_hash", columns)
        self.assertNotEqual(stored, "AdminPass123")
        self.assertTrue(stored.startswith("$2"))

    def test_existing_empty_database_gets_initial_admin(self):
        empty_database = Path(self.temp_dir.name) / "existing-empty.db"
        database.DB_PATH = empty_database
        database.initialize_database()
        with closing(sqlite3.connect(empty_database)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM users").fetchone()[0], 0)

        admin = database.ensure_initial_admin()

        self.assertEqual(admin.username, "AdminOne")
        self.assertEqual(admin.role, "developer")
        self.assertTrue(admin.is_active)

    def test_existing_admin_password_is_not_reset_on_startup(self):
        self.assertEqual(self.login().status_code, 200)
        self.client.post("/api/logout")
        os.environ["ADMIN_INITIAL_PASSWORD"] = "DifferentPass456"

        database.ensure_initial_admin()

        self.assertEqual(self.login(password="AdminPass123").status_code, 200)
        self.client.post("/api/logout")
        self.assertEqual(self.login(password="DifferentPass456").status_code, 401)

    def test_unauthenticated_user_cannot_use_game_or_websocket(self):
        self.assertEqual(self.client.post("/api/rooms").status_code, 401)
        self.assertEqual(self.client.get("/api/me").status_code, 401)
        with self.assertRaises(WebSocketDisconnect) as context:
            with self.client.websocket_connect("/ws/ABC123"):
                pass
        self.assertEqual(context.exception.code, 4401)

    def test_regular_user_cannot_access_admin_page_or_api(self):
        self.create_regular_user()
        self.assertEqual(self.login("friend", "FriendPass123").status_code, 200)
        self.assertEqual(self.client.get("/admin").status_code, 403)
        denied = self.client.post(
            "/api/admin/users",
            json={"username": "blocked", "password": "BlockedPass123"},
        )
        self.assertEqual(denied.status_code, 403)

    def test_developer_creates_user_and_new_user_can_login(self):
        created = self.create_regular_user("xiaoming", "XiaomingPass123")
        self.assertEqual(created["role"], "user")
        self.assertNotIn("password_hash", created)
        self.assertEqual(self.login("xiaoming", "XiaomingPass123").status_code, 200)

    def test_authenticated_websocket_uses_session_username(self):
        self.assertEqual(self.login().status_code, 200)
        room_id = self.client.post("/api/rooms").json()["room_id"]
        with self.client.websocket_connect(f"/ws/{room_id}") as websocket:
            self.assertEqual(websocket.receive_json()["color"], "black")
            state = websocket.receive_json()
            self.assertEqual(state["player_names"]["black"], "AdminOne")

    def test_password_reset_invalidates_old_password(self):
        user = self.create_regular_user()
        self.assertEqual(self.login().status_code, 200)
        reset = self.client.patch(
            f"/api/admin/users/{user['id']}/password",
            json={"password": "NewFriendPass456"},
        )
        self.assertEqual(reset.status_code, 200)
        self.client.post("/api/logout")
        self.assertEqual(self.login("friend", "FriendPass123").status_code, 401)
        self.assertEqual(self.login("friend", "NewFriendPass456").status_code, 200)

    def test_inactive_user_cannot_login(self):
        user = self.create_regular_user()
        self.assertEqual(self.login().status_code, 200)
        disabled = self.client.patch(
            f"/api/admin/users/{user['id']}/status",
            json={"is_active": False},
        )
        self.assertEqual(disabled.status_code, 200)
        self.client.post("/api/logout")
        self.assertEqual(self.login("friend", "FriendPass123").status_code, 401)

    def test_only_developer_cannot_be_disabled(self):
        self.assertEqual(self.login().status_code, 200)
        admin_id = self.client.get("/api/me").json()["id"]
        response = self.client.patch(
            f"/api/admin/users/{admin_id}/status",
            json={"is_active": False},
        )
        self.assertEqual(response.status_code, 409)
        self.assertIn("唯一", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
