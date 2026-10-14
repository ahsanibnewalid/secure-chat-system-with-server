# Desktop executable builds

The desktop package provides a graphical server manager and a separate chat window in one desktop application. Users can start/stop the local server and connect to a remote HTTPS chat server without opening a terminal. The browser client remains available for phones and other devices.

## Build locally

Requirements for developers only: Node.js 20+, npm, and a supported build machine. Windows installers should be built on Windows; Linux packages should be built on Linux.

1. Install dependencies with `npm install`.
2. Run `npm run check` and `npm test`.
3. Run `npm run desktop:dev` to test the desktop manager.
4. Run `npm run dist` to package for the current operating system.

The distributable is written to `release/`. Build artifacts are OS-specific; do not expect a Windows executable to run on Linux or vice versa. GitHub Actions can build Windows and Linux artifacts via Actions > Build desktop applications > Run workflow. Tag pushes beginning with `v` also trigger builds.

## Runtime behavior

- The manager creates a local self-signed certificate on first launch and stores it in the per-user application data folder.
- The default is Local only on `127.0.0.1:8443`. In Server settings, an administrator can change the port (1024–65535), switch to Local network mode, enable/disable registration, set message length, and set session lifetime. Settings persist in the app data folder. Stop the server before saving changes.
- The manager pins the generated local certificate for its own localhost chat window. This does not make that certificate trusted by external browsers or phones.
- To host for other devices, deploy with a trusted certificate whose DNS/IP Subject Alternative Name matches the address clients use, then configure a suitable network bind and firewall. The desktop manager now includes configurable port and LAN/local binding settings. LAN mode is still not equivalent to publicly trusted HTTPS: external browsers and phones must trust the certificate and use an address included in its SAN. Use a trusted public certificate for internet-facing hosting.
- The app's local server runs while the manager is open. Quitting the manager terminates the server; it is not installed as a Windows service or Linux system daemon.
- Server data is stored under the operating system's per-user application data directory, not next to the executable. Keep backups of that folder and restrict access.

### Windows firewall for same-Wi-Fi hosting

Only use a firewall rule on a trusted Private network. Run PowerShell as Administrator and replace `8443` if you configured another port:

```powershell
New-NetFirewallRule -DisplayName "Secure Chat LAN HTTPS" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private
```

Remove the rule when you no longer need LAN hosting:

```powershell
Remove-NetFirewallRule -DisplayName "Secure Chat LAN HTTPS"
```

A firewall rule does not make the self-signed certificate trusted. Guest Wi-Fi/client isolation may also block devices from reaching one another.

## Security and release notes

The desktop app does not disable TLS verification for arbitrary remote hosts. Only the locally generated certificate matching the local certificate fingerprint is trusted by the embedded client window. Remote HTTPS certificates use normal Chromium verification.

These builds are unsigned developer builds unless a release-signing identity is configured. Windows SmartScreen and Linux desktop environments may display warnings for unsigned applications. Review the source and build artifacts before deployment. Do not distribute the development self-signed certificate as a production certificate.

## Current limitations

This packages the current server and browser chat in a desktop shell. It is not a native Android/iOS app, does not include an auto-updater, and does not install a persistent OS service. The local bootstrap admin API still needs to be used through an authenticated setup flow; the graphical bootstrap wizard is not yet included. Keep the server bound to localhost until a secure hosting configuration flow is implemented.
