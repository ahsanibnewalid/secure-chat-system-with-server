# Threat Model and Hardening Baseline

## Assets to protect
- Password hashes, session-token hashes, and live session validity.
- Private messages and notification records.
- Administrator privileges and bootstrap credentials.
- TLS private keys, SQLite database and backups.
- Opt-in device diagnostics and any user-shared location.
- Availability of the HTTP API and WebSocket service.

## Trust boundaries
- Every browser/client is untrusted. Usernames, message bodies, device metadata, notification subscriptions, and location values are attacker-controlled inputs until validated server-side.
- A successful login does not grant administrator access. Administrative routes must check the server-side role.
- A WebSocket connection is authenticated at upgrade time; disabling an account revokes stored sessions and closes its active sockets.
- The host OS, deployment secrets, and trusted TLS endpoint are part of the trusted computing base.

## Implemented defensive controls
- Passwords are stored using per-password salts and Node.js scrypt; comparisons use constant-time comparison for equal-length hashes.
- Session tokens are random bearer secrets; only SHA-256 token hashes are stored in SQLite.
- TLS is required for server startup, with TLS 1.2 as the minimum.
- JSON request bodies and WebSocket frames are size-limited; WebSocket compression is disabled.
- Login, registration, bootstrap, push subscription, and admin announcements have a basic in-process request throttle. WebSocket sessions have a per-connection message limit and an account connection cap.
- Security headers include MIME sniffing protection, clickjacking protection, restrictive permissions policy, same-origin resource policy, and HSTS on direct HTTPS requests.
- Admin endpoints check the server-side administrator role. Device diagnostics require an explicit consent flag.
- Public-room unread counts use a cursor rather than generating a database notification and push request for every recipient on every public message.
- SQLite uses foreign-key enforcement and WAL mode. Administrative actions and failed login attempts are audited.

## Known gaps and deployment requirements
This baseline is not a guarantee that the service cannot be compromised or taken offline. It has not been independently audited.

- The request throttle is process-local, resets on restart, and is not sufficient against distributed attacks. Use a shared rate-limit service at the edge for public deployments.
- There is no distributed denial-of-service protection, upstream traffic scrubbing, or automatic incident response. Use a reputable reverse proxy/WAF, host firewall, connection limits, monitoring, and tested recovery procedures.
- Browser clients and reported device properties are not trusted hardware attestations.
- Browser push endpoint validation supports known push-provider hostnames, but push delivery still depends on external providers and browser behavior.
- Audit records are stored in the same SQLite database and are not tamper-proof. Export security logs to a separately controlled destination for stronger evidence preservation.
- A self-signed certificate is encrypted transport but not trusted identity. For remote users, configure a valid certificate chain and a stable hostname; never train users to ignore certificate warnings.
- The service is not end-to-end encrypted. The server can read stored message bodies. Do not describe it as E2EE unless a separately reviewed client-side encryption protocol is implemented.
- No MFA, hardware-backed authentication, external identity provider, formal threat-model review, or third-party penetration-test report is currently implied.
- No product can be made “unhackable.” The target is layered defenses, tested controls, detection, containment, and recovery.

## Lab exercise plan

Run only on a dedicated staging instance with synthetic users and disposable data.

1. Authentication: test invalid credentials, account enumeration behavior, request throttling, session expiry, logout, disabled users, and bootstrap replay.
2. Authorization: try to access other users' private messages, notification IDs, device IDs, push subscriptions, and admin endpoints with a normal account.
3. WebSocket: try missing/expired sessions, malformed JSON, oversized frames, unsupported message types, rapid message bursts, duplicate connections, and reconnect storms.
4. Input validation: test long usernames/passwords, Unicode boundaries, malformed URLs, invalid UUIDs, extreme dimensions, and out-of-range coordinates.
5. Availability: load-test with bounded concurrency; monitor CPU, memory, SQLite lock behavior, response latency, and shutdown/restart recovery.
6. Recovery: restore a backup into an isolated instance and verify users, messages, sessions, and audit data behave as documented.
7. Record each finding with severity, reproducible steps, expected/actual result, remediation, and retest evidence. Never claim a test passed without a recorded execution.

## Release gate

Before public exposure, require passing CI, dependency review, a staging smoke test, admin authorization tests, backup-restore evidence, trusted TLS, secret review, and an independent security review appropriate to the risk. High-risk findings should block release.
