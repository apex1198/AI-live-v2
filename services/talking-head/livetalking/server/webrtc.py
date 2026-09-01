###############################################################################
#  Copyright (C) 2024 LiveTalking@lipku https://github.com/lipku/LiveTalking
#  email: lipku@foxmail.com
# 
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#  You may obtain a copy of the License at
#  
#       http://www.apache.org/licenses/LICENSE-2.0
# 
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.
###############################################################################

import asyncio
import math
import json
import logging
import os
import threading
import time
from typing import Tuple, Dict, Optional, Set, Union
import queue
from av.frame import Frame
from av.packet import Packet
from av import AudioFrame
import fractions
import cv2
import numpy as np

AUDIO_PTIME = 0.020  # fallback for workers that do not expose frame duration
VIDEO_CLOCK_RATE = 90000
VIDEO_PTIME = 1.0 / 30.0  # 30 FPS fallback
VIDEO_TIME_BASE = fractions.Fraction(1, VIDEO_CLOCK_RATE)
SAMPLE_RATE = 16000
AUDIO_TIME_BASE = fractions.Fraction(1, SAMPLE_RATE)

#from aiortc.contrib.media import MediaPlayer, MediaRelay
#from aiortc.rtcrtpsender import RTCRtpSender
from aiortc import (
    MediaStreamTrack,
)

logging.basicConfig()
logger = logging.getLogger(__name__)
from utils.logger import logger as mylogger


class PlayerStreamTrack(MediaStreamTrack):
    """
    A video track that returns an animated flag.
    """

    def __init__(self, player, kind, max_queue_size=100):
        super().__init__()  # don't forget this!
        self.kind = kind
        self._player = player
        self._queue = queue.Queue(maxsize=max_queue_size)
        self._last_video_frame = None
        self.timelist = [] #记录最近包的时间戳
        self.current_frame_count = 0
        if self.kind == 'video':
            self.framecount = 0
            self.lasttime = time.perf_counter()
            self.totaltime = 0
    
    _start: float
    _timestamp: int

    async def next_timestamp(self, frame_samples: Optional[int] = None) -> Tuple[int, fractions.Fraction]:
        if self.readyState != "live":
            raise Exception

        if self.kind == 'video':
            video_ptime = getattr(self._player, 'video_ptime', VIDEO_PTIME)
            if hasattr(self, "_timestamp"):
                self._timestamp += int(video_ptime * VIDEO_CLOCK_RATE)
                self.current_frame_count += 1
                now = time.monotonic()
                wait = self._start + self.current_frame_count * video_ptime - now
                if wait < -video_ptime:
                    # Inference can briefly starve the track. Rebase instead of
                    # emitting buffered frames in a visible catch-up burst.
                    self._start = now - self.current_frame_count * video_ptime
                    wait = 0
                if wait>0:
                    await asyncio.sleep(wait)
            else:
                self._start = time.monotonic()
                self._timestamp = 0
                self.timelist.append(self._start)
                mylogger.info('video start:%f',self._start)
            return self._timestamp, VIDEO_TIME_BASE
        else: #audio
            samples = max(1, int(frame_samples or AUDIO_PTIME * SAMPLE_RATE))
            if hasattr(self, "_timestamp"):
                self._timestamp += getattr(self, '_last_audio_samples', samples)
                now = time.monotonic()
                wait = self._start + self._timestamp / SAMPLE_RATE - now
                audio_ptime = samples / SAMPLE_RATE
                if wait < -(audio_ptime * 2):
                    self._start = now - self._timestamp / SAMPLE_RATE
                    wait = 0
                if wait>0:
                    await asyncio.sleep(wait)
            else:
                self._start = time.monotonic()
                self._timestamp = 0
                self.timelist.append(self._start)
                mylogger.info('audio start:%f',self._start)
            self._last_audio_samples = samples
            return self._timestamp, AUDIO_TIME_BASE

    async def recv(self) -> Union[Frame, Packet]:
        # frame = self.frames[self.counter % 30]            
        self._player._start(self)
        wait_for_prebuffer = getattr(self._player, 'wait_for_prebuffer', None)
        if callable(wait_for_prebuffer):
            await wait_for_prebuffer()
        # if self.kind == 'video':
        #     frame = await self._queue.get()
        # else: #audio
        #     if hasattr(self, "_timestamp"):
        #         wait = self._start + self._timestamp / SAMPLE_RATE + AUDIO_PTIME - time.time()
        #         if wait>0:
        #             await asyncio.sleep(wait)
        #         if self._queue.qsize()<1:
        #             #frame = AudioFrame(format='s16', layout='mono', samples=320)
        #             audio = np.zeros((1, 320), dtype=np.int16)
        #             frame = AudioFrame.from_ndarray(audio, layout='mono', format='s16')
        #             frame.sample_rate=16000
        #         else:
        #             frame = await self._queue.get()
        #     else:
        repeat_deadline = time.monotonic() + (
            getattr(self._player, 'video_ptime', VIDEO_PTIME)
            if self.kind == 'video' else AUDIO_PTIME
        )
        while True:
            try:
                frame, eventpoint = self._queue.get_nowait()
                if self.kind == 'video':
                    self._last_video_frame = frame
                break
            except queue.Empty:
                if self.kind == 'video' and self._last_video_frame is not None and time.monotonic() >= repeat_deadline:
                    frame = self._last_video_frame
                    eventpoint = None
                    self._player.record_repeated_frame()
                    break
                await asyncio.sleep(0.005)

        if frame is None:
            self.stop()
            raise Exception
        pts, time_base = await self.next_timestamp(getattr(frame, 'samples', None))
        frame.pts = pts
        frame.time_base = time_base
        if eventpoint and self._player is not None:
            self._player.notify(eventpoint)
        if self.kind == 'video':
            self.totaltime += (time.perf_counter() - self.lasttime)
            self.framecount += 1
            self.lasttime = time.perf_counter()
            if self.framecount==100:
                output_fps = self.framecount / self.totaltime if self.totaltime > 0 else 0.0
                self._player.record_output_fps(output_fps)
                mylogger.info(f"------actual avg final fps:{output_fps:.4f}")
                self.framecount = 0
                self.totaltime=0
        return frame
    
    def stop(self):
        super().stop()
        # Drain & delete remaining frames
        while not self._queue.empty():
            item = self._queue.get_nowait()
            del item
        if self._player is not None:
            self._player._stop(self)
            self._player = None

def player_worker_thread(
    quit_event,
    container
):
    container.render(quit_event)

class HumanPlayer:

    def __init__(
        self, avatar_session, format=None, options=None, timeout=None, loop=False, decode=True
    ):
        self.__thread: Optional[threading.Thread] = None
        self.__thread_quit: Optional[threading.Event] = None

        # examine streams
        self.__started: Set[PlayerStreamTrack] = set()
        self.__audio: Optional[PlayerStreamTrack] = None
        self.__video: Optional[PlayerStreamTrack] = None

        self.__container = avatar_session
        model_fps = max(1.0, float(getattr(avatar_session.opt, 'fps', 25.0)))
        output_fps = max(1.0, float(getattr(avatar_session.opt, 'output_fps', model_fps)))
        self.video_ptime = 1.0 / output_fps
        self.audio_ptime = AUDIO_PTIME
        self.video_repetition_ratio = max(1.0, output_fps / model_fps)
        self.video_repetitions = max(1, int(math.ceil(self.video_repetition_ratio)))
        self._video_repetition_accumulator = 0.0
        quality = os.getenv("LIVETALKING_VIDEO_QUALITY", "fhd").strip().lower()
        default_width, default_height = ((1920, 1080) if quality == "fhd" else (1280, 720))
        self.output_max_width = self._positive_env_int("LIVETALKING_MAX_WIDTH", default_width)
        self.output_max_height = self._positive_env_int("LIVETALKING_MAX_HEIGHT", default_height)
        self._reported_output_resize = False
        self.audio_packets_per_video = max(1.0, self.video_ptime / self.audio_ptime)
        self._audio_drop_accumulator = 0.0
        batch_size = int(getattr(avatar_session, 'batch_size', 4))
        self.__max_video_buffer = max(int(round(output_fps)), batch_size * self.video_repetitions)
        self.__max_audio_buffer = max(
            int(round(1.0 / AUDIO_PTIME)),
            int(round(self.__max_video_buffer * self.video_ptime / AUDIO_PTIME)),
        )
        self.__audio = PlayerStreamTrack(self, kind="audio", max_queue_size=self.__max_audio_buffer)
        self.__video = PlayerStreamTrack(self, kind="video", max_queue_size=self.__max_video_buffer)
        self.prebuffer_ms = max(0, min(1_500, int(getattr(avatar_session.opt, 'prebuffer_ms', 480))))
        self.prebuffer_video_frames = min(
            self.__max_video_buffer,
            max(self.video_repetitions, int(round(self.prebuffer_ms / 1000.0 / self.video_ptime))),
        )
        self.prebuffer_audio_frames = min(
            self.__max_audio_buffer,
            max(1, int(round(self.prebuffer_ms / 1000.0 / self.audio_ptime))),
        )
        self._prebuffer_ready = self.prebuffer_ms == 0
        if hasattr(self.__container, 'output'):
            self.__container.output._player = self

    async def wait_for_prebuffer(self) -> None:
        if self._prebuffer_ready:
            return
        deadline = time.monotonic() + max(1.5, self.prebuffer_ms / 1000.0 * 3.0)
        while not self._prebuffer_ready:
            video_ready = self.__video._queue.qsize() >= self.prebuffer_video_frames
            audio_ready = self.__audio._queue.qsize() >= self.prebuffer_audio_frames
            if (video_ready and audio_ready) or time.monotonic() >= deadline:
                self._prebuffer_ready = True
                return
            await asyncio.sleep(0.005)

    def _apply_output_backpressure(self) -> None:
        if self.prebuffer_ms <= 0 or not self._prebuffer_ready:
            return
        target_frames = max(self.video_repetitions, self.prebuffer_video_frames)
        deadline = time.monotonic() + max(0.5, self.prebuffer_ms / 1000.0 * 3.0)
        while self.__video._queue.qsize() >= target_frames and time.monotonic() < deadline:
            time.sleep(0.004)

    @staticmethod
    def _positive_env_int(name: str, fallback: int) -> int:
        try:
            return max(2, int(os.getenv(name, str(fallback))))
        except (TypeError, ValueError):
            return fallback

    def _prepare_output_frame(self, frame):
        if not isinstance(frame, np.ndarray) or frame.ndim < 2:
            return frame
        height, width = frame.shape[:2]
        scale = min(
            1.0,
            self.output_max_width / max(1, width),
            self.output_max_height / max(1, height),
        )
        if scale >= 1.0:
            return frame

        target_width = max(2, int(round(width * scale)))
        target_height = max(2, int(round(height * scale)))
        target_width -= target_width % 2
        target_height -= target_height % 2
        resized = cv2.resize(
            frame,
            (target_width, target_height),
            interpolation=cv2.INTER_AREA,
        )
        if not self._reported_output_resize:
            mylogger.info(
                "WebRTC output capped from %dx%d to %dx%d",
                width,
                height,
                target_width,
                target_height,
            )
            self._reported_output_resize = True
        return resized

    def push_video(self, frame, preserve=False):
        from av import VideoFrame
        self._apply_output_backpressure()
        output_frame = self._prepare_output_frame(frame)
        self._video_repetition_accumulator += self.video_repetition_ratio
        repetitions = max(1, int(math.floor(self._video_repetition_accumulator + 1e-9)))
        self._video_repetition_accumulator -= repetitions
        for _ in range(repetitions):
            new_frame = VideoFrame.from_ndarray(output_frame, format="bgr24")
            if preserve:
                self.__video._queue.put((new_frame, None))
                continue
            while self.__video._queue.full():
                try:
                    self.__video._queue.get_nowait()
                    # Keep the independently queued audio clock aligned with
                    # the stale output frame being discarded.
                    self._audio_drop_accumulator += self.audio_packets_per_video
                    audio_packets_to_drop = int(self._audio_drop_accumulator)
                    self._audio_drop_accumulator -= audio_packets_to_drop
                    for _ in range(audio_packets_to_drop):
                        try:
                            self.__audio._queue.get_nowait()
                        except queue.Empty:
                            break
                    self.record_dropped_frame()
                except queue.Empty:
                    break
            try:
                self.__video._queue.put_nowait((new_frame, None))
            except queue.Full:
                self.record_dropped_frame()

    def push_audio(self, frame, eventpoint=None):
        from av import AudioFrame
        new_frame = AudioFrame(format='s16', layout='mono', samples=frame.shape[0])
        new_frame.planes[0].update(frame.tobytes())
        new_frame.sample_rate = 16000
        self.__audio._queue.put((new_frame, eventpoint))

    def get_buffer_size(self) -> int:
        return self.__video._queue.qsize()

    def get_audio_buffer_size(self) -> int:
        return self.__audio._queue.qsize()

    def get_video_buffer_ms(self) -> float:
        return self.get_buffer_size() * self.video_ptime * 1000.0

    def get_audio_buffer_ms(self) -> float:
        return self.get_audio_buffer_size() * self.audio_ptime * 1000.0

    def get_av_drift_ms(self) -> float:
        return self.get_video_buffer_ms() - self.get_audio_buffer_ms()

    def clear_buffers(self) -> None:
        for track in (self.__video, self.__audio):
            while True:
                try:
                    track._queue.get_nowait()
                except queue.Empty:
                    break
        self.__video._last_video_frame = None
        self._prebuffer_ready = self.prebuffer_ms == 0

    def record_output_fps(self, fps: float) -> None:
        if self.__container is not None:
            self.__container.output_fps = float(fps)

    def record_dropped_frame(self) -> None:
        if self.__container is not None:
            self.__container.dropped_video_frames += 1

    def record_repeated_frame(self) -> None:
        if self.__container is not None:
            self.__container.repeated_video_frames += 1

    def notify(self,eventpoint):
        if self.__container is not None:
            self.__container.notify(eventpoint)

    @property
    def audio(self) -> MediaStreamTrack:
        """
        A :class:`aiortc.MediaStreamTrack` instance if the file contains audio.
        """
        return self.__audio

    @property
    def video(self) -> MediaStreamTrack:
        """
        A :class:`aiortc.MediaStreamTrack` instance if the file contains video.
        """
        return self.__video

    def _start(self, track: PlayerStreamTrack) -> None:
        self.__started.add(track)
        if self.__thread is None:
            self.__log_debug("Starting worker thread")
            self.__thread_quit = threading.Event()
            self.__thread = threading.Thread(
                name="media-player",
                target=player_worker_thread,
                args=(
                    self.__thread_quit,
                    self.__container
                ),
            )
            self.__thread.start()

    def _stop(self, track: PlayerStreamTrack) -> None:
        self.__started.discard(track)

        if not self.__started and self.__thread is not None:
            self.__log_debug("Stopping worker thread")
            self.__thread_quit.set()
            self.__thread.join()
            self.__thread = None

        if not self.__started and self.__container is not None:
            #self.__container.close()
            self.__container = None

    def __log_debug(self, msg: str, *args) -> None:
        mylogger.debug(f"HumanPlayer {msg}", *args)
