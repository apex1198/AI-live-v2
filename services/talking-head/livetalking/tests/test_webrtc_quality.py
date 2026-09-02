import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from aiortc.codecs import h264 as h264_codec

from server.rtc_manager import configure_h264_bitrate
from server.webrtc import HumanPlayer


class WebRtcQualityTestCase(unittest.TestCase):
    def setUp(self):
        self.original_default = h264_codec.DEFAULT_BITRATE
        self.original_max = h264_codec.MAX_BITRATE

    def tearDown(self):
        h264_codec.DEFAULT_BITRATE = self.original_default
        h264_codec.MAX_BITRATE = self.original_max

    def test_hd_is_the_default_output_bitrate(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('LIVETALKING_VIDEO_QUALITY', None)
            os.environ.pop('LIVETALKING_WEBRTC_BITRATE', None)
            os.environ.pop('LIVETALKING_WEBRTC_MAX_BITRATE', None)
            target, maximum = configure_h264_bitrate()

        self.assertEqual((target, maximum), (4_000_000, 6_000_000))
        self.assertEqual(h264_codec.DEFAULT_BITRATE, 4_000_000)
        self.assertEqual(h264_codec.MAX_BITRATE, 6_000_000)

    def test_fhd_uses_six_megabits_with_an_eight_megabit_ceiling(self):
        with patch.dict(os.environ, {'LIVETALKING_VIDEO_QUALITY': 'fhd'}, clear=False):
            os.environ.pop('LIVETALKING_WEBRTC_BITRATE', None)
            os.environ.pop('LIVETALKING_WEBRTC_MAX_BITRATE', None)
            target, maximum = configure_h264_bitrate()

        self.assertEqual((target, maximum), (6_000_000, 8_000_000))

    def test_maximum_cannot_be_lower_than_target(self):
        with patch.dict(os.environ, {
            'LIVETALKING_WEBRTC_BITRATE': '7000000',
            'LIVETALKING_WEBRTC_MAX_BITRATE': '3000000',
        }):
            target, maximum = configure_h264_bitrate()

        self.assertEqual((target, maximum), (7_000_000, 7_000_000))

    @staticmethod
    def make_avatar(model_fps=25, output_fps=30):
        return SimpleNamespace(
            opt=SimpleNamespace(fps=model_fps, output_fps=output_fps),
            batch_size=4,
            dropped_video_frames=0,
            repeated_video_frames=0,
        )

    def test_hd_caps_existing_fhd_avatar_output_at_1280_by_720(self):
        env = {
            'LIVETALKING_VIDEO_QUALITY': 'hd',
            'LIVETALKING_MAX_WIDTH': '1280',
            'LIVETALKING_MAX_HEIGHT': '720',
        }
        with patch.dict(os.environ, env, clear=False):
            player = HumanPlayer(self.make_avatar())
            player.push_video(np.zeros((1080, 1920, 3), dtype=np.uint8))

        frame, _ = player.video._queue.get_nowait()
        self.assertEqual((frame.width, frame.height), (1280, 720))

    def test_repeated_output_frames_resize_the_model_frame_only_once(self):
        env = {
            'LIVETALKING_VIDEO_QUALITY': 'hd',
            'LIVETALKING_MAX_WIDTH': '1280',
            'LIVETALKING_MAX_HEIGHT': '720',
        }
        avatar = self.make_avatar(model_fps=15, output_fps=30)
        original_resize = __import__('cv2').resize
        with patch.dict(os.environ, env, clear=False), patch(
            'server.webrtc.cv2.resize', wraps=original_resize
        ) as resize:
            player = HumanPlayer(avatar)
            player.push_video(np.zeros((1080, 1920, 3), dtype=np.uint8))

        self.assertEqual(player.video._queue.qsize(), 2)
        self.assertEqual(resize.call_count, 1)
        while not player.video._queue.empty():
            frame, _ = player.video._queue.get_nowait()
            self.assertEqual((frame.width, frame.height), (1280, 720))


if __name__ == '__main__':
    unittest.main()
