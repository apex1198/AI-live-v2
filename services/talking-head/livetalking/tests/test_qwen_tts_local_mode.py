import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tts import qwentts


class QwenTtsLocalModeTestCase(unittest.TestCase):
    def test_missing_dashscope_key_does_not_open_cloud_client(self):
        options = SimpleNamespace(
            REF_FILE='',
            qwen_tts_model='qwen3-tts-flash-realtime',
            qwen_tts_url='wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
        )
        parent = SimpleNamespace()
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('DASHSCOPE_API_KEY', None)
            with patch.object(qwentts, 'QwenTtsRealtime', None), patch.object(qwentts, 'AudioFormat', None):
                tts = qwentts.QwenTTS(options, parent)

        self.assertFalse(tts._cloud_enabled)
        self.assertIsNone(tts._tts_client)
        tts.txt_to_audio(('local runtime audio', {}))
        tts.stop_tts()


if __name__ == '__main__':
    unittest.main()
