# Architecture and data flow

Secure Chat is a self-hosted text messaging system. The browser/PWA and desktop chat window are clients; the Node.js service owns authentication, authorization, WebSocket messaging, notifications, and SQLite persistence.

## High-level architecture

```mermaid
flowchart LR
    subgraph Clients["Client devices"]
      Browser["Browser / installable PWA"]
      Desktop["Electron desktop manager + chat window"]
      Mobile["Android / iOS browser"]
    end
    subgraph Server["Self-hosted server"]
      TLS["HTTPS / TLS 1.2+"]
      API["Express REST API /api/v1"]
      WS["WebSocket endpoint /ws (WSS)"]
      Auth["Session auth + authorization"]
      Logic["Chat, users, admin, notifications"]
      DB[("SQLite database")]
      Push["Web Push service (optional VAPID)"]
    end
    Browser --> TLS
    Desktop --> TLS
    Mobile --> TLS
    TLS --> API
    TLS --> WS
    API --> Auth
    WS --> Auth
    Auth --> Logic
    Logic <--> DB
    Logic --> Push
    Push -. "browser/platform push" .-> Browser
    Push -. "where supported" .-> Mobile
```

## Message flow

```mermaid
sequenceDiagram
    participant C as Chat client
    participant S as HTTPS/WSS server
    participant A as Session authorization
    participant D as SQLite
    C->>S: Sign in over HTTPS
    S->>A: Verify credentials / create session
    A-->>S: Authorized session
    S-->>C: Session token
    C->>S: Connect WSS with session subprotocol
    S->>A: Validate session and permissions
    C->>S: Send text message
    S->>A: Check sender, target, size and rate limits
    S->>D: Persist message / unread state
    D-->>S: Commit
    S-->>C: Deliver to connected authorized recipient(s)
```

## Trust boundaries and storage

- **Client:** browser UI, local draft storage, optional permission-based device diagnostics. Treat all client-supplied values as untrusted.
- **Transport:** HTTPS/WSS protects traffic in transit. Use a hostname and certificate trusted by every connecting device.
- **Application:** server-side session validation, private-message authorization, input/size limits, and admin-route checks.
- **Persistence:** SQLite stores accounts, password hashes, sessions/related state, messages, audit/notification and opted-in device records as implemented by the current schema. Protect the data directory and backups with OS permissions.
- **Optional push:** Web Push requires HTTPS, explicit browser permission, and server-side VAPID keys. It is not native APNs/FCM.
- **Admin bootstrap:** a one-time secret creates the initial administrator; remove it from the environment and restart after use.

## Security boundaries (important)

This is not end-to-end encrypted: the server processes message content. TLS does not protect a compromised endpoint or server. A self-signed development certificate is not automatically trusted by phones. Do not expose a development instance to the public internet without a trusted certificate, firewalling, monitoring, backup/recovery procedures, and appropriate edge rate limiting.

## Operational health and reports

- Health endpoint: `GET /api/v1/health` (process and database reachability).
- Admin metrics: `GET /api/v1/admin/metrics`.
- Admin user inventory: `GET /api/v1/admin/users`.
- Admin audit events: `GET /api/v1/admin/audit`.
- Admin notification history: `GET /api/v1/admin/notifications`.

The repository includes a dashboard preview image in the README for orientation. It is an **illustrative mockup**, not a captured live session or a claim that a complete web admin dashboard exists. The current admin functionality is exposed through authenticated API routes; full web admin screens are not yet implemented.
