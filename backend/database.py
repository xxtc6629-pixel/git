import os
import logging
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import bcrypt

from .config import PROJECT_ROOT


logger = logging.getLogger("gomoku.database")


def _configured_database_path() -> Path:
    configured = Path(os.getenv("DATABASE_PATH", "data/gomoku.db"))
    if configured.is_absolute():
        return configured
    return PROJECT_ROOT / configured


DB_PATH = _configured_database_path()


@dataclass(frozen=True)
class User:
    id: int
    username: str
    role: str
    is_active: bool
    created_at: str
    nickname: str | None = None
    avatar: str | None = None

    @property
    def display_name(self) -> str:
        return self.nickname or self.username


@contextmanager
def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database() -> None:
    with _connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('developer', 'user')),
                is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                created_at TEXT NOT NULL
            )
            """
        )
        user_columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
        if "nickname" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN nickname TEXT")
        if "avatar" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN avatar TEXT")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS game_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id TEXT NOT NULL UNIQUE,
                room_code TEXT NOT NULL,
                black_user_id INTEGER NOT NULL REFERENCES users(id),
                black_username TEXT NOT NULL,
                white_user_id INTEGER NOT NULL REFERENCES users(id),
                white_username TEXT NOT NULL,
                winner_user_id INTEGER REFERENCES users(id),
                winner_username TEXT,
                winner_color TEXT CHECK (winner_color IN ('black', 'white') OR winner_color IS NULL),
                result_reason TEXT NOT NULL CHECK (result_reason IN ('five_in_a_row', 'timeout', 'draw', 'resign')),
                started_at TEXT NOT NULL,
                finished_at TEXT NOT NULL,
                duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
                move_count INTEGER NOT NULL CHECK (move_count >= 0),
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS game_moves (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_history_id INTEGER NOT NULL REFERENCES game_history(id) ON DELETE CASCADE,
                move_number INTEGER NOT NULL CHECK (move_number > 0),
                user_id INTEGER NOT NULL REFERENCES users(id),
                username TEXT NOT NULL,
                color TEXT NOT NULL CHECK (color IN ('black', 'white')),
                row INTEGER NOT NULL CHECK (row BETWEEN 0 AND 14),
                col INTEGER NOT NULL CHECK (col BETWEEN 0 AND 14),
                played_at TEXT NOT NULL,
                UNIQUE (game_history_id, move_number)
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_game_history_black_user ON game_history(black_user_id, finished_at DESC)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_game_history_white_user ON game_history(white_user_id, finished_at DESC)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_game_history_finished ON game_history(finished_at DESC)"
        )
        connection.execute("PRAGMA optimize")


def ensure_initial_admin() -> User:
    username = os.getenv("ADMIN_USERNAME")
    password = os.getenv("ADMIN_INITIAL_PASSWORD")
    if not username:
        raise RuntimeError("缺少 ADMIN_USERNAME，无法初始化开发者账号")
    if not password:
        raise RuntimeError("缺少 ADMIN_INITIAL_PASSWORD，无法初始化开发者账号")

    existing = get_user_by_username(username)
    if existing is not None:
        logger.info("Initial developer already exists; password was not changed: %s", username)
        return existing

    user = create_user(username, password, role="developer")
    logger.info("Created initial developer account: %s", username)
    return user


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def _user_from_row(row: sqlite3.Row | None) -> User | None:
    if row is None:
        return None
    keys = set(row.keys())
    return User(
        id=row["id"],
        username=row["username"],
        role=row["role"],
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        nickname=row["nickname"] if "nickname" in keys else None,
        avatar=row["avatar"] if "avatar" in keys else None,
    )


def get_user_by_id(user_id: int) -> User | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, username, nickname, avatar, role, is_active, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return _user_from_row(row)


def get_user_by_username(username: str) -> User | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, username, nickname, avatar, role, is_active, created_at FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    return _user_from_row(row)


def authenticate_user(username: str, password: str) -> User | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, username, nickname, avatar, password_hash, role, is_active, created_at FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    if row is None or not bool(row["is_active"]):
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    return _user_from_row(row)


def create_user(username: str, password: str, role: str = "user") -> User:
    created_at = datetime.now(timezone.utc).isoformat()
    try:
        with _connect() as connection:
            cursor = connection.execute(
                "INSERT INTO users (username, password_hash, role, is_active, created_at) VALUES (?, ?, ?, 1, ?)",
                (username, hash_password(password), role, created_at),
            )
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError as exc:
        raise ValueError("账号已存在") from exc
    user = get_user_by_id(user_id)
    if user is None:
        raise RuntimeError("创建账号失败")
    return user


def list_users() -> list[User]:
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, username, nickname, avatar, role, is_active, created_at FROM users ORDER BY created_at, id"
        ).fetchall()
    return [_user_from_row(row) for row in rows]


def update_user_profile(user_id: int, nickname: str | None, avatar: str | None) -> User:
    with _connect() as connection:
        cursor = connection.execute(
            "UPDATE users SET nickname = ?, avatar = ? WHERE id = ?",
            (nickname, avatar, user_id),
        )
    if cursor.rowcount != 1:
        raise LookupError("账号不存在")
    updated = get_user_by_id(user_id)
    if updated is None:
        raise LookupError("账号不存在")
    return updated


def reset_user_password(user_id: int, password: str) -> bool:
    with _connect() as connection:
        cursor = connection.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(password), user_id),
        )
    return cursor.rowcount == 1


def set_user_active(user_id: int, is_active: bool) -> User:
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, username, nickname, avatar, role, is_active, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        user = _user_from_row(row)
        if user is None:
            raise LookupError("账号不存在")
        if user.role == "developer" and user.is_active and not is_active:
            active_developers = connection.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'developer' AND is_active = 1"
            ).fetchone()[0]
            if active_developers <= 1:
                raise ValueError("不能停用唯一的开发者账号")
        connection.execute(
            "UPDATE users SET is_active = ? WHERE id = ?",
            (1 if is_active else 0, user_id),
        )
    updated = get_user_by_id(user_id)
    if updated is None:
        raise LookupError("账号不存在")
    return updated


def save_game_history(history: dict, moves: list[dict]) -> tuple[int, bool]:
    """Persist a completed game and all its moves in one transaction.

    Returns ``(history_id, created)``. A repeated game_id returns the existing
    row without inserting duplicate moves.
    """
    with _connect() as connection:
        existing = connection.execute(
            "SELECT id FROM game_history WHERE game_id = ?",
            (history["game_id"],),
        ).fetchone()
        if existing is not None:
            return int(existing["id"]), False

        cursor = connection.execute(
            """
            INSERT INTO game_history (
                game_id, room_code,
                black_user_id, black_username,
                white_user_id, white_username,
                winner_user_id, winner_username, winner_color,
                result_reason, started_at, finished_at,
                duration_seconds, move_count, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                history["game_id"],
                history["room_code"],
                history["black_user_id"],
                history["black_username"],
                history["white_user_id"],
                history["white_username"],
                history.get("winner_user_id"),
                history.get("winner_username"),
                history.get("winner_color"),
                history["result_reason"],
                history["started_at"],
                history["finished_at"],
                history["duration_seconds"],
                len(moves),
                history["created_at"],
            ),
        )
        history_id = int(cursor.lastrowid)
        connection.executemany(
            """
            INSERT INTO game_moves (
                game_history_id, move_number, user_id, username,
                color, row, col, played_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    history_id,
                    move["move_number"],
                    move["user_id"],
                    move["username"],
                    move["color"],
                    move["row"],
                    move["col"],
                    move["played_at"],
                )
                for move in moves
            ],
        )
    return history_id, True


def list_game_history_for_user(user_id: int) -> list[dict]:
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT * FROM game_history
            WHERE black_user_id = ? OR white_user_id = ?
            ORDER BY finished_at DESC, id DESC
            """,
            (user_id, user_id),
        ).fetchall()
    return [dict(row) for row in rows]


def list_all_game_history(
    username: str | None = None,
    room_code: str | None = None,
    result_reason: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[dict]:
    conditions: list[str] = []
    parameters: list[str] = []
    if username:
        conditions.append("(black_username LIKE ? OR white_username LIKE ?)")
        term = f"%{username}%"
        parameters.extend((term, term))
    if room_code:
        conditions.append("room_code = ?")
        parameters.append(room_code.upper())
    if result_reason:
        conditions.append("result_reason = ?")
        parameters.append(result_reason)
    if date_from:
        conditions.append("substr(finished_at, 1, 10) >= ?")
        parameters.append(date_from)
    if date_to:
        conditions.append("substr(finished_at, 1, 10) <= ?")
        parameters.append(date_to)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    with _connect() as connection:
        rows = connection.execute(
            f"SELECT * FROM game_history {where} ORDER BY finished_at DESC, id DESC",
            parameters,
        ).fetchall()
    return [dict(row) for row in rows]


def get_game_history(game_id: str) -> dict | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT * FROM game_history WHERE game_id = ?",
            (game_id,),
        ).fetchone()
    return dict(row) if row is not None else None


def get_game_moves(history_id: int) -> list[dict]:
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT move_number, user_id, username, color, row, col, played_at
            FROM game_moves
            WHERE game_history_id = ?
            ORDER BY move_number
            """,
            (history_id,),
        ).fetchall()
    return [dict(row) for row in rows]
