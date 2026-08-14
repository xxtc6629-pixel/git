from fastapi import WebSocket, WebSocketDisconnect

from .game import GameError
from .room import Room


async def handle_room_socket(websocket: WebSocket, room: Room, client_id: str, username: str) -> None:
    await websocket.accept()
    color = await room.connect(client_id, username, websocket)
    if color is None:
        await websocket.send_json({"type": "error", "message": "房间已满"})
        await websocket.close(code=1008)
        return

    await websocket.send_json({"type": "welcome", "color": color})
    await room.broadcast(room.state())

    try:
        while True:
            data = await websocket.receive_json()
            message_type = data.get("type")

            if message_type == "move":
                try:
                    async with room.lock:
                        if not room.ready:
                            raise GameError("请等待另一名玩家加入")
                        player_color = room.color_of(client_id)
                        if player_color is None:
                            raise GameError("玩家身份无效")
                        try:
                            row = int(data.get("row"))
                            col = int(data.get("col"))
                        except (TypeError, ValueError):
                            raise GameError("坐标无效")
                        room.place_move(row, col, player_color)
                    await room.broadcast(room.state())
                except GameError as exc:
                    await websocket.send_json({"type": "error", "message": str(exc)})

            elif message_type == "chat":
                text = str(data.get("message", "")).strip()
                if text:
                    await room.broadcast({
                        "type": "chat",
                        "color": room.color_of(client_id),
                        "username": username,
                        "message": text[:200],
                    })
            elif message_type == "rematch_request":
                try:
                    async with room.lock:
                        room.request_rematch(client_id)
                    await websocket.send_json({"type": "rematch_pending"})
                    await room.send_to_other(client_id, {"type": "rematch_request"})
                except GameError as exc:
                    await websocket.send_json({"type": "error", "message": str(exc)})
            elif message_type == "rematch_decline":
                try:
                    async with room.lock:
                        requester = room.decline_rematch(client_id)
                    await room.send_to(requester, {"type": "rematch_declined"})
                    await websocket.send_json({"type": "rematch_declined_ack"})
                except GameError as exc:
                    await websocket.send_json({"type": "error", "message": str(exc)})
            elif message_type == "rematch_accept":
                try:
                    async with room.lock:
                        room.accept_rematch(client_id)
                        restarted_players = [
                            (player.websocket, player.color)
                            for player in room.players.values()
                            if player.websocket
                        ]
                    for player_socket, player_color in restarted_players:
                        await player_socket.send_json({
                            "type": "game_restart",
                            "color": player_color,
                        })
                    await room.broadcast(room.state())
                except GameError as exc:
                    await websocket.send_json({"type": "error", "message": str(exc)})
            else:
                await websocket.send_json({"type": "error", "message": "未知操作"})

    except WebSocketDisconnect:
        await room.disconnect(client_id, websocket)
        await room.broadcast(room.state())
