# Secure Chat System

A cross-platform, self-hosted, UI-first **text chat** foundation. The server uses Node.js, HTTPS/WSS and SQLite, and is designed to run natively on Windows and Linux without WSL. The responsive browser UI supports modern desktop and mobile browsers.

> **Honest status:** this branch is a foundation, not the complete requested product. It includes a native Node server, browser chat, persistent public/private messaging, account login, presence, TLS-only startup, and initial authenticated admin APIs. The graphical server manager/setup wizard, web admin dashboard, backup/restore UI, session management UI, dedicated Android/Windows/Linux apps, installers, and end-to-end release validation remain incomplete.

## Security

- TLS 1.2+ required; startup refuses to run without a certificate and private key.
- Passwords use Node.js scrypt with per-account random salts.
- Random bearer session tokens are stored as SHA-256 hashes.
- Server-side authorization protects private history and admin routes.
- Message input and JSON request sizes are bounded; message text is rendered as text, not HTML.
- No arbitrary shell execution endpoint and no secrets embedded in the browser bundle.
- **No end-to-end encryption claim.** TLS protects transport between each client and server.

## Quick start

Requirements: Node.js 20+ and OpenSSL.

1. Install dependencies: `npm install`
2. Follow [docs/SETUP.md](docs/SETUP.md) to create/trust a TLS certificate and configure environment variables.
3. Start with `node --env-file=.env src/server.js` (PowerShell and Linux shells both supported).
4. Open the configured HTTPS URL in a browser that trusts the certificate.
5. Register a user and create the first administrator using the one-time bootstrap procedure in the setup guide.

Keep the default bind address at `127.0.0.1` until TLS, firewall rules and administrative access are configured. Never bypass certificate verification for real accounts.

## Implemented API surface

All endpoints use the versioned `/api/v1` prefix.

- `GET /api/v1/health` — live process and database health.
- `GET /api/v1/protocol` — SCSP protocol version 1.0.
- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`.
- `GET /api/v1/me`, `GET /api/v1/users`.
- `GET /api/v1/messages/public`, `GET /api/v1/messages/private/:username`.
- Admin: `GET /api/v1/admin/metrics`, `GET /api/v1/admin/users`, `POST /api/v1/admin/users/:id/disable`, `GET /api/v1/admin/audit`.
- One-time initial admin creation: `POST /api/v1/admin/bootstrap` using the `X-Bootstrap-Token` header. Remove the bootstrap token from the environment after successful setup.

The WebSocket endpoint is `/ws` over WSS and requires a valid session token in the `scsp.<token>` subprotocol. JSON client frames:

```json
{"type":"public.send","body":"Hello"}
{"type":"private.send","to":"username","body":"Hello privately"}
{"type":"ping"}
```

Server events include `connected`, `presence.list`, `message.new`, `pong`, and `error`. Messages are persisted in SQLite; offline messages are retrieved through history APIs rather than pushed while a user is disconnected.

## Test and validate

```sh
npm ci
npm run check
npm test
```

GitHub Actions is configured to test on Windows and Linux with Node.js 20 and 22. These checks must pass on the branch before merge; actual CI status is the authority for platform validation.

- [Setup and troubleshooting](docs/SETUP.md)
- [Roadmap and acceptance gates](docs/ROADMAP.md)

## Not yet delivered

No graphical local server manager, graphical admin dashboard, automated backup verification/restoration, dedicated native clients, signed installers, in-app upgrade flow, or complete integration/browser security test suite is included in this foundation. See the roadmap; do not treat a planned item as complete.
