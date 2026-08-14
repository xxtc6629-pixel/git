import asyncio
import logging
import secrets
import string
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from fastapi import WebSocket

from .game import Color, GameError, GomokuGame


logger = logging.getLogger("gomoku.room")
HistoryWriter = Callable[[dict, list[dict]], tuple[int, bool]]


@dataclass
class Player:
    client_id: str
    username: str
    color: Color
    websocket: WebSocket | None = None
    user_id: int | None = None


@dataclass
class Room:
    room_id: str
    game: GomokuGame = field(default_factory=GomokuGame)
    players: dict[str, Player] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    rematch_requester: str | None = None
    round_number: int = 1
    turn_seconds: float = 60.0
    turn_deadline: float | None = None
    timeout_task: asyncio.Task | None = field(default=None, repr=False)
    history_writer: HistoryWriter | None = field(default=None, repr=False)
    game_id: str | None = None
    started_at: datetime | None = None
    moves: list[dict] = field(default_factory=list)
    history_persisted: bool = False

    async def connect(self, client_id: str, username: str, websocket: WebSocket) -> Color | None:
        async with self.lock:
            existing = self.players.get(client_id)
            if existing:
                existing.websocket = websocket
                return existing.color
            if len(self.players) >= 2:
                return None
            was_ready = self.ready
            used = {player.color for player in self.players.values()}
            color: Color = "black" if "black" not in used else "white"
            user_id = int(client_id) if client_id.isdigit() else None
            self.players[client_id] = Player(client_id, username, color, websocket, user_id)
            if self.ready and not was_ready:
                self._begin_game()
            if self.ready and not self.game.finished and self.turn_deadline is None:
                self.start_turn_timer()
            return color

    async def disconnect(self, client_id: str, websocket: WebSocket) -> None:
        async with self.lock:
            player = self.players.get(client_id)
            if player and player.websocket is websocket:
                player.websocket = None

    def color_of(self, client_id: str) -> Color | None:
        player = self.players.get(client_id)
        return player.color if player else None

    @property
    def ready(self) -> bool:
        return len(self.players) == 2

    def state(self) -> dict:
        return {
            "type": "state",
            "room_id": self.room_id,
            "ready": self.ready,
            "players": len(self.players),
            "round": self.round_number,
            "turn_deadline": self.turn_deadline,
            "server_time": time.time(),
            "player_names": {player.color: player.username for player in self.players.values()},
            **self.game.snapshot(),
        }

    def place_move(self, row: int, col: int, color: Color) -> bool:
        self._ensure_game_started()
        if self.turn_deadline is not None and time.time() >= self.turn_deadline:
            self.finish_timeout()
            return False

        self.game.place(row, col, color)
        player = self._player_for_color(color)
        self.moves.append({
            "move_number": len(self.moves) + 1,
            "user_id": player.user_id if player else None,
            "username": player.username if player else "",
            "color": color,
            "row": row,
            "col": col,
            "played_at": datetime.now(timezone.utc).isoformat(),
        })
        if self.game.finished:
            self.stop_turn_timer()
            self._persist_history_once()
        else:
            self.start_turn_timer()
        return True

    def start_turn_timer(self) -> None:
        self.stop_turn_timer()
        self.turn_deadline = time.time() + self.turn_seconds
        deadline = self.turn_deadline
        self.timeout_task = asyncio.create_task(self._wait_for_timeout(deadline))

    def stop_turn_timer(self) -> None:
        self.turn_deadline = None
        task = self.timeout_task
        self.timeout_task = None
        if task and task is not asyncio.current_task() and not task.done():
            task.cancel()

    def finish_timeout(self) -> None:
        if self.game.finished:
            return
        self._ensure_game_started()
        task = self.timeout_task
        self.timeout_task = None
        if task and task is not asyncio.current_task() and not task.done():
            task.cancel()
        timed_out_color = self.game.turn
        self.game.winner = "white" if timed_out_color == "black" else "black"
        self.game.result_reason = "timeout"
        self.turn_deadline = None
        self._persist_history_once()

    async def _wait_for_timeout(self, deadline: float) -> None:
        try:
            while True:
                await asyncio.sleep(max(0, deadline - time.time()))
                async with self.lock:
                    if self.game.finished or self.turn_deadline != deadline:
                        return
                    if time.time() < deadline:
                        continue
                    self.finish_timeout()
                    state = self.state()
                    break
            await self.broadcast(state)
        except asyncio.CancelledError:
            return

    def request_rematch(self, client_id: str) -> None:
        if not self.ready or not self.game.finished:
            raise GameError("当前不能发起再来一局")
        if client_id not in self.players:
            raise GameError("玩家身份无效")
        if self.rematch_requester is not None:
            raise GameError("已经有待处理的再来一局请求")
        self.rematch_requester = client_id

    def decline_rematch(self, client_id: str) -> str:
        requester = self._validate_rematch_responder(client_id)
        self.rematch_requester = None
        return requester

    def accept_rematch(self, client_id: str) -> str:
        requester = self._validate_rematch_responder(client_id)
        self._persist_history_once()
        for player in self.players.values():
            player.color = "white" if player.color == "black" else "black"
        self.game = GomokuGame()
        self.rematch_requester = None
        self.round_number += 1
        self._begin_game()
        self.start_turn_timer()
        return requester

    def _begin_game(self) -> None:
        self.game_id = uuid.uuid4().hex
        self.started_at = datetime.now(timezone.utc)
        self.moves = []
        self.history_persisted = False

    def _ensure_game_started(self) -> None:
        if self.game_id is None or self.started_at is None:
            self._begin_game()

    def _player_for_color(self, color: Color) -> Player | None:
        return next((player for player in self.players.values() if player.color == color), None)

    def _persist_history_once(self) -> None:
        if self.history_persisted or not self.game.finished or self.history_writer is None:
            return
        if not self.ready or self.game_id is None or self.started_at is None:
            logger.error("Cannot save completed game without two players/start metadata: room=%s", self.room_id)
            return

        black = self._player_for_color("black")
        white = self._player_for_color("white")
        winner = self._player_for_color(self.game.winner) if self.game.winner else None
        if black is None or white is None or black.user_id is None or white.user_id is None:
            logger.error("Cannot save completed game without authenticated player IDs: room=%s", self.room_id)
            return

        finished_at = datetime.now(timezone.utc)
        history = {
            "game_id": self.game_id,
            "room_code": self.room_id,
            "black_user_id": black.user_id,
            "black_username": black.username,
            "white_user_id": white.user_id,
            "white_username": white.username,
            "winner_user_id": winner.user_id if winner else None,
            "winner_username": winner.username if winner else None,
            "winner_color": self.game.winner,
            "result_reason": self.game.result_reason,
            "started_at": self.started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "duration_seconds": max(0, int((finished_at - self.started_at).total_seconds())),
            "created_at": finished_at.isoformat(),
        }
        try:
            _, _created = self.history_writer(history, list(self.moves))
            self.history_persisted = True
        except Exception:
            logger.exception(
                "Failed to save completed game history: room=%s game_id=%s",
                self.room_id,
                self.game_id,
            )

    def _validate_rematch_responder(self, client_id: str) -> str:
        if client_id not in self.players:
            raise GameError("玩家身份无效")
        if self.rematch_requester is None:
            raise GameError("没有待处理的再来一局请求")
        if self.rematch_requester == client_id:
            raise GameError("需要等待对方回应")
        return self.rematch_requester

    async def send_to(self, client_id: str, message: dict) -> None:
        player = self.players.get(client_id)
        if player and player.websocket:
            await player.websocket.send_json(message)

    async def send_to_other(self, client_id: str, message: dict) -> None:
        sockets = [
            player.websocket
            for player_id, player in self.players.items()
            if player_id != client_id and player.websocket
        ]
        if sockets:
            await asyncio.gather(
                *(socket.send_json(message) for socket in sockets),
                return_exceptions=True,
            )

    async def broadcast(self, message: dict) -> None:
        sockets = [p.websocket for p in self.players.values() if p.websocket]
        if sockets:
            await asyncio.gather(
                *(socket.send_json(message) for socket in sockets),
                return_exceptions=True,
            )


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.lock = asyncio.Lock()

    async def create(self) -> Room:
        from .database import save_game_history

        alphabet = string.ascii_uppercase + string.digits
        async with self.lock:
            while True:
                room_id = "".join(secrets.choice(alphabet) for _ in range(6))
                if room_id not in self.rooms:
                    room = Room(room_id, history_writer=save_game_history)
                    self.rooms[room_id] = room
                    return room

    def get(self, room_id: str) -> Room | None:
        return self.rooms.get(room_id.upper())


room_manager = RoomManager()
