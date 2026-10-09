# TODO / Improvement Backlog

Tracked improvements from a design review of the server. Ordered roughly by
priority. Items are phrased so an operator can tune how much security/trust the
deployment requires.

---

## 1. Configurable CORS origins — DONE

**Problem.** `src/index.js` uses `app.use(cors({ exposedHeaders: [...] }))`,
which emits `Access-Control-Allow-Origin: *` for every origin. There is no
config option to restrict origins, even though the README tells operators to
"restrict allowed origins in the server."

**Plan.**

- Add `server.allowedOrigins` to config and validation:
  - omitted → reflect any origin (current permissive behavior, logged at
    startup so the operator knows it is wide open);
  - `["*"]` → explicitly allow all origins;
  - `[]` → allow no cross-origin requests (same-origin / non-browser only);
  - `["https://example.github.io", "https://host.tailnet.ts.net"]` → exact
    origin allowlist.
- Add an optional `server.corsMaxAge` (seconds) to cache preflight responses;
  default to a sensible value so clients that poll (conditional refresh on
  focus/interval) are not sending a preflight per request.
- Keep `exposedHeaders: ['ETag', 'X-Version']` and the default reflected
  request headers so `If-Match` / `If-None-Match` keep working.

## 2. `trust proxy` configuration — DONE

**Problem.** The deployment story is "run behind an HTTPS reverse proxy," but
`app.set('trust proxy', ...)` is never set. `express-rate-limit` then keys on
the proxy's IP, so all clients share one bucket (one user can lock everyone
out) and `X-Forwarded-For` cannot be trusted. express-rate-limit v7 also warns
about this.

**Plan.**

- Add `server.trustProxy` to config and validation. Accept boolean, a hop
  count (integer >= 0), a string (e.g. `"loopback"`, a subnet), or an array of
  such strings — matching Express's `trust proxy` setting. Default `false`.
- Call `app.set('trust proxy', config.server.trustProxy)` when defined.

---

## Remaining backlog (not yet started)

### 3. Login endpoint leaks user existence via timing
`src/routes/authRoutes.js` returns immediately when the user is missing, so
`bcrypt.compareSync` only runs for real usernames (valid username = slow,
invalid = instant → user enumeration). Fix: always run a bcrypt compare
against a dummy hash and return the same generic error/timing.

### 4. Authenticated responses lack `Cache-Control`
`fileRoutes.sendCurrent` sets `ETag` but no `Cache-Control`. Private task data
served through a shared proxy could be cached by an intermediary. Add
`Cache-Control: no-store` (or `private, no-cache`) to file responses.

### 5. Conditional GETs still read + hash the whole file
`FileService.getCurrent` calls `reconcileDocument` without `skipUnchanged`, so
every GET (even one that returns 304) does a full `readFileSync` + SHA-256 and
may append a history version. Use a stat-first fast path: when `fileState` is
unchanged, reuse the cached version/etag and evaluate `If-None-Match` without
reading the body. The `skipUnchanged` plumbing already exists.

### 6. Minor hardening / cleanup
- Drop the unused global `express.urlencoded` parser; give `/login` a small
  JSON body limit instead of `maxFileSizeMb + 1` MB.
- Add basic security headers (`X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, frame protections) without necessarily pulling in helmet.
- Per-user token revocation (`tokenVersion`/`iat` check) so a single user can
  be logged out without rotating the shared JWT secret.
- Set the `ETag` response header (not just the body field) on 412 conflicts so
  clients can use standard conditional retries.

---

## Notes: Tailscale / tailnet access

Goal: reach the server over a tailnet (Tailscale/WireGuard/VPN) rather than the
public internet.

- Bind address: `server.host` defaults to `127.0.0.1` (loopback only). To serve
  over a tailnet, bind to the Tailscale interface IP or `0.0.0.0` (relying on
  the tailnet + firewall for exposure). No code change needed, just config.
- CORS: when the web client is served from a GitHub Pages origin but talks to a
  `*.ts.net` (or tailnet IP) API, that is cross-origin — add the client's
  origin to `server.allowedOrigins` (item 1). Using Tailscale Serve with HTTPS
  gives a stable `https://host.tailnet.ts.net` origin to allowlist.
- Reverse proxy: Tailscale Serve/Funnel terminates TLS and forwards to the app,
  so `server.trustProxy` (item 2) should be enabled for correct client IPs and
  rate limiting.
- Mixed content: a browser on an HTTPS page cannot call an `http://` API. Use
  Tailscale Serve's HTTPS (or a reverse proxy with a cert) so the API origin is
  also HTTPS.
