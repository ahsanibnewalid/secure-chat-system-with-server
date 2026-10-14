# Browser Security Diagnostics

The optional **Browser Security Diagnostics** page is available at `/security-diagnostics.html` on the same Secure Chat server.

It is a defensive, non-invasive self-check inspired by modular browser-security assessment tools. It does not load remote exploit modules, hook browsers, execute arbitrary commands, capture keystrokes, or access a camera, microphone, or location in the background.

## Included checks

- HTTPS/local-development transport status and secure-context availability.
- Same-origin response-header inspection for `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`, `Permissions-Policy`, `Strict-Transport-Security`, and `Cache-Control`.
- Advisory browser capability report (user agent, clipboard API availability, battery API availability). It does not read battery level or request location.
- DOM reference review for HTTP mixed-content references and an inventory of external scripts.
- Authenticated session check using the current chat session.
- Best-effort admin audit-event view. Non-admin access should be denied by the server.
- Local JSON report export.

## How to use

1. Run Secure Chat and open `https://your-trusted-host/security-diagnostics.html` (or your local development origin).
2. Sign in through the normal chat page first if you want to verify the session or inspect admin audit events.
3. Select **Run checks again** after changing server/proxy configuration.
4. Export a JSON report if needed. Review it before sharing; it can contain the origin, browser user-agent, account name, and security-header values.

## Interpretation and limits

- A warning is a prompt for review, not automatically an exploitable vulnerability. Reverse proxies may add headers outside the Node.js process.
- Browser-reported information can be inaccurate or spoofed; it is not device attestation.
- The page only checks the current deployment and a few observable browser properties. It does not crawl the Internet, run exploit payloads, bypass same-origin protections, test arbitrary hosts, or certify security.
- The current application stores its bearer session token in `localStorage`. Successful same-origin XSS could expose it; continue to prioritize output encoding, strict CSP, dependency hygiene, and server-side authorization.
- This page is not a substitute for automated dependency scanning, a dedicated DAST scanner on an authorized staging target, or an independent penetration test.

## Safe lab extensions

For an authorized staging environment, the next useful additions are regression tests for security headers, access-control tests for every authenticated endpoint, WebSocket protocol fuzz tests using a local test account, dependency auditing, and a documented manual test checklist. Run these against disposable test data and avoid real users' sessions or devices.
