#!/usr/bin/env python3
"""Check frame consistency and JSON-RPC batch response ordering without a node."""
import struct
import unittest

from live import LiveGame


class LiveReadTests(unittest.TestCase):
    def game(self):
        game = LiveGame.__new__(LiveGame)
        game.address = '0x' + '00' * 32
        game.last_ms = 1.0
        return game

    @staticmethod
    def reply(index, value):
        return {'id': index, 'result': {'blockHeight': 9,
            'item': {'kind': 'bytestring', 'bytes': '0x' + value.hex()}}}

    def test_out_of_order_batch(self):
        game = self.game()
        game.rpc_request = lambda request: [self.reply(2, b'last'),
            self.reply(0, b'meta'), self.reply(1, b'first')]
        self.assertEqual(game.storage_batch([(0, 0), (3, 0), (3, 1)]),
                         [(9, b'meta'), (9, b'first'), (9, b'last')])

    def test_duplicate_response_ids(self):
        game = self.game()
        game.rpc_request = lambda request: [self.reply(0, b'a'),
            self.reply(0, b'b'), self.reply(2, b'c')]
        with self.assertRaisesRegex(RuntimeError, 'response IDs'):
            game.storage_batch([(0, 0), (3, 0), (3, 1)])

    def test_frame_retries_mixed_heights_and_old_ticks(self):
        game = self.game()
        attempts = []

        def batch(keys):
            attempts.append(keys)
            tick = 6 if len(attempts) == 2 else 7
            meta = struct.pack('<IIII', 2, tick, 64000, 4196020) + bytes(64)
            return [(9, meta), (8 if len(attempts) == 1 else 9, bytes(32768)),
                    (9, bytes(32000))]

        game.storage_batch = batch
        frame = game.frame(7)
        self.assertEqual(len(attempts), 3)
        self.assertEqual(len(frame), 64804)
        self.assertEqual(struct.unpack_from('<I', frame)[0], 7)


if __name__ == '__main__':
    unittest.main()
