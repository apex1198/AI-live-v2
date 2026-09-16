#!/usr/bin/env python3
"""Queued FasterLivePortrait MLX batch service for the V2 lipsync tester."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

SERVICE_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = SERVICE_DIR.parents[1]
VENDOR_ROOT = Path(os.environ.get("FASTER_LIVEPORTRAIT_VENDOR_DIR", SERVICE_DIR / "vendor" / "fasterliveportrait-mlx")).resolve()
RUNTIME_ROOT = Path(os.environ.get("FASTER_LIVEPORTRAIT_RUNTIME_DIR", WORKSPACE_ROOT / "runtime-data" / "faster-liveportrait")).resolve()
CHECKPOINT_DIR = Path(os.environ.get("FASTER_LIVEPORTRAIT_WEIGHTS_DIR", RUNTIME_ROOT / "checkpoints")).resolve()
HF_HOME_DIR = Path(os.environ.get("FASTER_LIVEPORTRAIT_HF_HOME", RUNTIME_ROOT / "huggingface")).resolve()
JOBS_DIR = RUNTIME_ROOT / "jobs"
UPSTREAM_REVISION = "d5361f4806c14fe2051eecb1dd5a89930f46db0d"
MAX_ATTEMPTS = 2
SAFE_NAME = re.compile(r"[^a-zA-Z0-9._-]+")
QWEN_TTS_ENDPOINT = os.environ.get("FASTER_LIVEPORTRAIT_QWEN_TTS_ENDPOINT", os.environ.get("QWEN_TTS_ENDPOINT", "http://127.0.0.1:3333")).rstrip("/")
QWEN_TTS_ALLOWED_HOSTS = frozenset(
    host.strip() for host in os.environ.get("FASTER_LIVEPORTRAIT_QWEN_TTS_ALLOWED_HOSTS", "127.0.0.1,localhost,::1").split(",") if host.strip()
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_name(value: str, fallback: str) -> str:
    cleaned = SAFE_NAME.sub("-", Path(value or fallback).name).strip(".-")
    return cleaned or fallback


def require_upstream() -> None:
    if not (VENDOR_ROOT / "webui.py").is_file():
        raise RuntimeError(
            f"FasterLivePortrait MLX source is missing at {VENDOR_ROOT}. "
            "Run: pnpm faster-liveportrait:setup"
        )
    if str(VENDOR_ROOT) not in sys.path:
        sys.path.insert(0, str(VENDOR_ROOT))
    os.chdir(VENDOR_ROOT)
    os.environ.setdefault("HF_HOME", str(HF_HOME_DIR))
    os.environ.setdefault("FLIP_CHECKPOINT_DIR", str(CHECKPOINT_DIR))


require_upstream()

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from omegaconf import OmegaConf  # noqa: E402
from src.pipelines.gradio_live_portrait_pipeline import GradioLivePortraitPipeline  # noqa: E402
from src.runtime_assets import ensure_runtime_assets  # noqa: E402
from src.utils.mlx_profiles import MLX_PROFILE_CHOICES  # noqa: E402


@dataclass
class Job:
    id: str
    mode: str
    source_path: str
    audio_path: str | None
    text: str | None
    voice_name: str
    profile: str
    created_at: str
    updated_at: str
    status: str = "queued"
    message: str = "Queued"
    attempts: int = 0
    output_path: str | None = None
    error: str | None = None
    duration_seconds: float | None = None
    output_fps: int = 30
    output_width: int = 1280
    output_height: int = 720


class FasterLivePortraitService:
    def __init__(self) -> None:
        self.pipeline: GradioLivePortraitPipeline | None = None
        self.jobs: dict[str, Job] = {}
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.worker_task: asyncio.Task[None] | None = None
        self.runtime_state = "initializing"
        self.runtime_message = "Preparing FasterLivePortrait MLX"

    def _job_file(self, job: Job) -> Path:
        return Path(job.source_path).parent / "job.json"

    def _persist(self, job: Job) -> None:
        target = self._job_file(job)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(".tmp")
        temp.write_text(json.dumps(asdict(job), ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(target)

    def _update(self, job: Job, **values: Any) -> None:
        for key, value in values.items():
            setattr(job, key, value)
        job.updated_at = now_iso()
        self._persist(job)

    def _serialize(self, job: Job) -> dict[str, Any]:
        payload = asdict(job)
        payload["output_url"] = f"/api/jobs/{job.id}/result" if job.output_path else None
        return payload

    def initialize(self) -> None:
        RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
        JOBS_DIR.mkdir(parents=True, exist_ok=True)
        CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
        HF_HOME_DIR.mkdir(parents=True, exist_ok=True)
        config_path = VENDOR_ROOT / "configs" / "mlx_infer.yaml"
        config = OmegaConf.load(config_path)
        ensure_runtime_assets(config)
        self.pipeline = GradioLivePortraitPipeline(config)
        self.pipeline.set_mlx_profile("quality")
        self.runtime_state = "ready"
        self.runtime_message = "Ready to queue audio or Qwen TTS text lipsync jobs"

    async def recover_jobs(self) -> None:
        for state_file in JOBS_DIR.glob("*/job.json"):
            try:
                job = Job(**json.loads(state_file.read_text(encoding="utf-8")))
            except (OSError, TypeError, json.JSONDecodeError) as error:
                print(f"Skipping invalid saved job {state_file}: {error}", flush=True)
                continue
            self.jobs[job.id] = job
            if job.status not in {"queued", "processing"}:
                continue
            if job.attempts < MAX_ATTEMPTS:
                self._update(job, status="queued", message="Recovered after worker restart")
                await self.queue.put(job.id)
            else:
                self._update(
                    job,
                    status="failed",
                    message="Worker exited after all automatic retry attempts",
                    error=job.error or "The worker stopped before this job could complete its final retry.",
                )

    async def start(self) -> None:
        self.initialize()
        await self.recover_jobs()
        self.worker_task = asyncio.create_task(self._consume(), name="faster-liveportrait-job-worker")

    async def stop(self) -> None:
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        if self.pipeline:
            self.pipeline._park_mlx_models()

    async def submit(self, job: Job) -> None:
        self.jobs[job.id] = job
        self._persist(job)
        await self.queue.put(job.id)

    @staticmethod
    def _qwen_tts_base_url() -> str:
        endpoint = urlparse(QWEN_TTS_ENDPOINT)
        if endpoint.scheme not in {"http", "https"} or not endpoint.hostname:
            raise RuntimeError("FASTER_LIVEPORTRAIT_QWEN_TTS_ENDPOINT must be a local HTTP(S) URL")
        if endpoint.hostname not in QWEN_TTS_ALLOWED_HOSTS:
            raise RuntimeError(f"Qwen TTS endpoint host {endpoint.hostname!r} is not allowlisted")
        return QWEN_TTS_ENDPOINT

    def qwen_tts_health(self) -> tuple[bool, str]:
        try:
            request = Request(f"{self._qwen_tts_base_url()}/api/health", method="GET")
            with urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("ready") is True and payload.get("model_loaded") is True and payload.get("provider") == "qwentts":
                return True, "Qwen TTS Vietnamese ready for text driving"
            return False, "Qwen TTS is running but its model is not ready"
        except (HTTPError, URLError, TimeoutError, ValueError, RuntimeError, OSError) as error:
            return False, f"Qwen TTS unavailable: {error}"

    def _synthesize_qwen_tts(self, text: str, voice_name: str, output_path: Path) -> Path:
        payload = json.dumps({
            "text": text,
            "voice_id": voice_name or "qwen-default",
            "speed": 1.0,
        }).encode("utf-8")
        request = Request(
            f"{self._qwen_tts_base_url()}/api/synthesize",
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "audio/wav"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=90) as response:
                audio = response.read(40 * 1024 * 1024 + 1)
        except HTTPError as error:
            detail = error.read(4096).decode("utf-8", errors="replace")
            raise RuntimeError(f"Qwen TTS HTTP {error.code}: {detail or error.reason}") from error
        except (URLError, TimeoutError, OSError) as error:
            raise RuntimeError(f"Qwen TTS request failed: {error}") from error
        if len(audio) > 40 * 1024 * 1024:
            raise RuntimeError("Qwen TTS returned audio larger than 40 MB")
        if len(audio) < 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
            raise RuntimeError("Qwen TTS did not return a valid WAV file")
        output_path.write_bytes(audio)
        return output_path

    async def _consume(self) -> None:
        while True:
            job_id = await self.queue.get()
            job = self.jobs.get(job_id)
            try:
                if job:
                    await asyncio.to_thread(self._render_job, job)
            finally:
                self.queue.task_done()

    def _render_job(self, job: Job) -> None:
        assert self.pipeline is not None
        last_error = "Unknown render error"
        for attempt in range(job.attempts + 1, MAX_ATTEMPTS + 1):
            self._update(
                job,
                status="processing",
                attempts=attempt,
                message=f"Loading MLX model for render attempt {attempt}/{MAX_ATTEMPTS}",
                error=None,
            )
            try:
                self.pipeline.set_mlx_profile(job.profile)
                source_path = str(Path(job.source_path).resolve())
                driving_audio_path = Path(job.audio_path or "").resolve() if job.mode == "audio" else None
                if job.mode == "text":
                    self._update(job, message="Synthesizing Vietnamese driving audio with Qwen TTS")
                    driving_audio_path = self._synthesize_qwen_tts(
                        job.text or "",
                        job.voice_name,
                        Path(job.source_path).parent / "qwen-driving.wav",
                    )
                self.pipeline._ensure_models_loaded(is_animal=False)
                self.pipeline._release_mlx_memory()
                self.pipeline.init_vars()
                args = {
                    "source": source_path,
                    "driving": str(driving_audio_path),
                    "flag_relative_motion": True,
                    "flag_do_crop": True,
                    "flag_pasteback": True,
                    "flag_stitching": True,
                    "animation_region": "all",
                    "cfg_scale": 4.0,
                }
                changed = self.pipeline.update_cfg(args)
                self._update(job, message="Generating JoyVASA motion and portrait frames")
                output_path, _, _ = self.pipeline.run_audio_driving(
                    str(driving_audio_path),
                    source_path,
                    save_dir=str(Path(job.source_path).parent),
                    update_ret=changed,
                    progress=None,
                )
                self._update(job, message="Normalizing MP4 to 1280x720 at 30 FPS")
                final_path = self._normalize_mp4(Path(output_path), Path(job.source_path).parent / "output-1280x720-30fps.mp4")
                output_duration = self._probe_media_duration(final_path)
                self._update(
                    job,
                    status="completed",
                    message="Completed",
                    output_path=str(final_path),
                    duration_seconds=round(output_duration, 2),
                )
                return
            except Exception as error:  # The retry is intentional: MLX can fail transiently under memory pressure.
                last_error = str(error)
                traceback.print_exc()
                if attempt < MAX_ATTEMPTS:
                    self._update(job, status="queued", message="Render failed; clearing MLX memory before retry", error=last_error)
                    try:
                        self.pipeline._park_mlx_models()
                    except Exception:
                        pass
                    continue
            finally:
                try:
                    self.pipeline._park_mlx_models()
                except Exception:
                    pass
        self._update(job, status="failed", message="Render failed after automatic retry", error=last_error)

    @staticmethod
    def _normalize_mp4(source: Path, output: Path) -> Path:
        command = [
            "ffmpeg", "-y", "-i", str(source),
            "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=30",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(output),
        ]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        return output

    @staticmethod
    def _probe_media_duration(path: Path) -> float:
        command = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nokey=1:noprint_wrappers=1",
            str(path),
        ]
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        try:
            duration = float(result.stdout.strip())
        except ValueError as error:
            raise RuntimeError(f"Could not read MP4 duration for {path}") from error
        if duration <= 0:
            raise RuntimeError(f"Generated MP4 has no playable duration: {path}")
        return duration


service = FasterLivePortraitService()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await service.start()
    try:
        yield
    finally:
        await service.stop()


app = FastAPI(title="AI Idol FasterLivePortrait MLX", version="1.0", lifespan=lifespan)
allowed_origins = [origin.strip() for origin in os.environ.get(
    "FASTER_LIVEPORTRAIT_ALLOWED_ORIGINS",
    "http://127.0.0.1:6767,http://localhost:6767,http://127.0.0.1:6768,http://localhost:6768",
).split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


async def save_upload(upload: UploadFile, destination: Path, maximum_bytes: int = 200 * 1024 * 1024) -> None:
    written = 0
    with destination.open("wb") as handle:
        while chunk := await upload.read(1024 * 1024):
            written += len(chunk)
            if written > maximum_bytes:
                handle.close()
                destination.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Uploaded file exceeds the 200 MB test limit")
            handle.write(chunk)


@app.get("/health")
async def health() -> dict[str, Any]:
    text_tts_ready, text_tts_message = await asyncio.to_thread(service.qwen_tts_health)
    return {
        "status": service.runtime_state,
        "message": service.runtime_message,
        "queued_jobs": service.queue.qsize(),
        "upstream_revision": UPSTREAM_REVISION,
        "upstream_root": str(VENDOR_ROOT),
        "output": {"width": 1280, "height": 720, "fps": 30},
        "modes": ["audio", "text"] if text_tts_ready else ["audio"],
        "text_to_speech": {"provider": "qwentts", "available": text_tts_ready, "message": text_tts_message},
        "profiles": list(MLX_PROFILE_CHOICES),
    }


@app.post("/api/jobs", status_code=202)
async def create_job(
    source: UploadFile = File(...),
    audio: UploadFile | None = File(None),
    text: str | None = Form(None),
    voice_name: str = Form("qwen-default"),
    profile: str = Form("quality"),
) -> dict[str, Any]:
    if profile not in MLX_PROFILE_CHOICES:
        raise HTTPException(status_code=422, detail=f"Unsupported MLX profile: {profile}")
    selected_text = (text or "").strip()
    if bool(audio and audio.filename) == bool(selected_text):
        raise HTTPException(status_code=422, detail="Provide exactly one driving source: audio or text")
    if selected_text:
        text_tts_ready, text_tts_message = await asyncio.to_thread(service.qwen_tts_health)
        if not text_tts_ready:
            raise HTTPException(status_code=503, detail=f"Text driving requires Qwen TTS: {text_tts_message}")
    if not source.filename:
        raise HTTPException(status_code=422, detail="A portrait image or source video is required")
    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    source_path = job_dir / f"source-{safe_name(source.filename, 'portrait.jpg')}"
    await save_upload(source, source_path)
    audio_path: Path | None = None
    if audio and audio.filename:
        audio_path = job_dir / f"audio-{safe_name(audio.filename, 'speech.wav')}"
        await save_upload(audio, audio_path)
    created = now_iso()
    job = Job(
        id=job_id,
        mode="audio" if audio_path else "text",
        source_path=str(source_path),
        audio_path=str(audio_path) if audio_path else None,
        text=selected_text or None,
        voice_name=safe_name(voice_name, "af_heart"),
        profile=profile,
        created_at=created,
        updated_at=created,
    )
    await service.submit(job)
    return {"job": service._serialize(job)}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = service.jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job": service._serialize(job)}


@app.get("/api/jobs/{job_id}/result")
async def get_result(job_id: str) -> FileResponse:
    job = service.jobs.get(job_id)
    if not job or not job.output_path:
        raise HTTPException(status_code=404, detail="Result is not available")
    path = Path(job.output_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Result file is missing")
    return FileResponse(path, media_type="video/mp4", filename=f"faster-liveportrait-{job.id}.mp4")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FasterLivePortrait MLX V2 worker")
    parser.add_argument("--host", default=os.environ.get("FASTER_LIVEPORTRAIT_HOST", "127.0.0.1"))
    parser.add_argument("--port", default=int(os.environ.get("FASTER_LIVEPORTRAIT_PORT", "8011")), type=int)
    arguments = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=arguments.host, port=arguments.port, log_level="info")
