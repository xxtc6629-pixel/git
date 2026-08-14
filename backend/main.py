import logging
import os
import re
import secrets
import base64
import binascii
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, status
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from . import database
from .auth import require_developer, require_user, websocket_user
from .config import PROJECT_ROOT
from .database import (
    User,
    authenticate_user,
    create_user,
    ensure_initial_admin,
    initialize_database,
    get_game_history,
    get_game_moves,
    list_all_game_history,
    list_game_history_for_user,
    list_users,
    reset_user_password,
    set_user_active,
    update_user_profile,
)
from .room import room_manager
from .websocket import handle_room_socket


logger = logging.getLogger("gomoku.startup")
FRONTEND = PROJECT_ROOT / "frontend"
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
AVATAR_PATTERN = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,", re.IGNORECASE)
MAX_NICKNAME_LENGTH = 24
MAX_AVATAR_BYTES = 512 * 1024


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        initialize_database()
        admin = ensure_initial_admin()
        logger.info(
            "Database initialized successfully: path=%s, initial_developer=%s",
            database.DB_PATH,
            admin.username,
        )
    except Exception:
        logger.exception("Database/admin initialization failed: path=%s", database.DB_PATH)
        raise
    yield


app = FastAPI(title="双人五子棋", version="1.1.0", lifespan=lifespan)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET") or secrets.token_urlsafe(32),
    session_cookie="gomoku_session",
    max_age=60 * 60 * 24 * 7,
    same_site="lax",
    https_only=os.getenv("COOKIE_SECURE", "false").lower() == "true",
)


class LoginPayload(BaseModel):
    username: str
    password: str


class CreateUserPayload(BaseModel):
    username: str
    password: str


class PasswordPayload(BaseModel):
    password: str


class StatusPayload(BaseModel):
    is_active: bool


class ProfilePayload(BaseModel):
    nickname: str | None = None
    avatar: str | None = None


def public_user(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname,
        "avatar": user.avatar,
        "display_name": user.display_name,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": user.created_at,
    }


def public_history(record: dict, viewer: User | None = None) -> dict:
    result = {
        key: record.get(key)
        for key in (
            "game_id", "room_code", "black_username", "white_username",
            "winner_username", "winner_color", "result_reason", "started_at",
            "finished_at", "duration_seconds", "move_count",
        )
    }
    if viewer is not None and viewer.id in (record["black_user_id"], record["white_user_id"]):
        is_black = record["black_user_id"] == viewer.id
        result["my_color"] = "black" if is_black else "white"
        result["opponent_username"] = record["white_username"] if is_black else record["black_username"]
        if record["winner_user_id"] is None:
            result["outcome"] = "draw"
        else:
            result["outcome"] = "win" if record["winner_user_id"] == viewer.id else "loss"
    return result


def history_access_allowed(record: dict, user: User) -> bool:
    return user.role == "developer" or user.id in (record["black_user_id"], record["white_user_id"])


def history_detail(record: dict, viewer: User) -> dict:
    moves = get_game_moves(record["id"])
    board: list[list[str | None]] = [[None for _ in range(15)] for _ in range(15)]
    for move in moves:
        board[move["row"]][move["col"]] = move["color"]
    return {**public_history(record, viewer), "moves": moves, "final_board": board}


def validate_credentials(username: str, password: str) -> tuple[str, str]:
    username = username.strip()
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(status_code=400, detail="账号需为 3～32 位字母、数字、点、横线或下划线")
    if len(password.encode("utf-8")) < 8 or len(password.encode("utf-8")) > 72:
        raise HTTPException(status_code=400, detail="密码长度需为 8～72 个字节")
    return username, password


def normalize_nickname(value: str | None) -> str | None:
    if value is None:
        return None
    nickname = value.strip()
    if not nickname:
        return None
    if len(nickname) > MAX_NICKNAME_LENGTH:
        raise HTTPException(status_code=400, detail=f"昵称不能超过 {MAX_NICKNAME_LENGTH} 个字符")
    if any(ord(char) < 32 or ord(char) == 127 for char in nickname):
        raise HTTPException(status_code=400, detail="昵称不能包含控制字符")
    return nickname


def normalize_avatar(value: str | None) -> str | None:
    if value is None:
        return None
    avatar = value.strip()
    if not avatar:
        return None
    match = AVATAR_PATTERN.match(avatar)
    if match is None:
        raise HTTPException(status_code=400, detail="头像只支持 PNG、JPG、WebP 或 GIF 图片")
    encoded = avatar.split(",", 1)[1]
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="头像图片格式无效") from exc
    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=400, detail="头像图片不能超过 512KB")
    return avatar


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/login")
async def login(payload: LoginPayload, request: Request) -> dict:
    user = authenticate_user(payload.username.strip(), payload.password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="账号或密码错误")
    request.session.clear()
    request.session["user_id"] = user.id
    return public_user(user)


@app.post("/api/logout")
async def logout(request: Request) -> dict:
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
async def me(user: User = Depends(require_user)) -> dict:
    return public_user(user)


@app.get("/api/profile")
async def profile(user: User = Depends(require_user)) -> dict:
    return public_user(user)


@app.patch("/api/profile")
async def save_profile(payload: ProfilePayload, user: User = Depends(require_user)) -> dict:
    nickname = user.nickname if payload.nickname is None else normalize_nickname(payload.nickname)
    avatar = user.avatar if payload.avatar is None else normalize_avatar(payload.avatar)
    return public_user(update_user_profile(user.id, nickname, avatar))


@app.get("/api/admin/users")
async def admin_users(_: User = Depends(require_developer)) -> list[dict]:
    return [public_user(user) for user in list_users()]


@app.get("/api/history")
async def user_history(user: User = Depends(require_user)) -> list[dict]:
    return [public_history(record, user) for record in list_game_history_for_user(user.id)]


@app.get("/api/history/{game_id}")
async def user_history_detail(game_id: str, user: User = Depends(require_user)) -> dict:
    record = get_game_history(game_id)
    if record is None:
        raise HTTPException(status_code=404, detail="对局记录不存在")
    if not history_access_allowed(record, user):
        raise HTTPException(status_code=403, detail="无权查看这局对局")
    return history_detail(record, user)


@app.get("/api/admin/history")
async def admin_history(
    username: str | None = None,
    room_code: str | None = None,
    result_reason: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    developer: User = Depends(require_developer),
) -> list[dict]:
    if result_reason and result_reason not in {"five_in_a_row", "timeout", "draw", "resign"}:
        raise HTTPException(status_code=400, detail="结束原因无效")
    records = list_all_game_history(username, room_code, result_reason, date_from, date_to)
    return [public_history(record) for record in records]


@app.post("/api/admin/users", status_code=201)
async def admin_create_user(payload: CreateUserPayload, _: User = Depends(require_developer)) -> dict:
    username, password = validate_credentials(payload.username, payload.password)
    try:
        user = create_user(username, password, role="user")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return public_user(user)


@app.patch("/api/admin/users/{user_id}/password")
async def admin_reset_password(
    user_id: int,
    payload: PasswordPayload,
    _: User = Depends(require_developer),
) -> dict:
    _, password = validate_credentials("valid_user", payload.password)
    if not reset_user_password(user_id, password):
        raise HTTPException(status_code=404, detail="账号不存在")
    return {"ok": True}


@app.patch("/api/admin/users/{user_id}/status")
async def admin_set_status(
    user_id: int,
    payload: StatusPayload,
    _: User = Depends(require_developer),
) -> dict:
    try:
        return public_user(set_user_active(user_id, payload.is_active))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/rooms", status_code=201)
async def create_room(_: User = Depends(require_user)) -> dict:
    room = await room_manager.create()
    return {"room_id": room.room_id}


@app.get("/api/rooms/{room_id}")
async def get_room(room_id: str, _: User = Depends(require_user)) -> dict:
    room = room_manager.get(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="房间不存在")
    return {"room_id": room.room_id, "players": len(room.players), "full": len(room.players) >= 2}


@app.websocket("/ws/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str) -> None:
    user = websocket_user(websocket)
    if user is None:
        await websocket.close(code=4401, reason="请先登录")
        return
    room = room_manager.get(room_id)
    if room is None:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "房间不存在"})
        await websocket.close(code=1008)
        return
    await handle_room_socket(websocket, room, user)


@app.get("/admin", include_in_schema=False)
async def admin_page(request: Request):
    try:
        user = require_user(request)
    except HTTPException:
        return RedirectResponse("/", status_code=303)
    if user.role != "developer":
        raise HTTPException(status_code=403, detail="无权访问开发者管理")
    return FileResponse(FRONTEND / "index.html")


@app.get("/admin/history", include_in_schema=False)
async def admin_history_page(request: Request):
    try:
        user = require_user(request)
    except HTTPException:
        return RedirectResponse("/", status_code=303)
    if user.role != "developer":
        raise HTTPException(status_code=403, detail="无权访问全部对局记录")
    return FileResponse(FRONTEND / "index.html")


@app.get("/history", include_in_schema=False)
async def history_page(request: Request):
    try:
        require_user(request)
    except HTTPException:
        return RedirectResponse("/", status_code=303)
    return FileResponse(FRONTEND / "index.html")


@app.get("/history/{game_id}", include_in_schema=False)
async def history_detail_page(game_id: str, request: Request):
    try:
        user = require_user(request)
    except HTTPException:
        return RedirectResponse("/", status_code=303)
    record = get_game_history(game_id)
    if record is None:
        raise HTTPException(status_code=404, detail="对局记录不存在")
    if not history_access_allowed(record, user):
        raise HTTPException(status_code=403, detail="无权查看这局对局")
    return FileResponse(FRONTEND / "index.html")


@app.get("/profile", include_in_schema=False)
async def profile_page(request: Request):
    try:
        require_user(request)
    except HTTPException:
        return RedirectResponse("/", status_code=303)
    return FileResponse(FRONTEND / "index.html")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
