# Setup (Windows and Linux)

The server uses Node.js and SQLite so the same source runs natively on Windows and Linux. WSL is not required. Install a current Node.js LTS release (20 or newer) from https://nodejs.org/.

## 1. Install dependencies

From the repository directory:

```sh
npm install
```

## 2. Create a TLS certificate

For local testing, use OpenSSL (available from the OpenSSL project and many OS package managers). Replace `chat.example.test` with the DNS name clients will use. A self-signed certificate is only for development; clients must explicitly trust it.

```sh
mkdir -p certs
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 30 \
  -keyout certs/server-key.pem -out certs/server-cert.pem \
  -subj "/CN=chat.example.test" \
  -addext "subjectAltName=DNS:chat.example.test,IP:127.0.0.1"
```

Windows PowerShell can run the same OpenSSL command if OpenSSL is installed; create the `certs` directory first with `New-Item -ItemType Directory certs`. Do not expose the private key or commit certificates. For public hosting, use a certificate from a trusted CA and include the actual DNS name in its SAN.

## 3. Configure

Copy `.env.example` to `.env`, then set `TLS_KEY`, `TLS_CERT`, `HOST`, and `PORT` as needed. Node does not load `.env` automatically on every supported version: export variables in the service manager, or use Node's `--env-file=.env` option. Keep `HOST=127.0.0.1` until TLS, firewall, and admin access are configured. To allow other devices on the LAN, bind to the server's LAN address and permit the chosen TCP port in the firewall.

Generate a strong one-time admin bootstrap token (at least 24 characters), put it in the environment as `ADMIN_BOOTSTRAP_TOKEN`, and start the service:

```sh
node --env-file=.env src/server.js
```

Windows PowerShell:

```powershell
node --env-file=.env src/server.js
```

Open `https://127.0.0.1:8443` (or your configured DNS name). Browser certificate warnings mean the certificate is not trusted or does not match the host; do not bypass them for real accounts.

## 4. Create the first administrator

Use the one-time bootstrap endpoint from a trusted local machine. Replace values and use the exact host/certificate trust setup. Example:

```sh
curl --cacert certs/server-cert.pem -H "Content-Type: application/json" \
  -H "X-Bootstrap-Token: YOUR_LONG_BOOTSTRAP_TOKEN" \
  -d '{"username":"siteadmin","password":"replace-this-with-a-long-unique-password"}' \
  https://127.0.0.1:8443/api/v1/admin/bootstrap
```

The first successful call creates the administrator. Remove `ADMIN_BOOTSTRAP_TOKEN` from the service environment immediately and restart. Never put the token in browser code, source control, a URL, or a public issue. The web admin screens are not yet implemented; the authenticated admin API is available for integration.

## 5. Run as a service

For a reliable installation, configure a Windows Service using your organization's approved service wrapper, or a systemd unit on Linux. Run as a dedicated low-privilege OS account, grant it write access only to the data directory, restrict the port at the firewall, and keep Node and dependencies patched. Service-wrapper packaging and graphical setup wizard are planned, not yet included.

## Notifications and browser push

Notifications are stored in SQLite and survive sign-out/restart. Private messages create an unread notification for the recipient; the administrator can send an announcement to one account or all enabled accounts from the signed-in chat UI. Browser background push requires a secure HTTPS origin, user permission, and VAPID keys.

Generate VAPID keys with:

```sh
npx web-push generate-vapid-keys
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in the server environment. Keep the private key secret and never put it in browser code or source control. Restart the server, sign in, then select **Enable push notifications**. Without VAPID configuration, in-app unread notifications still work, but background push is disabled. Push delivery depends on the browser and platform's push service and may not be available in every embedded browser.

## Device diagnostics and privacy

The administrator can view aggregate user/online/message metrics and a device inventory only for users who explicitly opt in using **Share basic device diagnostics with server admin**. Collected fields include browser/OS identification, device category, screen dimensions, language, timezone, app version and last report time. The service does not automatically collect IP addresses, contacts, camera/microphone data, or precise location. Users may choose **Share location once** after opting in; location permission is requested by the browser. Battery telemetry is not collected by this build. Users can delete their device record using **Stop sharing device info**. Keep access to the admin API restricted and disclose telemetry practices to users.

Public-room unread counts are calculated per account from the last public message ID marked read; the current user’s own messages are excluded. The count is per account, not synchronized across devices beyond the server-side cursor.

## Mobile installation and push

The web client is installable as a PWA on compatible browsers. Browser Web Push works only where the browser/platform supports service workers and push, with HTTPS, permission, and VAPID keys configured. This is not the same as native APNs/FCM integration: native iOS/Android push delivery requires platform app packaging and Apple/Google credentials and is not included in this web-only build.

## Message tools

The chat UI supports replying by quoting a short excerpt into the outgoing message, searching messages currently loaded in the conversation, copying a message when the browser Clipboard API permits it, and saving drafts locally in the browser. Drafts are separated by signed-in account and conversation, remain on that browser, and are not synchronized to the server or other devices. A reply is a quoted text prefix, not a server-side threaded reply reference.

## Data, backup, and recovery

The SQLite database is `data/chat.sqlite` (with transient WAL files while running). Stop the server cleanly before copying the database for a simple consistent backup. Restore only a verified backup while the service is stopped, preserve restrictive filesystem permissions, then start and check `/api/v1/health`. Automated backup validation/restoration UI is not yet implemented. Keep backup copies encrypted and access-controlled.

## Troubleshooting

- **TLS certificate not found:** verify `TLS_KEY` and `TLS_CERT` paths relative to the current working directory.
- **Browser rejects TLS:** install/trust a certificate whose SAN matches the hostname; never disable verification.
- **Port in use:** choose a free port and update firewall/client URL.
- **Database errors:** ensure the service account can write to `DATA_DIR`; stop before manual database recovery.
- **Registration denied:** check `ALLOW_REGISTRATION`.
- **Health check:** `GET /api/v1/health` reports process uptime, live online count and database reachability.
