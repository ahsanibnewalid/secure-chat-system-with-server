# Delivery roadmap and acceptance gates

Status is deliberately conservative: a feature is complete only after its server behavior, authorization, automated tests, documentation and platform verification are all present.

| Stage | Scope | Status |
|---|---|---|
| 1 | Cross-platform server manager and setup wizard | Not complete; native Node server foundation and setup guide exist |
| 2 | Real metrics, health checks, authenticated local control | Partial; health and admin metrics APIs exist; local GUI control channel is not implemented |
| 3 | Account/session administration, backup/restore, audit | Partial; registration/login, account disable and audit API exist; session UI and backup validation/restore are not implemented |
| 4 | Authenticated web administration dashboard | Not complete; protected admin API exists, graphical dashboard does not |
| 5 | Responsive browser chat and protocol | Foundation implemented; requires automated integration, security and browser validation |
| 6 | Dedicated Android, Windows and Linux clients | Not implemented |
| 7 | Installers, upgrades, release validation | Not implemented |

## Required release gates

- [ ] Unit and integration tests cover auth, private/public routing, authorization, input limits, offline history, logout/revocation and persistence.
- [ ] TLS tests verify hostname and certificate validation; plaintext endpoints are rejected.
- [ ] Linux and Windows server execution tested independently without WSL.
- [ ] Browser tests cover desktop/mobile layouts, connection loss, reconnection and safe message rendering.
- [ ] Android, Windows and Linux dedicated clients pass the same protocol tests.
- [ ] Admin authorization and audit trails are tested for every privileged operation.
- [ ] Backup restore is tested against a disposable database and recovery instructions are verified.
- [ ] Dependency audit and secret scan pass.
- [ ] Installers are built and smoke-tested before publishing.

## Explicit behavior

Messages are persisted in SQLite. Offline messages are retrieved through history APIs, not pushed while a user is disconnected. Public messages are visible to authenticated users; private history is restricted to the two participants by server-side query. TLS protects transport; there is no end-to-end encryption claim.
