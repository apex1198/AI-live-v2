# Production deployment

The production stack keeps the browser dashboard, Node runtime, CUDA LiveTalking worker, TURN relay, and HTTPS proxy in separate services. Model weights and trained avatars stay on mounted volumes and are never copied into Git or Docker images.

## VPS requirements

- Ubuntu 22.04 or newer
- NVIDIA driver plus NVIDIA Container Toolkit
- Docker Engine with Compose v2
- A DNS name pointing to the VPS
- TCP 80, 443, 3478 and UDP 443, 3478, 49160–49200 open
- At least 24 GB VRAM for the validated MuseTalk/Qwen combination; use `LIVETALKING_MAX_SESSION=1` until GPU metrics prove more capacity

## Start

1. Copy `.env.production.example` to `.env` and replace every placeholder token, host, IP, TURN credential, and provider secret.
2. Put LiveTalking weights under `services/talking-head/livetalking/models` and trained avatars under `services/talking-head/livetalking/data/avatars`.
3. Start the stack with `docker compose -f docker-compose.production.yml up -d --build`.
4. Verify `https://YOUR_HOST/health`, then open `https://YOUR_HOST/` and enter the runtime access token when prompted.
5. For containerized Qwen, set `OLLAMA_ENDPOINT=http://ollama:11434`, start with `--profile local-ai`, then pull the configured model inside the Ollama container.

The LiveTalking HTTP API is private to the Compose network. WebRTC signaling goes through the authenticated runtime; media uses STUN/TURN. `/ready` is the worker readiness probe and authenticated `/metrics` exposes session/GPU gauges.
