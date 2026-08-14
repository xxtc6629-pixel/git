from fastapi import Depends, HTTPException, Request, WebSocket, status

from .database import User, get_user_by_id


def current_user_from_session(session: dict) -> User | None:
    user_id = session.get("user_id")
    if not isinstance(user_id, int):
        return None
    user = get_user_by_id(user_id)
    return user if user and user.is_active else None


def require_user(request: Request) -> User:
    user = current_user_from_session(request.session)
    if user is None:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
    return user


def require_developer(user: User = Depends(require_user)) -> User:
    if user.role != "developer":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权访问开发者管理")
    return user


def websocket_user(websocket: WebSocket) -> User | None:
    return current_user_from_session(websocket.session)
