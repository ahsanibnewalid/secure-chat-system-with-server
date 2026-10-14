# Secure Chat System

A cross-platform, self-hosted, UI-first **text chat** system. The server uses Node.js, HTTPS/WSS and SQLite; the responsive browser client works on desktop and mobile browsers.

## Desktop executable

The desktop shell adds a graphical server manager and a separate chat window. After installing the OS-specific package, a user can double-click **Secure Chat**, press **Start server**, then **Open local chat**—no terminal is required for normal start/stop. It can also open a remote HTTPS server in a client window.

- Windows: NSIS installer producing a Windows executable installer.
- Linux: AppImage and Debian package.
- Local only on `127.0.0.1:8443` is the default. The Server settings panel supports port changes, Local network mode, registration control, message-length limits and session lifetime.
- Server database, local TLS certificate and logs are stored in the current OS user's application-data folder.
- LAN mode shows private IP connection URLs, but Android/iOS browsers still need a certificate they trust. For internet access, use a public hostname with a publicly trusted certificate and correctly configured hosting/firewall.

See [Desktop executable builds](docs/DESKTOP-APPS.md) for packaging, security notes and limitations.

## Build the desktop app (developers)

Requires Node.js 20+ and npm. Build each OS on its own runner/machine.

```powershell
npm install
npm run check
npm test
npm run dist
```

Run `npm run desktop:dev` to test the desktop manager from source. Distributables are written to `release/`. GitHub Actions also builds Windows and Linux artifacts when manually dispatched or when a `v*` tag is pushed. Unsigned builds may display OS security warnings.

## Browser/server development

1. Install dependencies with `npm install`.
2. Follow [docs/SETUP.md](docs/SETUP.md) to configure a TLS certificate and environment variables.
3. Start the server for development with `node --env-file=.env src/server.js`.
4. Open the configured HTTPS URL in a browser that trusts the certificate.

Normal end users of the desktop package do not need to run these development commands.

## Security

- TLS 1.2+ required; the server refuses to start without a certificate and private key.
- Passwords use Node.js scrypt with per-account random salts.
- Random bearer session tokens are stored as SHA-256 hashes.
- Server-side authorization protects private history and admin routes.
- Message input and JSON request sizes are bounded; messages render as text, not HTML.
- No arbitrary shell-execution endpoint and no secrets embedded in the browser bundle.
- **No end-to-end encryption claim.** TLS protects transport between each client and server.
- The desktop app pins its generated certificate only for its own localhost client. Remote servers use normal Chromium certificate verification.

## Implemented API surface

All endpoints use the versioned `/api/v1` prefix.

- `GET /api/v1/health` — live process and database health.
- `GET /api/v1/protocol` — SCSP protocol version 1.0.
- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`.
- `GET /api/v1/me`, `GET /api/v1/users`.
- `GET /api/v1/messages/public`, `GET /api/v1/messages/private/:username`.
- Admin: `GET /api/v1/admin/metrics`, `GET /api/v1/admin/users`, `POST /api/v1/admin/users/:id/disable`, `GET /api/v1/admin/audit`.
- One-time initial admin creation: `POST /api/v1/admin/bootstrap` using the `X-Bootstrap-Token` header.

The WebSocket endpoint is `/ws` over WSS and requires a valid session token in the `scsp.<token>` subprotocol. Messages are persisted in SQLite; offline messages are retrieved through history APIs rather than pushed while a user is disconnected.

## Important limitations

This is a functional foundation, not yet the entire product roadmap. The desktop manager still does not include a guided admin-bootstrap wizard, automatic public TLS provisioning, an OS background-service installer, auto-updates, signed release binaries, native Android/iOS clients, or a complete web admin dashboard. The generated local certificate is self-signed and is not automatically trusted by external phones or browsers, even when LAN mode is enabled. For reliable mobile access, use a certificate/CA trusted by each client, or a public hostname with a publicly trusted certificate. Do not expose the default localhost server directly to the internet.

- [Setup and troubleshooting](docs/SETUP.md)
- [Desktop executable guide](docs/DESKTOP-APPS.md)
- [Roadmap and acceptance gates](docs/ROADMAP.md)
