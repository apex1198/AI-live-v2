import os
import base64
import time
import threading
import numpy as np
import resampy

from utils.logger import logger
from .base_tts import BaseTTS, State
from registry import register

try:
    import dashscope
    from dashscope.audio.qwen_tts_realtime import (
        QwenTtsRealtime,
        QwenTtsRealtimeCallback,
        AudioFormat,
    )
except ImportError:
    dashscope = None
    QwenTtsRealtime = None
    QwenTtsRealtimeCallback = object
    AudioFormat = None
    logger.warning(
        "DashScope SDK is unavailable; QwenTTS will use local-audio mode "
        "and accept audio uploaded by the runtime"
    )


SRC_SR = 24000   # Qwen TTS 只支持 24kHz 输出
DST_SR = 16000   # 项目标准采样率


@register("tts", "qwentts")
class QwenTTS(BaseTTS):
    """
    阿里云通义千问实时语音合成 (Qwen TTS Realtime)
    基于 DashScope Python SDK (dashscope >= 1.25.11)
    使用 commit 模式：只建立一次 WebSocket 连接，每次合成通过 append_text + commit 触发。

    需要设置环境变量 DASHSCOPE_API_KEY。
    用法:
        python app.py --tts qwentts --REF_FILE Cherry
    其中 REF_FILE 用作音色名称 (voice)，如 Cherry / Ethan 等系统音色。
    """

    def __init__(self, opt, parent):
        super().__init__(opt, parent)

        # 音色名, 复用 REF_FILE 参数
        self.voice = opt.REF_FILE if opt.REF_FILE else 'Cherry'
        # 模型名
        self.model = getattr(opt, 'qwen_tts_model', 'qwen3-tts-flash-realtime')
        # WebSocket URL
        self.ws_url = getattr(opt, 'qwen_tts_url',
                              'wss://dashscope.aliyuncs.com/api-ws/v1/realtime')

        # The runtime synthesizes speech with the local Qwen TTS service and
        # uploads the resulting WAV to /humanaudio. LiveTalking still creates
        # an avatar TTS object for compatibility, but must not open a cloud
        # WebSocket when no DashScope key is configured.
        api_key = getattr(opt, 'dashscope_api_key', None) or os.environ.get('DASHSCOPE_API_KEY')
        self._cloud_enabled = bool(api_key and dashscope and QwenTtsRealtime and AudioFormat)
        if self._cloud_enabled:
            dashscope.api_key = api_key

        # ---------- 内部状态 ----------
        self._remainder = np.array([], dtype=np.float32)  # 上次重采样后不足一 chunk 的 16kHz 样本
        self._response_event = threading.Event()
        self._first_chunk = True          # 当前合成的一句话里的第一个音频包
        self._current_text = ''
        self._current_textevent = {}

        self._tts_client = None
        self._callback = None
        if not self._cloud_enabled:
            logger.info(
                "QwenTTS initialized in local-audio mode; "
                "LiveTalking will receive PCM/WAV from the runtime Qwen service"
            )
            return

        # ---------- 回调类 ----------
        tts_ref = self

        class _Callback(QwenTtsRealtimeCallback):
            def on_open(self) -> None:
                logger.info("QwenTTS WebSocket 连接已建立")

            def on_close(self, close_status_code, close_msg) -> None:
                logger.info(f"QwenTTS WebSocket 关闭: code={close_status_code}, msg={close_msg}")
                tts_ref._response_event.set()

            def on_event(self, response: dict) -> None:
                try:
                    event_type = response.get('type', '')

                    if event_type == 'session.created':
                        logger.info(f"QwenTTS session: {response.get('session', {}).get('id', '')}")

                    elif event_type == 'response.audio.delta':
                        audio_b64 = response.get('delta', '')
                        if audio_b64:
                            pcm_data = base64.b64decode(audio_b64)
                            tts_ref._on_audio_data(pcm_data)

                    elif event_type == 'response.done':
                        logger.info("QwenTTS response done")
                        tts_ref._flush_remainder()
                        tts_ref._response_event.set()

                    elif event_type == 'error':
                        logger.error(f"QwenTTS 错误: {response}")
                        tts_ref._response_event.set()

                except Exception as e:
                    logger.exception(f"QwenTTS 回调处理异常: {e}")

        # ---------- 建立唯一连接 ----------
        self._callback = _Callback()
        self._tts_client = QwenTtsRealtime(
            model=self.model,
            callback=self._callback,
            url=self.ws_url,
        )
        self._tts_client.connect()
        self._tts_client.update_session(
            voice=self.voice,
            response_format=AudioFormat.PCM_24000HZ_MONO_16BIT,  # Qwen TTS 只支持 24kHz 输出
            sample_rate=16000,
            mode='commit',
        )
        logger.info(f"QwenTTS 初始化完成: model={self.model}, voice={self.voice}")

    # ========================== 核心方法 ==========================

    def txt_to_audio(self, msg: tuple[str, dict]):
        text, textevent = msg
        if not self._cloud_enabled or self._tts_client is None:
            # Speech is synthesized by services/qwen-tts and delivered through
            # BaseAvatar.put_audio_file; this compatibility path is intentional.
            logger.debug("QwenTTS local-audio mode ignored text request: %s", text[:80])
            return
        t_start = time.perf_counter()

        ref_file = textevent.get('tts', {}).get('ref_file',self.voice)

        # 重置状态
        self._remainder = np.array([], dtype=np.float32)
        self._first_chunk = True
        self._current_text = text
        self._current_textevent = textevent
        self._response_event.clear()

        try:
            #logger.info(f"QwenTTS 发送文本: {text[:80]}...")
            if ref_file != self.voice:
                logger.info(f'ref_file:{ref_file},self.voice:{self.voice}')
                self.voice=ref_file
                self._tts_client.close()
                self._tts_client.connect()
                self._tts_client.update_session(
                    voice=self.voice,
                    response_format=AudioFormat.PCM_24000HZ_MONO_16BIT,  # Qwen TTS 只支持 24kHz 输出
                    sample_rate=16000,
                    mode='commit',
                )
            self._tts_client.append_text(text)
            self._tts_client.commit()

            # 等待 response.done（音频在回调中流式处理）
            self._response_event.wait(timeout=60)

            t_end = time.perf_counter()
            logger.info(f"QwenTTS 合成完成，耗时: {t_end - t_start:.2f}s")

        except Exception as e:
            logger.exception(f"QwenTTS txt_to_audio 异常: {e}")

    # ========================== 流式音频处理（回调中调用）==========================

    def _on_audio_data(self, pcm_data: bytes):
        """收到 PCM 24kHz 16bit mono 音频，一次性 resample 到 16kHz 后分块推送"""
        if self.state != State.RUNNING:
            self._remainder = np.array([], dtype=np.float32)
            return

        # Convert the cloud stream from Qwen's 24 kHz PCM to the project's
        # fixed 16 kHz / 20 ms audio clock before feeding the avatar.
        samples_24k = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0
        samples_16k = resampy.resample(x=samples_24k, sr_orig=SRC_SR, sr_new=DST_SR)

        # 拼接上次剩余
        if self._remainder.shape[0] > 0:
            samples_16k = np.concatenate([self._remainder, samples_16k])

        # 按 self.chunk (320 samples = 20ms @16kHz) 分块推送
        idx = 0
        total = samples_16k.shape[0]
        while total - idx >= self.chunk and self.state == State.RUNNING:
            frame = samples_16k[idx:idx + self.chunk]
            eventpoint = {}
            if self._first_chunk:
                eventpoint = {'status': 'start', 'text': self._current_text}
                self._first_chunk = False
            eventpoint.update(**self._current_textevent)
            self.parent.put_audio_frame(frame, eventpoint)
            idx += self.chunk

        # 不足一 chunk 的留到下次
        self._remainder = samples_16k[idx:] if idx < total else np.array([], dtype=np.float32)

    def _flush_remainder(self):
        """合成完毕，推送剩余样本并发送 end 事件"""
        if self.state != State.RUNNING:
            self._remainder = np.array([], dtype=np.float32)
            return

        # 推送剩余完整 chunk
        if self._remainder.shape[0] >= self.chunk:
            idx = 0
            total = self._remainder.shape[0]
            while total - idx >= self.chunk and self.state == State.RUNNING:
                frame = self._remainder[idx:idx + self.chunk]
                eventpoint = {}
                if self._first_chunk:
                    eventpoint = {'status': 'start', 'text': self._current_text}
                    self._first_chunk = False
                eventpoint.update(**self._current_textevent)
                self.parent.put_audio_frame(frame, eventpoint)
                idx += self.chunk

        self._remainder = np.array([], dtype=np.float32)

        # 发送 end 事件
        eventpoint = {'status': 'end', 'text': self._current_text}
        eventpoint.update(**self._current_textevent)
        self.parent.put_audio_frame(np.zeros(self.chunk, np.float32), eventpoint)

    def stop_tts(self):
        if self._tts_client is not None:
            self._tts_client.close()
            logger.info("QwenTTS 已关闭")
