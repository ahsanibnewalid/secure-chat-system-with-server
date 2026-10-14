# Security Operations and Lab Guide

This guide describes the defensive security baseline for Secure Chat. It is a practical hardening guide, not a claim of certification or a substitute for an independent penetration test.

## Security objectives

- Protect credentials and session tokens; never log passwords, authorization headers, push private keys, or raw session tokens.
- Enforce authorization on the server for every private message, device record, notification, and administrative operation.
- Make device diagnostics opt-in and show users what is being shared.
- Keep security-relevant audit events useful for incident investigation.
- Prefer secure defaults and fail closed when TLS or administrator bootstrap configuration is incorrect.

## Before exposing a server to the Internet

1. Put the service behind a trusted TLS endpoint or configure a trusted certificate. Do not ask users to bypass browser certificate warnings.
2. Use a unique, long administrator password and keep `ADMIN_BOOTSTRAP_TOKEN` out of shell history and source control. Remove it from the environment immediately after the first administrator is created.
3. Keep the database directory and TLS private key readable only by the service account and administrators. Back up the database securely and test restoration.
4. Set `ALLOW_REGISTRATION=false` after intended accounts have been created, unless open registration is a deliberate requirement.
5. Configure Web Push VAPID keys only if browser push is needed. Store the private key in the deployment secret manager, not in the repository.
6. Use a firewall to expose only the intended service port. Do not expose SQLite files, logs, development tools, or the desktop manager's local control interface to the public network.
7. Keep Node.js and dependencies updated. Review dependency changes and run `npm ci`, `npm test`, and `npm run check` before release.
8. Test the exact release on a staging instance before upgrading a live server.

## Authentication and abuse controls

The login, registration, and initial-admin bootstrap endpoints have an in-process per-source-address request throttle. It is intentionally a lightweight baseline: its counters reset on restart and are not shared between multiple Node processes. For multi-instance or high-traffic deployments, use a shared rate-limit store and add alerting and operational controls. Do not trust arbitrary `X-Forwarded-For` headers; only enable proxy-aware client IP handling when the trusted proxy chain is explicitly configured.

Use unique credentials, rotate compromised passwords, disable unused accounts, and revoke sessions when an account is disabled or suspected to be compromised. Failed login attempts are audit events; protect and periodically review audit data.

## Device diagnostics and privacy

The server can only receive the browser fields that the client sends. Browser/OS identification is best-effort and can be inaccurate or spoofed. Screen dimensions, timezone, language, and app version are diagnostics, not proof of identity. Battery and location data must remain optional, permission-gated, and clearly indicated in the UI. Never infer consent from merely opening the chat.

Do not collect phone numbers, hardware serial numbers, contacts, microphone/camera data, or precise location as a hidden background operation. If a lab needs a new data category, document its purpose, retention period, access controls, and explicit consent flow before implementing it. Provide a way for a user to stop sharing and delete their device record.

## Incident response checklist

1. Disable the affected account and stop new registrations if account takeover is suspected.
2. Revoke sessions and rotate any exposed credentials or VAPID secrets.
3. Preserve relevant audit logs and the database using access-controlled copies; record timestamps and who handled the evidence.
4. Check for unusual login failures, unexpected admin actions, mass announcements, and unexpected device registrations.
5. Patch the cause, restore from a known-good backup if needed, and verify recovery in staging.
6. Document the timeline, scope, actions taken, and follow-up prevention work.

## Authorized security testing

Run security tests only against systems you own or have explicit permission to assess. Prefer a disposable staging database and test accounts. Useful checks include:

- Authentication: invalid credentials, throttling, expired sessions, logout, disabled accounts.
- Authorization: a normal user must not read another user's private messages, notifications, device records, or admin endpoints.
- WebSocket: invalid/missing sessions, oversized payloads, malformed JSON, unsupported message types, rapid message bursts, and reconnect behavior.
- Data validation: very long strings, invalid IDs, invalid location coordinates, and malformed push subscription objects.
- Operations: TLS validation, backup restoration, graceful shutdown, and recovery after process restart.

Record the exact commit, environment, test procedure, expected result, and observed result. Do not describe a test as passed unless it was actually executed.

## Current implementation limits

- The built-in abuse throttle is in-memory and per process; it is not distributed rate limiting.
- Client-supplied device metadata is not attestation and may be spoofed.
- Browser push requires HTTPS, user permission, and valid VAPID configuration. Native APNs/FCM delivery is not included.
- Browser APIs differ across platforms; battery telemetry may not be supported.
- A security dashboard is not an EDR agent and cannot inspect arbitrary processes, files, installed applications, or hardware identifiers on a user's device.
- No compliance certification, formal security audit, or independent penetration-test result is implied by this repository.

