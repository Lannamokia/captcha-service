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

The admin console also manages challenge assets and integration credentials:

- Text wordlists contain one six-character uppercase alphanumeric value per line, with at least one letter and one digit. The asset editor can securely generate 100 unique entries in one click. Only active wordlists participate in challenge generation.
- Slider backgrounds are PNG, JPEG, or WebP images uploaded as data URLs. Only active backgrounds are selected.
- Disabling an asset removes it from new challenges without changing existing sessions. Site, secret, and asset changes create redacted security events.
- Secret rotation requires an explicit acknowledgement in the console because the old secret becomes invalid immediately.
- The credential test view signs the real HMAC session and redemption requests, runs either text recognition or slider interaction in the real widget, and reports the server-calculated browser trust score and deductions.

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

The session secret is placed in the iframe URL fragment. Only the non-secret session ID appears in the query string. Widget messages use protocol version `1` and one of `captcha.ready`, `captcha.resize`, `captcha.evaluated` (admin test sessions only), `captcha.completed`, `captcha.expired`, or `captcha.error`.

Every site implicitly trusts the origin of `PUBLIC_BASE_URL` so the management console can embed the widget in its credential test view. This management origin is returned separately as `adminOrigin`; `allowedOrigins` remains the operator-configured list, while `effectiveAllowedOrigins` is their de-duplicated union.

## Production

Production mode requires HTTPS, PostgreSQL, Redis, and explicit `SERVICE_MASTER_KEY` and `ADMIN_JWT_SECRET` values of at least 32 characters. `DATABASE_URL` must use `postgresql://` or `postgres://`; SQLite connections are rejected. Redis stores only short-lived replay-prevention keys and does not need persistence. Put the service behind a TLS reverse proxy. The widget response emits a per-site `frame-ancestors` policy based on the session's registered parent origin.

`GET /health` returns HTTP 200 only when both PostgreSQL and Redis respond. It returns HTTP 503 if either dependency is unavailable, so container and load-balancer health checks cannot report a partially functional instance as ready. The authenticated admin status endpoint reports both dependencies separately.

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
