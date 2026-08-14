from dataclasses import dataclass, field
from typing import Literal


Color = Literal["black", "white"]


class GameError(ValueError):
    pass


@dataclass
class GomokuGame:
    size: int = 15
    board: list[list[Color | None]] = field(init=False)
    turn: Color = "black"
    winner: Color | None = None
    draw: bool = False
    result_reason: Literal["five_in_a_row", "timeout", "draw"] | None = None

    def __post_init__(self) -> None:
        self.board = [[None for _ in range(self.size)] for _ in range(self.size)]

    @property
    def finished(self) -> bool:
        return self.winner is not None or self.draw

    def place(self, row: int, col: int, color: Color) -> None:
        if self.finished:
            raise GameError("游戏已经结束")
        if color != self.turn:
            raise GameError("还没有轮到你")
        if not (0 <= row < self.size and 0 <= col < self.size):
            raise GameError("落子位置超出棋盘")
        if self.board[row][col] is not None:
            raise GameError("这个位置已经有棋子了")

        self.board[row][col] = color
        if self._has_five(row, col, color):
            self.winner = color
            self.result_reason = "five_in_a_row"
        elif all(cell is not None for line in self.board for cell in line):
            self.draw = True
            self.result_reason = "draw"
        else:
            self.turn = "white" if color == "black" else "black"

    def _has_five(self, row: int, col: int, color: Color) -> bool:
        for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
            count = 1
            count += self._count(row, col, dr, dc, color)
            count += self._count(row, col, -dr, -dc, color)
            if count >= 5:
                return True
        return False

    def _count(self, row: int, col: int, dr: int, dc: int, color: Color) -> int:
        total = 0
        row += dr
        col += dc
        while 0 <= row < self.size and 0 <= col < self.size:
            if self.board[row][col] != color:
                break
            total += 1
            row += dr
            col += dc
        return total

    def snapshot(self) -> dict:
        return {
            "board": self.board,
            "turn": self.turn,
            "winner": self.winner,
            "draw": self.draw,
            "result_reason": self.result_reason,
        }
