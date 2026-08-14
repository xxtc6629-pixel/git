import unittest

from backend.game import GameError, GomokuGame


def play(game, moves):
    for row, col, color in moves:
        game.place(row, col, color)


class GomokuGameTests(unittest.TestCase):
    def test_win_in_all_directions(self):
        directions = [
            [(7, i) for i in range(5)],
            [(i, 7) for i in range(5)],
            [(i, i) for i in range(5)],
            [(i, 8 - i) for i in range(5)],
        ]
        for black_moves in directions:
            with self.subTest(black_moves=black_moves):
                game = GomokuGame()
                white_moves = [(14, i) for i in range(4)]
                moves = []
                for index, move in enumerate(black_moves):
                    moves.append((*move, "black"))
                    if index < 4:
                        moves.append((*white_moves[index], "white"))
                play(game, moves)
                self.assertEqual(game.winner, "black")
                self.assertEqual(game.result_reason, "five_in_a_row")

    def test_rejects_occupied_and_wrong_turn(self):
        game = GomokuGame()
        game.place(0, 0, "black")
        with self.assertRaises(GameError):
            game.place(0, 1, "black")
        with self.assertRaises(GameError):
            game.place(0, 0, "white")


if __name__ == "__main__":
    unittest.main()
