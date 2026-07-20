# Captcha Service

Independent, multi-site captcha service for the Subtitle Group Pipeline. It provides a compact iframe widget, an initialization/admin console, HMAC-authenticated integration APIs, environment scoring, text challenges, slider trajectory analysis, and one-time redemption tokens.

## Run locally

PostgreSQL is required for persistent application data. Redis is required for the five-minute HMAC nonce replay window. Start both services and configure their URLs before starting the application.

```bash
cp .env.example .env
npm install
npm run db:deploy
npm run build
npm start
```

Open `http://localhost:4100/admin` to initialize the first administrator. Create a site and record the returned site secret; it is shown once.

## Integration protocol

Server-to-server requests use these headers:

- `x-captcha-site-id`
- `x-captcha-timestamp`: Unix seconds, accepted within 60 seconds
- `x-captcha-nonce`: random value, rejected if reused within 5 minutes
- `x-captcha-content-sha256`: base64url SHA-256 of the exact request body
- `x-captcha-signature`: base64url HMAC-SHA256

The canonical signature input is:

```text
METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_DIGEST
```

The session secret is placed in the iframe URL fragment. Only the non-secret session ID appears in the query string. Widget messages use protocol version `1` and one of `captcha.ready`, `captcha.resize`, `captcha.completed`, `captcha.expired`, or `captcha.error`.

## Production

Production mode requires HTTPS, PostgreSQL, Redis, and explicit `SERVICE_MASTER_KEY` and `ADMIN_JWT_SECRET` values of at least 32 characters. `DATABASE_URL` must use `postgresql://` or `postgres://`; SQLite connections are rejected. Redis stores only short-lived replay-prevention keys and does not need persistence. Put the service behind a TLS reverse proxy. The widget response emits a per-site `frame-ancestors` policy based on the session's registered parent origin.

Set `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `PUBLIC_BASE_URL`, `SERVICE_MASTER_KEY`, and `ADMIN_JWT_SECRET` before starting Compose. Passwords embedded into Compose-generated connection URLs must be URL-safe.

```bash
docker compose up --build -d
```

## Verification

```bash
npm run typecheck
npm test
npm run build
docker compose -f compose.test.yml up --build --abort-on-container-exit --exit-code-from tests
docker build -t captcha-service .
```
