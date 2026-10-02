# Plain File Server — Specification

Plain File Server is a small, content-agnostic HTTP service for versioned text
documents stored as ordinary files on the host. Applications own document
meaning and merge behavior; the server owns document paths, access control,
current contents, immutable history, and optimistic concurrency.

The filesystem contains each current document in its normal location, so tools
such as Syncthing, editors, and shell commands can continue to use it. A
separate server-managed history directory records versions and metadata.

## 1. Principles and scope

- A document is identified by its logical path relative to the configured
  storage root.
- Document contents are opaque text bytes to the server. It does not interpret
  Markdown, budgets, tasks, or other application formats.
- Every observed content change creates an immutable, locally ordered version.
- ETags identify versions for HTTP caching and concurrency; clients treat them
  as opaque.
- Filesystem changes made outside the API are reconciled into the same version
  history as API writes.
- The server does not infer filesystem rename, copy, or move intent. A removed
  path is a deletion; a newly observed path is a new document.
- The initial design is single-server and does not implement distributed
  version graphs, CRDTs, application-specific merges, or federation.

The API provides file listing for compatibility and document operations for
read, write, delete, and history. It does not expose general filesystem
management operations such as move, copy, or directory creation.

## 2. Document and version lifecycle

### Current files and immutable versions

A document path has a sequence of versions numbered from 1. Each version
contains the exact bytes observed, a stable ETag, an ISO-8601 UTC timestamp,
and its byte length. Version numbers increase within the server's history for
that path; they are not distributed identifiers.

- A previously unknown file discovered on disk or created by `PUT` starts at
  version 1.
- A content change moves the former current version into history and records a
  new current version.
- Reconciliation of unchanged content does not create a version.
- A successful `PUT` with content identical to the current version does not
  create a duplicate version.
- The current file remains an ordinary file under `storageDir`. The history
  store is separate from that document tree and is not part of the public API.
- History persists across server restarts. The server loads its index and
  reconciles it with the filesystem at startup.

By default, `historyDir` is the resolved storage directory with `.history`
appended (for example, `./storage` uses `./storage.history`). Configure it
outside any directory managed by file synchronization. `historyDir` and
`storageDir` must not contain one another.

### External filesystem changes

At startup and periodically thereafter, the server scans the document tree.
Before a path-specific API operation, it also reconciles that path so the
request observes external changes without waiting for the next scan.

- New eligible file: create version 1.
- Changed file: record a new version if its bytes differ from the current
  version.
- Removed file: mark the document deleted and preserve all versions.
- Moved/renamed file: treat the old path as deleted and the new path as a
  separate document with its own history.
- Unchanged file: do nothing.

The default full-scan interval is 5 seconds and can be changed with
`server.reconcileIntervalMs`. Polling only guarantees that states observed by
the server are versioned; multiple edits between scans may be observed as one
change. Filesystem notifications, intermediate-state capture, and change
feeds are not part of this version.

### Deletion and recreation

Deletion is recorded as document metadata, not as a content version or
tombstone. A deleted document has no current representation: `GET` and `HEAD`
return 404, while history and historical versions remain available to
authorized clients.

If a file later reappears at the same logical path, it resumes that path's
version sequence. This preserves a simple path-based identity model without a
separate document ID. A moved file at a different path does not transfer its
history.

### Write and recovery behavior

API writes validate the request and concurrency condition, atomically replace
the current file using a temporary file in the same directory, then record the
new immutable version and metadata. Existing version snapshots are never
rewritten. If recording metadata fails after the file replacement, the
request fails; later reconciliation detects the filesystem contents and
records them. Startup reconciliation likewise repairs a filesystem/index
mismatch after an interrupted operation.

This is not a multi-resource transaction and does not promise immunity to
power loss, storage failure, or simultaneous writes by other local processes.
The server does not promise to capture every intermediate state of an
externally edited file.

## 3. Configuration

The server reads `config.json` from its working directory.

The repository tracks `config.example.json` as a configuration reference and
ignores the live `config.json` to reduce the risk of committing credentials or
secrets. Run `npm run setup` to create the initial `config.json` and
interactively configure credentials and a signing secret, or re-run it later
to edit server settings, users, grants, and file rules. Password entry is
hidden; newly entered passwords must contain at least 12 characters and no
more than 72 UTF-8 bytes (bcrypt's input limit). The wizard writes the
configuration with restrictive owner-only permissions.
A separate config file may be selected with
`npm run setup -- --config <path>` and loaded by the server with
`npm start -- --config <path>`.

```json
{
  "server": {
    "port": 3000,
    "host": "127.0.0.1",
    "storageDir": "./storage",
    "historyDir": "./storage-history",
    "reconcileIntervalMs": 5000
  },
  "auth": {
    "jwtSecret": "replace-with-a-long-random-secret",
    "tokenExpiryDays": 30,
    "users": [
      {
        "username": "admin",
        "passwordHash": "$2a$10$...",
        "principal": "admin"
      }
    ],
    "principals": {
      "admin": {
        "grants": [
          {
            "path": "/*",
            "operations": ["read", "write", "delete", "history"]
          }
        ]
      }
    }
  },
  "rules": {
    "ignoreDotfiles": true,
    "maxFileSizeMb": 10,
    "allowedExtensions": [".txt", ".md", ".org", ".json", ".csv", ".log", ".yaml", ".yml"],
    "excludePatterns": ["**/node_modules/**", "**/.git/**", "**/private/**"],
    "readOnlyPatterns": ["**/archive/**", "**/templates/**"]
  }
}
```

`storageDir` and `historyDir` may be relative to the process working directory,
absolute, or home-relative using `~` or `~/path` (for example,
`~/syncthing/household`). Home-relative paths are expanded to an absolute path
before use. Other `~name` forms are rejected. The server creates missing
directories. `reconcileIntervalMs` defaults to 5000 and must be at least 100
milliseconds.

Global rules apply independently of principal grants:

- `ignoreDotfiles` rejects any document path with a dot-prefixed component.
- Names beginning with the server-reserved `.pfs-tmp-` prefix are never
  exposed as documents; atomic-write temporary files use this namespace.
- `excludePatterns` reject matching paths for all operations.
- `allowedExtensions` controls filename extensions:
  - `["*"]` allows any extension and extensionless names.
  - `[".*"]` allows any name with an extension and rejects extensionless names.
  - `[]` allows extensionless names only.
  - An explicit list such as `[".txt", ".md"]` allows those extensions and
    extensionless names for backward compatibility.
  `*` and `.*` are reserved markers and must each appear alone. A rejected
  extension or a missing required extension returns 415.
- `readOnlyPatterns` reject `PUT` and `DELETE` for matching paths.
- `maxFileSizeMb` limits the decoded content of a write.

## 4. Authentication and authorization

### Authentication

`POST /api/login` authenticates a configured username and bcrypt password hash
and returns a signed JWT. The JWT identifies a principal; credentials are not
the authorization policy. Login is rate limited. Requests to file endpoints
must include `Authorization: Bearer <token>`.

Authentication failure returns 401. `GET /health` and `POST /api/login` do not
require a token.

### Principals and grants

A user maps to a principal through `users[].principal` (or to a principal
with the same name when omitted). A principal has additive grants. Each grant
contains a logical path scope and one or more operations:

- `read`: current-file `GET`, `HEAD`, and access to the file listing.
- `write`: create or update using `PUT`.
- `delete`: delete using `DELETE`.
- `history`: list history or retrieve historical versions.

An exact scope such as `/budget.txt` matches only that document. A recursive
scope such as `/household/*` matches documents beneath that directory, at any
depth. `/*` matches every document. No other wildcard or pattern syntax is
supported. If multiple grants match, their operations are combined
additively; there are no deny rules. Read, write, delete, and history do not
imply one another.

A valid principal without the required operation receives 403. Authorization
uses the validated logical document path and occurs before filesystem
contents are returned or changed.

For existing configurations without `auth.principals`, legacy
`users[].allowedSubdirs` values are treated as recursive scopes granting the
four supported operations; `["*"]` grants all paths. New configurations
should use explicit principals and grants. The old `role` field has no special
authorization behavior.

## 5. Document paths and filesystem boundary

The path after `/api/files/` is a URL representation of a logical document
path, not a filesystem path. `/` separates components. Each component is
percent-decoded as UTF-8 before validation; query strings are not part of the
path, and URL fragments are never sent to the server. Ordinary Unicode names
are preserved without Unicode normalization.

The server rejects empty components, `.` and `..`, decoded `/` or `\\`,
NUL, drive-prefixed components such as `C:`, malformed encoding, and encoded
separators such as `%2F` and `%5C`. Absolute paths and traversal are not
accepted. Backslashes are not document separators. A request using an unsafe
path receives 400.

Every existing component is checked for symbolic links; symlinks in the final
file or an intermediate directory are rejected with 403. The resolved target
must remain beneath the canonical storage root. This applies to current-file,
history, version, and mutation endpoints. There is no directory listing
endpoint: a directory is not a document and a request to read one returns 400.
Platform-specific invalid filenames may be unavailable on the host filesystem.

The history suffix routes reserve terminal `/history` and
`/versions/{number}` patterns. To address an ordinary document whose path
would otherwise match one of those routes, percent-encode the first character
of the reserved terminal component (for example, use `%68istory` for a file
whose last component is literally `history`).

## 6. HTTP API

All routes below are under `/api`. File routes require authentication and the
operation-specific grant. JSON error responses have an `error` field; some
conditional-write errors also include current server metadata.

### Login

`POST /api/login`

Request JSON:

```json
{"username":"admin","password":"your-password"}
```

Success (200):

```json
{"token":"<jwt>","expiresInDays":30}
```

Missing credentials return 400; invalid credentials return 401.

### List eligible files

`GET /api/files` requires authentication. It returns
`{"files":["notes/today.md"]}` containing eligible current document paths for
which the principal has `read`. Paths hidden by global rules are omitted.

### Read the current document

`GET /api/files/{path}` and `HEAD /api/files/{path}` require `read`.

`GET` returns the current file bytes as `text/plain; charset=utf-8`.
`HEAD` returns the same status and metadata without a body. Both return:

- `ETag`: quoted opaque entity tag.
- `X-Version`: current local version number.
- `Content-Length`: byte length of the current representation.

`If-None-Match` is supported on both methods. A matching tag or `*` returns
304 with no body; otherwise the current representation is returned normally.
Current-file reads reconcile the path with the filesystem before responding.

Missing and deleted documents return 404. Directories return 400; paths
rejected by dotfile/exclusion rules or authorization return 403; disallowed
extensions return 415; unsafe paths return 400.

### Create or update a document

`PUT /api/files/{path}` requires `write`. The body may be raw `text/plain`
text or JSON of the form `{"content":"..."}`. A successful request returns
200 with a JSON body containing `success`, `version`, and `etag`; it also
returns the new `ETag` and `X-Version` headers.

- Creating a path with no current file creates version 1. A write may include
  `If-Match` only if the resource exists; any `If-Match` condition fails when
  the resource does not exist.
- Updating an existing file requires `If-Match`. Missing header returns 428.
- A matching strong tag or `If-Match: *` allows the update. A nonmatching or
  weak tag returns 412.
- A failed precondition does not overwrite the current file. The 412 response
  includes `serverETag` and `serverContent` for a stale update.
- Content identical to the current version succeeds without creating a
  duplicate version.
- A write larger than `maxFileSizeMb` returns 413.

### Delete a document

`DELETE /api/files/{path}` requires `delete`. `If-Match` is optional for
compatibility; when supplied, it must strongly match the current ETag or the
request returns 412. Deletion returns `{"success":true}`. Missing documents
return 404. The current file is removed, but all content versions remain
available through history. Deletion does not consume a version number.

### List document history

`GET /api/files/{path}/history` requires `history`. It returns versions in
ascending version order:

```json
{
  "deleted": false,
  "versions": [
    {
      "version": 1,
      "etag": "\"opaque-tag\"",
      "timestamp": "2026-09-29T12:00:00.000Z",
      "sizeBytes": 123,
      "current": false
    }
  ]
}
```

The current version has `current: true` while the document exists; a deleted
document has no current version. A known deleted document still has accessible
history. A path with no recorded versions returns 404.

### Retrieve a historical version

`GET /api/files/{path}/versions/{version}` requires `history`, where `version`
is a positive decimal integer. It returns the exact stored bytes as
`text/plain; charset=utf-8`, with that version's `ETag`, `X-Version`, and
`Content-Length`. `If-None-Match` returns 304 when it matches. An unknown
version returns 404; malformed identifiers return 400.

### ETag and version contract

ETags are quoted, opaque SHA-256-based tags tied to a document path, version,
and content. A tag is stable for a version and changes when a new version is
created, including when a deleted path is recreated with identical content.
Clients must not derive a version number from an ETag or vice versa.

`If-Match` uses strong comparison for writes. `If-None-Match` uses weak
comparison for reads. Tags may be supplied as a comma-separated list where
applicable. `*` matches an existing representation.

## 7. Deferred work and explicit non-goals

The current implementation stops at core versioning, version/history
endpoints, logical-path safety, and principal-based authorization. The
following remain future work, to be justified by a real client:

- A generic change feed and resumable synchronization cursor.
- A real client integration and offline/local-first synchronization behavior.
- More efficient filesystem notifications; polling remains the correctness
  mechanism.
- Version retention/pruning, history-store migrations, and administrative
  recovery tools.
- Multi-server federation, distributed identities, revision graphs, vector
  clocks, CRDTs, and distributed conflict resolution.
- Additional credential types, capability tokens, OAuth/OIDC, role hierarchies,
  or deny rules.
- Filesystem move/copy/directory APIs, bulk operations, search, or
  application-specific endpoints and merge logic.

The current design deliberately uses path-based document identity, observes
only filesystem states it actually scans, keeps deletion separate from content
versions, and makes matching grants additive. Revisit these choices only when
a concrete requirement demonstrates a need to change them.
