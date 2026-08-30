import asyncio
import inspect
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from av import AudioFrame, VideoFrame

from avatars.audio_features.whisper import WhisperASR
from avatars.base_avatar import BaseAvatar
from avatars.musetalk_avatar import MuseReal
from server.rtc_manager import RTCManager, session_manager
from server.session_manager import SessionReplacedError
from server.webrtc import HumanPlayer, PlayerStreamTrack


class FakePlayer:
    def __init__(self, fps=25):
        self.repeated_frames = 0
        self.video_ptime = 1.0 / fps

    def _start(self, track):
        pass

    def _stop(self, track):
        pass

    def notify(self, eventpoint):
        pass

    def record_output_fps(self, fps):
        pass

    def record_repeated_frame(self):
        self.repeated_frames += 1


class FakePeerConnection:
    def __init__(self):
        self.connectionState = "disconnected"
        self.closed = False

    async def close(self):
        self.closed = True
        self.connectionState = "closed"


class HangingPeerConnection(FakePeerConnection):
    async def close(self):
        await asyncio.Event().wait()


class RealtimePacingTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_musetalk_uses_forward_loop_for_seamless_idle_boundary(self):
        avatar = SimpleNamespace(source_fps=24, opt=SimpleNamespace(fps=24))
        indices = [MuseReal.map_frame_index(avatar, 5, index) for index in range(7)]
        self.assertEqual(indices, [0, 1, 2, 3, 4, 0, 1])

    async def test_pipeline_status_reports_buffer_adjusted_display_frame(self):
        avatar = SimpleNamespace(
            opt=SimpleNamespace(fps=25),
            source_fps=25,
            current_frame_index=2,
            pipeline_state='IDLE',
            pipeline_state_sequence=4,
            pipeline_state_updated_at=1.0,
            pipeline_state_details={},
            speaking=False,
            sessionid='status_test',
            output=SimpleNamespace(get_buffer_size=lambda: 5),
            get_avatar_length=lambda: 100,
        )
        status = BaseAvatar.get_pipeline_status(avatar)
        self.assertEqual(status['details']['playback']['display_frame_index'], 97)
        self.assertEqual(status['details']['playback']['buffer_size'], 5)

    async def test_video_track_rebases_after_starvation_without_catchup_burst(self):
        track = PlayerStreamTrack(FakePlayer(), "video")
        track._timestamp = 0
        track._start = time.monotonic() - 2

        started = time.perf_counter()
        await track.next_timestamp()
        first_elapsed = time.perf_counter() - started

        started = time.perf_counter()
        await track.next_timestamp()
        second_elapsed = time.perf_counter() - started

        self.assertLess(first_elapsed, 0.02)
        self.assertGreater(second_elapsed, 0.025)

    async def test_video_track_repeats_last_frame_at_realtime_cadence(self):
        player = FakePlayer()
        track = PlayerStreamTrack(player, "video")
        source = VideoFrame.from_ndarray(np.zeros((16, 16, 3), dtype=np.uint8), format="bgr24")
        track._queue.put((source, None))

        first = await track.recv()
        first_pts = first.pts
        started = time.perf_counter()
        repeated = await track.recv()
        elapsed = time.perf_counter() - started

        self.assertEqual(player.repeated_frames, 1)
        self.assertGreater(repeated.pts, first_pts)
        self.assertGreater(elapsed, 0.025)
        self.assertLess(elapsed, 0.08)

    async def test_50_fps_video_and_10ms_audio_use_matching_timestamps(self):
        player = FakePlayer(fps=50)
        video_track = PlayerStreamTrack(player, "video")
        first_video_pts, _ = await video_track.next_timestamp()
        second_video_pts, _ = await video_track.next_timestamp()

        audio_track = PlayerStreamTrack(player, "audio")
        audio_frame = AudioFrame(format="s16", layout="mono", samples=160)
        first_audio_pts, _ = await audio_track.next_timestamp(audio_frame.samples)
        second_audio_pts, _ = await audio_track.next_timestamp(audio_frame.samples)

        self.assertEqual(second_video_pts - first_video_pts, 1800)
        self.assertEqual(second_audio_pts - first_audio_pts, 160)

    async def test_25_fps_inference_enqueues_one_real_video_frame(self):
        avatar = SimpleNamespace(
            opt=SimpleNamespace(fps=25, output_fps=25),
            batch_size=8,
            dropped_video_frames=0,
            repeated_video_frames=0,
        )
        player = HumanPlayer(avatar)
        player.push_video(np.zeros((16, 16, 3), dtype=np.uint8))

        self.assertAlmostEqual(player.video_ptime, 1 / 25)
        self.assertEqual(player.video._queue.maxsize, 25)
        self.assertEqual(player.video._queue.qsize(), 1)
        self.assertEqual(avatar.repeated_video_frames, 0)

    async def test_12_5_model_clock_repeats_frames_at_25_fps(self):
        avatar = SimpleNamespace(
            opt=SimpleNamespace(fps=12.5, output_fps=25),
            batch_size=8,
            dropped_video_frames=0,
            repeated_video_frames=0,
        )
        player = HumanPlayer(avatar)
        player.push_video(np.zeros((16, 16, 3), dtype=np.uint8))

        self.assertAlmostEqual(player.video_ptime, 1 / 25)
        self.assertEqual(player.video_repetitions, 2)
        self.assertEqual(player.video._queue.qsize(), 2)
        self.assertEqual(player.audio_packets_per_video, 2)

    async def test_video_queue_drops_stale_frames_when_saturated(self):
        avatar = SimpleNamespace(
            opt=SimpleNamespace(fps=25),
            batch_size=4,
            dropped_video_frames=0,
            repeated_video_frames=0,
        )
        player = HumanPlayer(avatar)
        capacity = player.video._queue.maxsize

        for index in range(capacity + 3):
            player.push_video(np.full((4, 4, 3), index, dtype=np.uint8))

        self.assertEqual(player.video._queue.qsize(), capacity)
        self.assertEqual(avatar.dropped_video_frames, 3)
        oldest_frame, _ = player.video._queue.get_nowait()
        self.assertEqual(int(oldest_frame.to_ndarray(format="bgr24")[0, 0, 0]), 3)

    async def test_saturated_video_drops_matching_audio_pair(self):
        avatar = SimpleNamespace(
            opt=SimpleNamespace(fps=25),
            batch_size=4,
            dropped_video_frames=0,
            repeated_video_frames=0,
        )
        player = HumanPlayer(avatar)
        capacity = player.video._queue.maxsize
        audio = np.zeros(320, dtype=np.int16)

        for _ in range(capacity):
            player.push_video(np.zeros((4, 4, 3), dtype=np.uint8))
            player.push_audio(audio)
            player.push_audio(audio)

        player.push_video(np.ones((4, 4, 3), dtype=np.uint8))
        self.assertEqual(player.get_buffer_size(), capacity)
        self.assertEqual(player.get_audio_buffer_size(), capacity * 2 - 2)
        player.push_audio(audio)
        player.push_audio(audio)

        self.assertEqual(avatar.dropped_video_frames, 1)
        self.assertAlmostEqual(player.get_av_drift_ms(), 0.0)

    async def test_one_video_and_two_audio_frames_have_zero_queue_drift(self):
        avatar = SimpleNamespace(
            opt=SimpleNamespace(fps=25),
            batch_size=4,
            dropped_video_frames=0,
            repeated_video_frames=0,
        )
        player = HumanPlayer(avatar)
        player.push_video(np.zeros((4, 4, 3), dtype=np.uint8))
        player.push_audio(np.zeros(320, dtype=np.int16))
        player.push_audio(np.zeros(320, dtype=np.int16))

        self.assertEqual(player.get_buffer_size(), 1)
        self.assertEqual(player.get_audio_buffer_size(), 2)
        self.assertAlmostEqual(player.get_video_buffer_ms(), 40.0)
        self.assertAlmostEqual(player.get_audio_buffer_ms(), 40.0)
        self.assertAlmostEqual(player.get_av_drift_ms(), 0.0)

    async def test_interrupt_clears_queued_audio_video_and_last_talking_frame(self):
        avatar = SimpleNamespace(
            opt=SimpleNamespace(fps=25),
            batch_size=4,
            dropped_video_frames=0,
            repeated_video_frames=0,
        )
        player = HumanPlayer(avatar)
        player.push_video(np.zeros((4, 4, 3), dtype=np.uint8))
        player.push_audio(np.zeros(320, dtype=np.int16))
        player.video._last_video_frame = VideoFrame.from_ndarray(
            np.zeros((4, 4, 3), dtype=np.uint8), format="bgr24"
        )

        player.clear_buffers()

        self.assertEqual(player.get_buffer_size(), 0)
        self.assertEqual(player.get_audio_buffer_size(), 0)
        self.assertIsNone(player.video._last_video_frame)

    async def test_whisper_uses_upstream_two_frame_timing_offset(self):
        source = inspect.getsource(WhisperASR.run_step)
        self.assertIn("audio_feat_win = [2,3]", source)

    async def test_whisper_12_5_fps_emits_audio_for_every_model_frame(self):
        # The inference worker consumes batch_size * audio_frames_per_video
        # packets. This catches the deadlock introduced when model FPS drops
        # below 25 while ASR still emits the old two-packet batch.
        asr = object.__new__(WhisperASR)
        WhisperASR.__init__(
            asr,
            SimpleNamespace(fps=12.5, batch_size=8, l=0, r=0),
            None,
            None,
        )

        WhisperASR.run_step(asr)

        self.assertEqual(asr.audio_frames_per_video, 4)
        self.assertEqual(asr.output_queue.qsize(), 32)
        self.assertEqual(len(asr.feat_queue.get_nowait()), 8)

    async def test_musetalk_realtime_inference_disables_gradients(self):
        self.assertTrue(hasattr(MuseReal.inference_batch, "__wrapped__"))

    async def test_disconnected_peer_releases_its_session(self):
        manager = RTCManager(SimpleNamespace(stun=""))
        sessionid = "realtime_test_session"
        session_manager.sessions[sessionid] = object()
        pc = FakePeerConnection()

        async def no_wait(_seconds):
            return None

        try:
            with patch("server.rtc_manager.asyncio.sleep", new=no_wait):
                await manager._close_if_still_disconnected(pc, sessionid)
            self.assertTrue(pc.closed)
            self.assertNotIn(sessionid, session_manager.sessions)
        finally:
            session_manager.sessions.pop(sessionid, None)

    async def test_explicit_close_releases_session_before_reconnect(self):
        manager = RTCManager(SimpleNamespace(stun=""))
        sessionid = "explicit_close_test_session"
        session_manager.sessions[sessionid] = object()
        pc = FakePeerConnection()
        manager.pcs.add(pc)
        manager._session_pcs[sessionid] = pc

        try:
            self.assertTrue(await manager.close_session(sessionid))
            self.assertTrue(pc.closed)
            self.assertNotIn(sessionid, manager._session_pcs)
            self.assertNotIn(sessionid, session_manager.sessions)
            self.assertFalse(await manager.close_session(sessionid))
        finally:
            session_manager.sessions.pop(sessionid, None)

    async def test_avatar_delete_releases_session_when_peer_close_hangs(self):
        manager = RTCManager(SimpleNamespace(stun=""))
        manager.close_timeout_seconds = 0.01
        sessionid = "avatar_delete_hanging_session"
        avatar_id = "avatar_delete_test"
        session_manager.sessions[sessionid] = SimpleNamespace(opt=SimpleNamespace(avatar_id=avatar_id))
        pc = HangingPeerConnection()
        manager.pcs.add(pc)
        manager._session_pcs[sessionid] = pc

        try:
            self.assertEqual(await manager.close_sessions_for_avatar(avatar_id), 1)
            self.assertNotIn(sessionid, manager._session_pcs)
            self.assertNotIn(sessionid, session_manager.sessions)
        finally:
            session_manager.remove_session(sessionid)

    async def test_replace_closes_all_orphaned_sessions(self):
        manager = RTCManager(SimpleNamespace(stun=""))
        first_id = "replace_first_session"
        second_id = "replace_second_session"
        first_pc = FakePeerConnection()
        second_pc = FakePeerConnection()
        for sessionid, pc in ((first_id, first_pc), (second_id, second_pc)):
            session_manager.sessions[sessionid] = object()
            manager.pcs.add(pc)
            manager._session_pcs[sessionid] = pc

        try:
            self.assertEqual(await manager.close_all_sessions(), 2)
            self.assertTrue(first_pc.closed)
            self.assertTrue(second_pc.closed)
            self.assertFalse(session_manager.sessions)
        finally:
            session_manager.sessions.pop(first_id, None)
            session_manager.sessions.pop(second_id, None)

    async def test_replaced_pending_session_cannot_resurrect_after_build(self):
        sessionid = "pending_replacement_session"
        build_started = threading.Event()
        release_build = threading.Event()
        previous_builder = session_manager.build_session_fn

        def delayed_builder(_sessionid, _params):
            build_started.set()
            release_build.wait(timeout=2)
            return object()

        session_manager.init_builder(delayed_builder)
        create_task = asyncio.create_task(session_manager.create_session({}, sessionid))
        try:
            self.assertTrue(await asyncio.to_thread(build_started.wait, 1))
            session_manager.remove_session(sessionid)
            release_build.set()
            with self.assertRaises(SessionReplacedError):
                await create_task
            self.assertNotIn(sessionid, session_manager.sessions)
        finally:
            release_build.set()
            session_manager.remove_session(sessionid)
            session_manager.init_builder(previous_builder)


if __name__ == "__main__":
    unittest.main()
