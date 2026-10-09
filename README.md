# Plain File Server

Plain File Server is a small, self-hosted backend for applications that store
data in ordinary files. It gives applications a simple HTTP API for accessing
user-owned files, without requiring a proprietary database, cloud service, or
storage format.

**The application provides the functionality. You own the data.** Files remain
normal files that you can inspect, edit, back up, synchronize, or use with
other software. Applications can be replaced without trapping their data.

## What and why

In many apps, your data is tied to the app. Plain File Server keeps it in
ordinary files instead, so you can switch apps without leaving your data
behind:

```text
Your apps  --HTTP-->  Plain File Server  -->  your files
```

**One format, many apps:** a budget app can use `budget.txt`, a todo app
`todo.txt`, and a household recipe app `recipes.txt`. Scripts and text editors
can work with those same files, too. Inspect, edit, back up, or sync them with
tools you already use.

**The server handles the plumbing:**

- Authentication and path-based permissions
- Version history and change detection
- Optimistic concurrency, so clients can detect conflicting edits

**Your apps handle the meaning:** they choose the file format and decide how
to resolve conflicts. The server doesn't need to know whether a file contains
budgets, tasks, or notes. It provides the shared file API—not automatic
offline-client sync or application-specific merging.

## Requirements

- Node.js 20 or newer and npm when running from source
- Docker or Podman when running the container image
- A modern browser for the example client

## First-time setup

Run commands from the repository root:

```sh
npm ci
npm run setup
```

The interactive wizard hides password input, confirms the password, stores a
bcrypt hash, and generates a fresh random JWT signing secret. On first run it
guides you through the server address and port, document and history
directories, reconciliation interval, token lifetime, and initial admin
account. The first admin receives all four operations (`read`, `write`,
`delete`, and `history`) on all document paths. The wizard requires a
12-character minimum and a 72-byte maximum (bcrypt's input limit) for newly
entered passwords.

The wizard creates `config.json` with owner-only file permissions. The
repository tracks `config.example.json` as a reference, while `.gitignore`
excludes the live `config.json` so local credentials and secrets are not
accidentally committed. Run `npm run setup` before starting the server; never
commit your generated config, passwords, hashes, or signing secret.

### Reconfigure later

Run `npm run setup` again at any time. The menu lets you:

- Change the bind address, port, storage paths, filesystem scan interval,
  allowed browser origins (CORS), and proxy trust.
- Add users, change a user's password, manage their principal grants, or remove
  users.
- Grant access to an exact path such as `/budget.txt`, a subtree such as
  `/notes/*`, or all paths with `/*`. Select any combination of `read`,
  `write`, `delete`, and `history`; grants are additive.
- Change file rules, including allowed extensions, hidden files, exclusions,
  read-only patterns, and maximum write size.
- Change token lifetime or rotate the JWT secret. Secret rotation invalidates
  all currently issued login tokens.
- Review a redacted configuration summary and save, or exit without saving.

Prompts show the current value; press Enter to keep it. Menu edits remain
in-memory until you review and confirm saving. Passwords and hashes are never
shown in the review. To configure a separate integration account, use
**Users and permissions → Add login user**, then choose only the paths and
operations it needs.

To manage a configuration at another path:

```sh
npm run setup -- --config /path/to/config.json
```

Start the server with that same configuration using:

```sh
npm start -- --config /path/to/config.json
```

Without `--config`, the server reads `./config.json` relative to its working
directory.

The default storage directory is `./storage`, relative to the directory from
which the process starts. Storage and history paths can also be absolute or
home-relative, such as `~/syncthing/household`; `~` and `~/...` are expanded to
the server user's home directory. Version metadata and historical content are
stored separately; keep the history directory outside any directory managed
by Syncthing or another file synchronizer. The server creates both directories
when needed. Review `config.json` for file extensions, excluded paths,
read-only paths, size limits, and the filesystem reconciliation interval.

The extension policy menu supports unrestricted names (extensions optional),
any name that has an extension, extensionless names only, or extensionless
names plus a specific extension allowlist. In the config file these modes are
represented by `["*"]`, `[".*"]`, `[]`, or an explicit list such as
`[".txt", ".md"]`, respectively.

## Build and run the container locally

Build the image from this checkout on the machine that will run the service.
The build downloads the public `node:22-bookworm-slim` base image, then installs
the server's production npm dependencies into the local image. It does not
publish the image or require a GitHub Container Registry login.

```sh
podman build -t localhost/plain-file-server:latest .
```

For an initial setup, provide persistent config, document, and history
directories as mounts. The storage and history paths inside the container are
`/data` and `/history`; keep history outside any directory synchronized by
Syncthing.

```sh
mkdir -p config data history
podman run --rm -it \
  --userns=keep-id:uid=1000,gid=1000 \
  -v "$PWD/config:/config:Z" \
  -v "$PWD/data:/data:Z" \
  -v "$PWD/history:/history:Z" \
  localhost/plain-file-server:latest \
  npm run setup -- --config /config/config.json
```

In the wizard, bind to `0.0.0.0`, use `/data` for storage, and `/history` for
history. The `compose.yaml` example builds the image from the local checkout
and binds the API to host loopback so a local reverse proxy can reach it
without exposing it directly to the network. Its `keep-id` user namespace is
for rootless Podman; Docker Compose users can remove that setting:

```sh
podman compose up --build -d
curl http://127.0.0.1:3000/health
```

If `podman compose` is unavailable, the Podman Compose provider is not
installed; the direct `podman build` and `podman run` commands above do not
require it. For Docker, build with
`docker build -t localhost/plain-file-server:latest .` and use the equivalent
Docker commands. In rootless Podman, run as the account that owns the
persistent directories and preserve the `keep-id` user namespace so the
image's `node` user can write to them.

## Start the server

```sh
npm start
```

The server listens on `http://127.0.0.1:3000` by default. Check that it is
running:

```sh
curl http://127.0.0.1:3000/health
```

Expected response:

```json
{"status":"ok"}
```

The default host is loopback-only. Configure cross-origin access with
`server.allowedOrigins`:

- omit it to reflect any origin (permissive; a startup warning is logged);
- `["*"]` to allow all origins explicitly;
- `[]` to block cross-origin browser requests entirely;
- an exact list such as
  `["https://you.github.io", "https://host.tailnet.ts.net"]` to allowlist
  specific browser origins.

`server.corsMaxAge` (seconds) caches CORS preflight responses so polling
clients avoid a preflight per request. When running behind a reverse proxy
(nginx, Caddy, Tailscale Serve, etc.), set `server.trustProxy` so client IPs
and login rate limiting work correctly; it accepts `true`, a hop count, a
string such as `"loopback"`, or an array of proxy addresses, mirroring
Express's `trust proxy` setting. Use HTTPS and a trusted reverse proxy or
private network for remote access. The example client stores its JWT in browser
`localStorage` and is for local development only.

### Reaching the server over Tailscale (or another VPN)

- Set `server.host` to the tailnet interface address (or `0.0.0.0`, relying on
  the tailnet and firewall for exposure) instead of the loopback default.
- Terminate HTTPS with Tailscale Serve (or a reverse proxy with a certificate)
  so a browser on an HTTPS page can reach the API without mixed-content errors,
  and enable `server.trustProxy`.
- Add the web client's origin (for example a GitHub Pages URL) to
  `server.allowedOrigins`; the stable `https://host.tailnet.ts.net` origin from
  Tailscale Serve is convenient to allowlist.

## Try the API with curl

Use `/api/v1` for new clients. The unversioned `/api` paths remain available
as a compatibility alias for existing clients.

The following examples assume the default port and the admin username and
password you chose in the setup wizard. Log in and copy the returned token:

```sh
curl -sS http://127.0.0.1:3000/api/v1/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"your-setup-password"}'
```

Set `TOKEN` to the token from the login response, then list accessible files:

```sh
TOKEN='paste-token-from-login-response'

curl -i http://127.0.0.1:3000/api/v1/files \
  -H "Authorization: Bearer $TOKEN"
```

Create a new document. A new path starts at version 1 and does not need
`If-Match`:

```sh
curl -i -X PUT http://127.0.0.1:3000/api/v1/files/notes/today.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"First note\n"}'
```

Read the current document and note its `ETag` and `X-Version` response
headers:

```sh
curl -i http://127.0.0.1:3000/api/v1/files/notes/today.txt \
  -H "Authorization: Bearer $TOKEN"
```

Update an existing document with the exact ETag received from `GET`.
Paste the entire quoted value (for example, `"abc123..."`) into `ETAG`:

```sh
ETAG='"paste-the-entire-quoted-etag-here"'

curl -i -X PUT http://127.0.0.1:3000/api/v1/files/notes/today.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: text/plain' \
  -H "If-Match: $ETAG" \
  --data-binary 'Updated note'
```

If the document has changed since the ETag was read, the server returns
`412 Precondition Failed` rather than overwriting the newer content. Updating
an existing document without `If-Match` returns `428 Precondition Required`.
The server may also return 412 when creation includes an `If-Match` condition
that cannot be satisfied.

Check metadata without downloading the body, list history, and retrieve a
specific historical version:

```sh
curl -I http://127.0.0.1:3000/api/v1/files/notes/today.txt \
  -H "Authorization: Bearer $TOKEN"

curl -sS http://127.0.0.1:3000/api/v1/files/notes/today.txt/history \
  -H "Authorization: Bearer $TOKEN"

curl -i http://127.0.0.1:3000/api/v1/files/notes/today.txt/versions/1 \
  -H "Authorization: Bearer $TOKEN"
```

Set `ETAG` to the most recent ETag returned by `GET` or `PUT` to demonstrate a
304 response. An older ETag correctly receives the latest representation
instead:

```sh
curl -i http://127.0.0.1:3000/api/v1/files/notes/today.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "If-None-Match: $ETAG"
```

A match returns `304 Not Modified`. Deletion preserves history; `If-Match` is
optional for `DELETE`, but recommended:

```sh
curl -i -X DELETE http://127.0.0.1:3000/api/v1/files/notes/today.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "If-Match: $ETAG"
```

After deletion, current `GET` and `HEAD` return 404, while history and
historical-version requests remain available to principals with `history`.
External edits and deletions are reconciled into history during a path request
or the periodic scan.

The periodic scan defaults to once per minute. It checks filesystem metadata
for known files and reads content only when size or timestamps change.
Path-specific API reads still reconcile the requested file immediately.

## Test it with the example client

The example client is a small browser UI for login, listing files, reading,
creating, updating, and deleting. It does not currently expose the history or
historical-version endpoints; use the curl commands above to inspect those.

1. Start the API server in a terminal from the repository root:

   ```sh
   npm start
   ```

2. In a second terminal, serve the example client as a static page:

   ```sh
   python3 -m http.server 8080 --directory example-client
   ```

3. Open <http://127.0.0.1:8080> in your browser.
4. Leave the server URL set to `http://127.0.0.1:3000/api/v1` and click **Save
   Configuration** if you changed it.
5. Log in using the username and password you created in the setup wizard
   (the initial username defaults to `admin`).
6. Select an existing file from the list and click **Read File** before
   editing. The UI loads the current ETag; click **Update File** to send the
   edit conditionally. Refreshing or logging in again reloads the file list.
7. To create a document, enter a relative path such as
   `notes/from-browser.txt`, enter its content, then click **Create File**.
   Nested directories are created as needed. The path is relative to
   `storageDir`.
8. To remove a document, select it, read it to load its ETag, and click
   **Delete File**. Its version history remains on the server.

The client saves its server URL and JWT in `localStorage`. Click **Logout** or
clear this site's local storage when finished, especially on a shared browser.
If the page cannot reach the API, check that the server is running and that
its CORS policy allows the page's origin.

## Documents, paths, and limits

- API paths are logical paths below `storageDir`; use `/` between components.
  URL-encode special characters in a path component (for example, a space as
  `%20`).
- Traversal, encoded separators, backslashes, and symbolic links are rejected.
  Directories are not documents and cannot be read as files.
- Dotfiles, excluded patterns, extensions, read-only patterns, and maximum
  write size are governed by `config.json`.
- Existing files discovered on disk start at version 1. Content changes made
  through the API or directly on disk create later versions when observed.
- Polling records states the server observes; quick successive external edits
  between scans may be seen as one change.
- The server is content-agnostic. It does not parse document formats, merge
  edits, or understand Syncthing-specific operations.

See [SPEC.md](SPEC.md) for the complete configuration schema, HTTP behavior,
permissions, path rules, and lifecycle guarantees.

## Development

Install dependencies with `npm ci` and run the automated unit and integration
tests with:

```sh
npm test
```
