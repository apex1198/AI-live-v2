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
#
#  Avatar 基类 — 合并自 basereal.py，集成到 Async Pipeline
#

import math
from numpy.typing import NDArray
import torch
import numpy as np
import subprocess
import os
import time
import cv2
import glob
import resampy
import queue
from queue import Queue
from threading import Thread, Event
from io import BytesIO
import soundfile as sf
import asyncio
from enum import Enum
import json
import importlib
import registry

import torch.multiprocessing as mp
from dataclasses import dataclass, field

from av import AudioFrame, VideoFrame
from fractions import Fraction

from utils.logger import logger
from utils.image import read_imgs,mirror_index

# class State(Enum):
#     INIT=0
#     WAIT=1
#     QUESTION=2
#     ANSWER=3

@dataclass
class AudioFrameData:
    data: NDArray[np.float32]
    type: int = 0  # 默认值
    userdata: dict = field(default_factory=dict)

class BaseAvatar:
    def __init__(self, opt):
        self.opt = opt
        self.sample_rate = 16000
        # WebRTC audio stays on a fixed 20 ms clock independently of the
        # model cadence. At 12.5 model FPS, four audio packets feed one frame.
        self.chunk = self.sample_rate // 50
        self.audio_frames_per_video = max(1, int(round(50.0 / float(opt.fps))))
        self.sessionid = self.opt.sessionid

        self.speaking = False
        self.pipeline_state = "IDLE"
        self.pipeline_state_sequence = 0
        self.pipeline_state_updated_at = time.time()
        self.pipeline_state_details = {}
        self.current_frame_index = 0
        self.recording = False
        self._record_video_pipe = None
        self._record_audio_pipe = None
        self.width = self.height = 0
        self.inference_fps = 0.0
        self.output_fps = 0.0
        self.dropped_video_frames = 0
        self.repeated_video_frames = 0
        self._flush_epoch = 0

        self.custom_audiotype = 0 # 0: normal, 1: sinlence, >1: custom audio
        self.custom_img_cycle = {}
        self.custom_audio_cycle = {}
        self.custom_audio_index = {}
        self.custom_index = {}
        self.msgqueues = []
        # self.custom_opt = {}
        self.__loadcustom()

        self.batch_size = opt.batch_size
        self.res_frame_queue = Queue(self.batch_size*2)
        self.render_event = Event()

        _tts_modules = {
            'edgetts': 'tts.edge',
            'gpt-sovits': 'tts.sovits',
            'xtts': 'tts.xtts',
            'cosyvoice': 'tts.cosyvoice',
            'fishtts': 'tts.fish',
            'tencent': 'tts.tencent',
            'doubao': 'tts.doubao',
            'indextts2': 'tts.indextts2',
            'azuretts': 'tts.azure',
            'qwentts': 'tts.qwentts',
            'omnitts': 'tts.omnitts'
        }

        if opt.tts in _tts_modules:
            importlib.import_module(_tts_modules[opt.tts])
            self.tts = registry.create("tts", opt.tts, opt=opt, parent=self)
        else:
            logger.error(f"TTS module {opt.tts} not found.")

        _output_modules = {
            'webrtc': 'streamout.webrtc',
            'rtcpush': 'streamout.webrtc',
            'rtmp': 'streamout.rtmp',
            'virtualcam': 'streamout.virtualcam'
        }

        # 初始化 Output 模块
        if opt.transport in _output_modules:
            try:
                importlib.import_module(_output_modules[opt.transport])
                self.output = registry.create("streamout", opt.transport, opt=opt, parent=self)
            except ModuleNotFoundError:
                logger.error(f"Output transport module {_output_modules[opt.transport]} not found.")
        else:
            logger.error(f"Output transport {opt.transport} not found in map.")

    # 如果系统没有使用 pipeline，或者为了向后兼容原来的 ttsreal.py
    def put_msg_txt(self, msg, datainfo:dict={}):
        if hasattr(self, 'tts'):
            self.set_pipeline_state("GENERATING", {"text": str(msg or "")[:1000]})
            self.tts.put_msg_txt(msg, datainfo)
    
    def put_audio_frame(self, audio_chunk:NDArray[np.float32], datainfo:dict={}): # 16khz 20ms pcm
        if hasattr(self, 'asr'):
            self.asr.put_audio_frame(audio_chunk, datainfo)

    def put_audio_file(self, filebyte, datainfo=None):
        self.set_pipeline_state("GENERATING", {"source": "audio_upload"})
        try:
            input_stream = BytesIO(filebyte)
            stream = self.__create_bytes_stream(input_stream)
            self.__queue_audio_stream(stream, datainfo or {})
        except Exception as exc:
            self.set_pipeline_state("ERROR", {"error": str(exc)[:500]})
            raise

    def put_audio_filepath(self, filepath, datainfo=None):
        self.set_pipeline_state("GENERATING", {"source": "audio_file"})
        try:
            stream = self.__create_bytes_stream(filepath)
            self.__queue_audio_stream(stream, datainfo or {})
        except Exception as exc:
            self.set_pipeline_state("ERROR", {"error": str(exc)[:500]})
            raise

    def __queue_audio_stream(self, stream, datainfo):
        """Queue all PCM samples without dropping the final partial 20 ms chunk."""
        if stream.shape[0] == 0:
            raise ValueError("audio contains no samples")

        chunk_count = int(np.ceil(stream.shape[0] / self.chunk))
        for chunk_index in range(chunk_count):
            start = chunk_index * self.chunk
            chunk = stream[start:start + self.chunk]
            if chunk.shape[0] < self.chunk:
                chunk = np.pad(chunk, (0, self.chunk - chunk.shape[0]))
            eventpoint = dict(datainfo)
            if chunk_index == 0:
                eventpoint['status'] = 'start'
            self.put_audio_frame(chunk.astype(np.float32, copy=False), eventpoint)

        end_event = dict(datainfo)
        end_event['status'] = 'end'
        self.put_audio_frame(np.zeros(self.chunk, np.float32), end_event)
    
    def __create_bytes_stream(self, byte_stream):
        stream, sample_rate = sf.read(byte_stream) # [T*sample_rate,] float64
        logger.info(f'[INFO]put audio stream {sample_rate}: {stream.shape}')
        stream = stream.astype(np.float32)

        if stream.ndim > 1:
            logger.info(f'[WARN] audio has {stream.shape[1]} channels, only use the first.')
            stream = stream[:, 0]
    
        if sample_rate != self.sample_rate and stream.shape[0] > 0:
            logger.info(f'[WARN] audio sample rate is {sample_rate}, resampling into {self.sample_rate}.')
            stream = resampy.resample(x=stream, sr_orig=sample_rate, sr_new=self.sample_rate)

        return stream

    def flush_talk(self):
        self._flush_epoch += 1
        if hasattr(self, 'tts') and hasattr(self.tts, 'flush_talk'):
            self.tts.flush_talk()
        if hasattr(self, 'asr') and hasattr(self.asr, 'flush_talk'):
            self.asr.flush_talk()
        while True:
            try:
                self.res_frame_queue.get_nowait()
            except queue.Empty:
                break
        if hasattr(self, 'output') and hasattr(self.output, 'clear_buffers'):
            self.output.clear_buffers()
        self.speaking = False
        self.custom_audiotype = 0  
        self.set_pipeline_state("IDLE", {"reason": "interrupted"})

    # def flush(self):
    #     self.flush_talk()

    def is_speaking(self) -> bool:
        return self.speaking

    def set_pipeline_state(self, state: str, details:dict=None):
        """Track the worker-owned speech lifecycle exposed to runtime clients."""
        normalized = str(state or "IDLE").upper()
        if normalized not in ("GENERATING", "SPEAKING", "IDLE", "ERROR"):
            normalized = "ERROR"
        next_details = details if isinstance(details, dict) else {}
        if normalized == self.pipeline_state and next_details == self.pipeline_state_details:
            return
        self.pipeline_state = normalized
        self.pipeline_state_details = next_details
        self.pipeline_state_sequence += 1
        self.pipeline_state_updated_at = time.time()
        self.send_msg(json.dumps({
            "type": "speech_state",
            "sessionid": self.sessionid,
            "state": self.pipeline_state,
            "sequence": self.pipeline_state_sequence,
            "updated_at": self.pipeline_state_updated_at,
            "details": self.pipeline_state_details,
        }))

    def get_pipeline_status(self):
        frame_count = max(1, int(self.get_avatar_length()))
        source_fps = max(1.0, float(getattr(self, 'source_fps', self.opt.fps)))
        buffer_size = self.output.get_buffer_size() if hasattr(self, 'output') and hasattr(self.output, 'get_buffer_size') else 0
        buffered_source_frames = int(round(max(0, buffer_size) * source_fps / max(1.0, float(self.opt.fps))))
        display_frame_index = (int(self.current_frame_index) - buffered_source_frames) % frame_count
        details = dict(self.pipeline_state_details)
        details['playback'] = {
            'frame_index': int(self.current_frame_index),
            'display_frame_index': display_frame_index,
            'frame_count': frame_count,
            'source_fps': source_fps,
            'buffer_size': int(max(0, buffer_size)),
        }
        return {
            "sessionid": self.sessionid,
            "state": self.pipeline_state,
            "speaking": bool(self.speaking),
            "sequence": self.pipeline_state_sequence,
            "updated_at": self.pipeline_state_updated_at,
            "details": details,
        }
    
    def __loadcustom(self):
        if not hasattr(self.opt, 'customopt') or not self.opt.customopt:
            return
        for item in self.opt.customopt:
            logger.info(item)
            input_img_list = glob.glob(os.path.join(item['imgpath'], '*.[jpJP][pnPN]*[gG]'))
            input_img_list = sorted(input_img_list, key=lambda x: int(os.path.splitext(os.path.basename(x))[0]))
            self.custom_img_cycle[item['audiotype']] = read_imgs(input_img_list)
            if item.get('audiopath'):
                self.custom_audio_cycle[item['audiotype']], sample_rate = sf.read(item['audiopath'], dtype='float32')
                self.custom_audio_index[item['audiotype']] = 0
            self.custom_index[item['audiotype']] = 0
            # self.custom_opt[item['audiotype']] = item

    def init_customindex(self):
        self.custom_audiotype = 0
        for key in self.custom_audio_index:
            self.custom_audio_index[key] = 0
        for key in self.custom_index:
            self.custom_index[key] = 0

    def add_msgqueue(self, msgqueue):
        self.msgqueues.append(msgqueue)

    def send_msg(self, msg):
        for q in self.msgqueues:
            q.put(msg)

    def notify(self, eventpoint:dict):
        if eventpoint and eventpoint.get('status'):
            logger.info("notify:%s", eventpoint)
            status = str(eventpoint.get('status') or '').lower()
            details = {"text": str(eventpoint.get('text') or '')[:1000]} if eventpoint.get('text') else {}
            if status == 'start':
                self.set_pipeline_state("SPEAKING", details)
            elif status == 'end':
                self.set_pipeline_state("IDLE", details)
            self.send_msg(json.dumps(eventpoint))

    def start_recording(self):
        if self.recording:
            return
        command = ['ffmpeg',
                    '-y', '-an',
                    '-f', 'rawvideo',
                    '-vcodec','rawvideo',
                    '-pix_fmt', 'bgr24',
                    '-s', "{}x{}".format(self.width, self.height),
                    '-r', str(self.opt.fps),
                    '-i', '-',
                    '-pix_fmt', 'yuv420p', 
                    '-vcodec', "h264",
                    f'temp{self.opt.sessionid}.mp4']
        self._record_video_pipe = subprocess.Popen(command, shell=False, stdin=subprocess.PIPE)

        acommand = ['ffmpeg',
                    '-y', '-vn',
                    '-f', 's16le',
                    '-ac', '1',
                    '-ar', '16000',
                    '-i', '-',
                    '-acodec', 'aac',
                    f'temp{self.opt.sessionid}.aac']
        self._record_audio_pipe = subprocess.Popen(acommand, shell=False, stdin=subprocess.PIPE)

        self.recording = True
    
    def record_video_data(self, image):
        if self.width == 0:
            self.height, self.width, _ = image.shape
        if self.recording:
            self._record_video_pipe.stdin.write(image.tobytes()) #tostring()

    def record_audio_data(self, frame):
        if self.recording:
            self._record_audio_pipe.stdin.write(frame.tobytes())
		
    def stop_recording(self):
        if not self.recording:
            return
        self.recording = False 
        self._record_video_pipe.stdin.close()
        self._record_video_pipe.wait()
        self._record_audio_pipe.stdin.close()
        self._record_audio_pipe.wait()
        
        record_path = os.path.join('data', 'record')
        os.makedirs(record_path, exist_ok=True)
        output_file = os.path.join(record_path, f"{self.opt.sessionid}.mp4")
        
        temp_aac = f"temp{self.opt.sessionid}.aac"
        temp_mp4 = f"temp{self.opt.sessionid}.mp4"
        
        cmd_combine_audio = f"ffmpeg -y -i {temp_aac} -i {temp_mp4} -c:v copy -c:a copy {output_file}"
        os.system(cmd_combine_audio)
        
        # 删除临时文件
        try:
            os.remove(temp_aac)
            os.remove(temp_mp4)
        except Exception as e:
            logger.error(f"Error removing temp files: {e}")

    # def mirror_index(self, size, index):
    #     turn = index // size
    #     res = index % size
    #     if turn % 2 == 0:
    #         return res
    #     else:
    #         return size - res - 1 
    
    def get_custom_audio_stream(self, audiotype):
        idx = self.custom_audio_index[audiotype]
        stream = self.custom_audio_cycle[audiotype][idx:idx+self.chunk]
        self.custom_audio_index[audiotype] += self.chunk
        if self.custom_audio_index[audiotype] >= self.custom_audio_cycle[audiotype].shape[0]:
            self.custom_audiotype = 1
        return stream
    
    def set_custom_state(self, audiotype, reinit=True):
        print('set_custom_state:', audiotype)
        if self.custom_audio_index.get(audiotype) is None:
            return
        self.custom_audiotype = audiotype
        if reinit:
            self.custom_audio_index[audiotype] = 0
            self.custom_index[audiotype] = 0

    # ========================== 核心渲染及 Pipeline 桥接 ==========================
    def get_avatar_length(self):
        if hasattr(self, 'frame_list_cycle'):
            return len(self.frame_list_cycle)
        return 1

    def get_idle_frame(self, idx):
        length = max(1, self.get_avatar_length())
        return self.frame_list_cycle[self.map_frame_index(length, idx)]

    def paste_back_frame_for_epoch(self, pred_frame, idx, batch_epoch):
        if batch_epoch != self._flush_epoch:
            return None
        return self.paste_back_frame(pred_frame, idx)

    def map_frame_index(self, length, index):
        return mirror_index(length, index)

    def inference_batch_for_indices(self, index, audiofeat_batch, frame_indices):
        """Run inference for a batch whose source indices were resolved once."""
        return self.inference_batch(index, audiofeat_batch)
        
    def inference(self, quit_event):
        index = 0
        last_epoch = self._flush_epoch
        count = 0
        counttime = 0
        last_speaking = False

        # syncnet_T = 12  # 时间步
        # weight_dtype = torch.float16  # 数据类型
        # infernum = 0
        logger.info('start inference')
        while not quit_event.is_set():
            starttime = time.perf_counter()
            audiofeat_batch = []
            batch_epoch = self._flush_epoch
            try:
                feature_payload = self.asr.feat_queue.get(block=True, timeout=1)
            except queue.Empty:
                continue
            if (
                isinstance(feature_payload, tuple)
                and len(feature_payload) == 2
                and isinstance(feature_payload[1], (list, tuple))
            ):
                audiofeat_batch, packet_counts = feature_payload
                packet_counts = [max(1, int(count)) for count in packet_counts]
            else:
                audiofeat_batch = feature_payload
                packet_counts = [self.audio_frames_per_video] * self.batch_size
            if len(packet_counts) != self.batch_size:
                logger.warning("Invalid audio packet cadence; using rounded model cadence")
                packet_counts = [self.audio_frames_per_video] * self.batch_size
            if batch_epoch != last_epoch:
                index = 0
                last_epoch = batch_epoch
            length = max(1, self.get_avatar_length())
                
            is_all_silence = True
            audio_frames: list[AudioFrameData] = []
            for _ in range(sum(packet_counts)):
                audioframe:AudioFrameData = self.asr.output_queue.get()
                if audioframe.type == 0:
                    is_all_silence = False               
                audio_frames.append(audioframe)

             # 检测状态变化
            current_speaking = not is_all_silence

            if is_all_silence: #全为静音数据，只需要取fullimg，不需要推理
                for i in range(self.batch_size):
                    idx = self.map_frame_index(length, index)
                    start = sum(packet_counts[:i])
                    end = start + packet_counts[i]
                    self.res_frame_queue.put((None, audio_frames[start:end], idx, batch_epoch))
                    index = index + 1
            else:
                if current_speaking and not last_speaking and self.custom_index.get(1) is not None: #从静音到说话切换,并且有自定义静态视频
                    index = 0
                t = time.perf_counter()
                frame_indices = [
                    self.map_frame_index(length, index + i)
                    for i in range(self.batch_size)
                ]
                pred = self.inference_batch_for_indices(index, audiofeat_batch, frame_indices)

                batch_time = time.perf_counter() - t
                counttime += batch_time
                count += self.batch_size
                if batch_time > 0:
                    batch_fps = self.batch_size / batch_time
                    self.inference_fps = batch_fps if self.inference_fps <= 0 else (
                        self.inference_fps * 0.8 + batch_fps * 0.2
                    )
                if count >= 100:
                    logger.info(f"------actual avg infer fps:{self.inference_fps:.4f}")
                    count = 0
                    counttime = 0
                for i, res_frame in enumerate(pred):
                    start = sum(packet_counts[:i])
                    end = start + packet_counts[i]
                    self.res_frame_queue.put((res_frame, audio_frames[start:end], frame_indices[i], batch_epoch))
                    index = index + 1
                    
            if current_speaking != last_speaking:
                logger.info(f"inference 状态切换：{'说话' if last_speaking else '静音'} → {'说话' if current_speaking else '静音'}")
                last_speaking = current_speaking         
        logger.info('baseavatar inference thread stop')

    def process_frames(self,quit_event):
        enable_transition = False  # 设置为False禁用过渡效果，True启用
        
        _last_speaking = False
        _transition_start = time.time()
        if enable_transition:
            _transition_duration = 0.1  # 过渡时间
            _last_silent_frame = None  # 静音帧缓存
            _last_speaking_frame = None  # 说话帧缓存

        self.output.start()
        
        while not quit_event.is_set():
            try:
                audio_frames: list[AudioFrameData]
                item = self.res_frame_queue.get(block=True, timeout=1)
            except queue.Empty:
                continue
            if len(item) == 4:
                res_frame, audio_frames, idx, batch_epoch = item
                if batch_epoch != self._flush_epoch:
                    continue
            else:
                res_frame, audio_frames, idx = item
            
            # 检测状态变化
            current_speaking = any(audio_frame.type == 0 for audio_frame in audio_frames)
            if current_speaking != _last_speaking:
                logger.info(f"状态切换：{'说话' if _last_speaking else '静音'} → {'说话' if current_speaking else '静音'}")
                _transition_start = time.time()
                self.set_pipeline_state(
                    "SPEAKING" if current_speaking else "IDLE",
                    {"reason": "audio_frames_active" if current_speaking else "audio_frames_drained"},
                )
            _last_speaking = current_speaking
            self.current_frame_index = int(idx)

            if not current_speaking: #全为静音数据，只需要取fullimg
                self.speaking = False
                audiotype = audio_frames[0].type
                if self.custom_index.get(audiotype) is not None: #有自定义视频
                    mirindex = mirror_index(len(self.custom_img_cycle[audiotype]),self.custom_index[audiotype])
                    target_frame = self.custom_img_cycle[audiotype][mirindex]
                    self.custom_index[audiotype] += 1
                else:
                    target_frame = self.get_idle_frame(idx)
                
                if enable_transition:
                    # 说话→静音过渡
                    if time.time() - _transition_start < _transition_duration and _last_speaking_frame is not None:
                        alpha = min(1.0, (time.time() - _transition_start) / _transition_duration)
                        combine_frame = cv2.addWeighted(_last_speaking_frame, 1-alpha, target_frame, alpha, 0)
                    else:
                        combine_frame = target_frame
                    # 缓存静音帧
                    _last_silent_frame = combine_frame.copy()
                else:
                    combine_frame = target_frame
            else:
                self.speaking = True
                try:
                    current_frame = self.paste_back_frame_for_epoch(res_frame, idx, batch_epoch)
                    if current_frame is None:
                        continue
                except Exception as e:
                    logger.warning(f"paste_back_frame error: {e}")
                    continue
                if enable_transition:
                    # 静音→说话过渡
                    if time.time() - _transition_start < _transition_duration and _last_silent_frame is not None:
                        alpha = min(1.0, (time.time() - _transition_start) / _transition_duration)
                        combine_frame = cv2.addWeighted(_last_silent_frame, 1-alpha, current_frame, alpha, 0)
                    else:
                        combine_frame = current_frame
                    # 缓存说话帧
                    _last_speaking_frame = combine_frame.copy()
                else:
                    combine_frame = current_frame

            cv2.putText(combine_frame, "LiveTalking", (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.3, (128,128,128), 1)
            
            # 使用统一输出接口推送视频帧
            self.output.push_video_frame(combine_frame)
            self.record_video_data(combine_frame)

            for audio_frame in audio_frames:
                #frame,type,eventpoint = audio_frame
                frame = (audio_frame.data * 32767).astype(np.int16)

                # 使用统一输出接口推送音频帧
                self.output.push_audio_frame(frame, audio_frame.userdata)
                self.record_audio_data(frame)
                
            # if self.opt.transport == 'virtualcam' and hasattr(self.output, '_cam') and self.output._cam:
            #     self.output._cam.sleep_until_next_frame()

        self.output.stop()
        logger.info('baseavatar process_frames thread stop') 

    def render(self,quit_event):
        self.quit_event = quit_event
        
        self.init_customindex()
        self.tts.render(quit_event)

        infer_quit_event = mp.Event()
        infer_thread = Thread(target=self.inference, args=(infer_quit_event,))
        infer_thread.start()
        
        process_quit_event = Event()
        process_thread = Thread(target=self.process_frames, args=(process_quit_event,))
        process_thread.start()

        count=0
        totaltime=0
        _starttime=time.perf_counter()
        _totalframe=0
        frame_interval = 1.0 / max(1, self.opt.fps)
        while not quit_event.is_set(): 
            t = time.perf_counter()
            self.asr.run_step()

            buffer_size = self.output.get_buffer_size() if hasattr(self.output, 'get_buffer_size') else 0
            if buffer_size >= 5:
                logger.debug('sleep qsize=%d', buffer_size)
                time.sleep(frame_interval * buffer_size * 0.8)
        logger.info('baseavatar render thread stop')

        infer_quit_event.set()
        infer_thread.join()

        process_quit_event.set()
        process_thread.join()
