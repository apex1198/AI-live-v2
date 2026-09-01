# Security setup

Provider credentials belong in a local `.env` file or the deployment secret manager. The dashboard never receives or stores them.

Before exposing the runtime outside the laptop:

1. Copy `.env.example` to `.env` and set a long random `RUNTIME_AUTH_TOKEN`.
2. Set an exact HTTPS dashboard origin in `CORS_ALLOWED_ORIGINS`.
3. Put the runtime behind an HTTPS reverse proxy; do not expose the LiveTalking worker directly.
4. Rotate any credential that was previously committed. Removing a value from the current files does not invalidate the old credential or erase Git history.

The server refuses to bind to a non-loopback host without `RUNTIME_AUTH_TOKEN`. Health endpoints remain public for deployment probes; all other REST APIs and WebSocket upgrades require authentication when a token is configured.
