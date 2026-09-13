# Generic Text File Server Engine - Specification & Architecture

A lightweight, content-agnostic REST API server for reading, writing, creating, and managing plain-text files on a host system. 

This server acts as a remote web facade for local plain-text workflows (`todo.txt`, Markdown notes, plain text logs, etc.) alongside file synchronization tools like **Syncthing**. The server enforces zero assumptions about file content structures, delegating conflict management and presentation logic entirely to client applications.

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       Client Application                    │
│                                                             │
│   • Authenticates via JWT (/api/login)                      │
│   • Reads files with ETag tracking                          │
│   • Handles offline staging in localStorage / IndexedDB     │
│   • Resolves 412 Precondition Failed conflicts in UI        │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS (Tailscale / Caddy)
                               │ Authorization: Bearer <JWT>
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Node.js REST Server (Express / Fastify)    │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ 1. Config & Rule Matching Engine                    │   │
│   │    • Path Traversal Security Guard                  │   │
│   │    • Glob / Extension / Read-Only Filter Evaluation │   │
│   └──────────────────────────┬──────────────────────────┘   │
│                              │                              │
│   ┌──────────────────────────▼──────────────────────────┐   │
│   │ 2. ETag & Atomic I/O Engine                         │   │
│   │    • SHA-1 Hash Generation                          │   │
│   │    • If-Match Header Precondition Validation        │   │
│   │    • Temporary File (.tmp) Atomic Write + Rename    │   │
│   └─────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────┘
                               │ Local File System Operations
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Target Storage Directory on Host               │
│               (Background Syncthing Managed)                │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Core Operational Principles

1. **Content Agnosticism:** The server treats all target files as plain text bytes. It does not parse, transform, or validate file structures (no assumptions about `todo.txt`, Markdown syntax, or code format).
2. **Atomic Writes:** All file modifications write to a temporary file (`.tmp.[random]`) in the same directory before performing an atomic replace (`fs.rename`). This prevents corrupted or partially written files when Syncthing or other watchers read disk changes.
3. **Optimistic Guarding (ETags):** Read operations supply an `ETag` header (SHA-1 hash of the file content). Write operations (`PUT`) require an `If-Match: "<hash>"` header. If the file on disk changes prior to write execution, the server rejects the edit with HTTP `412 Precondition Failed`.
4. **Proxy-Friendly Security:** The server binds to `127.0.0.1` by default and delegates TLS termination to a local reverse proxy (Caddy, Nginx) or a zero-trust mesh network (Tailscale).

---

## 3. Configuration Specification (`config.json`)

On startup, the server loads a configuration file. Below is the full configuration schema:

```json
{
  "server": {
    "port": 3000,
    "host": "127.0.0.1",
    "storageDir": "./storage"
  },
  "auth": {
    "jwtSecret": "REPLACE_WITH_A_SECURE_RANDOM_SECRET_KEY",
    "tokenExpiryDays": 30,
    "users": [
      {
        "username": "admin",
        "passwordHash": "$2a$10$YourBcryptPasswordHashHere",
        "role": "admin",
        "allowedSubdirs": ["*"]
      }
    ]
  },
  "rules": {
    "ignoreDotfiles": true,
    "maxFileSizeMb": 10,
    "allowedExtensions": [".txt", ".md", ".org", ".json", ".csv", ".log", ".yaml", ".yml"],
    "excludePatterns": [
      "**/node_modules/**",
      "**/.git/**",
      "**/.sync/**",
      "**/private/**"
    ],
    "readOnlyPatterns": [
      "**/archive/**",
      "**/templates/**"
    ]
  }
}
```

### Path Evaluation Pipeline
When an API request targets a relative file path (e.g., `PUT /api/files/notes/todo.txt`), the server evaluates constraints in order:

1. **Path Traversal Guard:** Resolve `storageDir + path`. Reject with `403 Forbidden` if resolved path lies outside `storageDir`.
2. **Dotfile Guard:** If `ignoreDotfiles` is `true` and any segment starts with `.`, reject with `403 Forbidden`.
3. **Exclude Patterns:** Match against `excludePatterns` globs. Reject with `403 Forbidden` on match.
4. **Extension Whitelist:** Verify file extension against `allowedExtensions`. Reject with `415 Unsupported Media Type` if unlisted.
5. **Permissions Check:** For write operations (`PUT`, `DELETE`), match path against `readOnlyPatterns`. Reject with `403 Forbidden` on match.
6. **File Size Limit:** Check target payload size against `maxFileSizeMb`. Reject with `413 Payload Too Large` if exceeded.

---

## 4. API Endpoints Reference

All endpoints except `POST /api/login` require HTTP header `Authorization: Bearer <JWT_TOKEN>`.

### Authentication

#### `POST /api/login`
Authenticates user credentials and returns a signed JWT token.

* **Request Body:**
  ```json
  {
    "username": "admin",
    "password": "your_password"
  }
  ```
* **Success Response (200 OK):**
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresInDays": 30
  }
  ```
* **Error Response (401 Unauthorized):**
  ```json
  {
    "error": "Invalid username or password"
  }
  ```

---

### File Management

#### `GET /api/files`
Recursively lists all accessible text files inside `storageDir` matching rule criteria.

* **Success Response (200 OK):**
  ```json
  {
    "files": [
      "todo.txt",
      "done.txt",
      "notes/journal.md",
      "projects/ideas.txt"
    ]
  }
  ```

---

#### `GET /api/files/*path`
Retrieves raw file content and returns its current ETag.

* **Response Headers:**
  * `Content-Type: text/plain; charset=utf-8`
  * `ETag: "a1b2c3d4e5f6..."` (SHA-1 hash of content)
* **Success Response (200 OK):**
  Raw string payload of the file.
* **Error Responses:**
  * `404 Not Found`: File does not exist.
  * `403 Forbidden`: Path blocked by security rule.

---

#### `PUT /api/files/*path`
Creates a new file or updates an existing file using atomic write operations.

* **Request Headers:**
  * `Content-Type: application/json` or `text/plain`
  * `If-Match: "a1b2c3d4e5f6..."` (*Required for updates to existing files*)
* **Request Body (JSON format):**
  ```json
  {
    "content": "Updated file content goes here\n"
  }
  ```

* **Success Response (200 OK):**
  * **Headers:** `ETag: "f6e5d4c3b2a1..."` (New SHA-1 hash)
  * **Body:**
    ```json
    {
      "success": true,
      "etag": "\"f6e5d4c3b2a1...\""
    }
    ```

* **Conflict Error Response (412 Precondition Failed):**
  Occurs when the file on disk was modified since the client last fetched it.
  ```json
  {
    "error": "Precondition Failed: File on server has changed.",
    "serverETag": "\"f6e5d4c3b2a1...\"",
    "serverContent": "Current content on host disk...\n"
  }
  ```

---

#### `DELETE /api/files/*path`
Deletes a target file.

* **Request Headers:**
  * `If-Match: "a1b2c3d4e5f6..."` (*Optional but recommended*)
* **Success Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```
* **Conflict Error Response (412 Precondition Failed):**
  Returned if `If-Match` was supplied and file changed before deletion.

---

#### `POST /api/move`
Renames or relocates a file within the storage tree.

* **Request Body:**
  ```json
  {
    "oldPath": "notes/draft.md",
    "newPath": "notes/archive/draft.md"
  }
  ```
* **Success Response (200 OK):**
  ```json
  {
    "success": true
  }
  ```

---

## 5. Client Offline & Conflict Resolution Lifecycle

Clients implementing offline support must follow this operational flow:

```
                  ┌─────────────────────────────┐
                  │ Client performs offline edit │
                  └──────────────┬──────────────┘
                                 │
                                 ▼
                  ┌─────────────────────────────┐
                  │ Save pending edits to       │
                  │ localStorage / IndexedDB    │
                  └──────────────┬──────────────┘
                                 │
                         (Network Reconnects)
                                 │
                                 ▼
         ┌────────────────────────────────────────────────┐
         │ Send PUT /api/files/*path                      │
         │ Header: If-Match: <ORIGINAL_CACHED_ETAG>       │
         └───────────────────────┬────────────────────────┘
                                 │
                   ┌─────────────┴─────────────┐
                   │                           │
            [ Status 200 OK ]         [ Status 412 Failed ]
                   │                           │
                   ▼                           ▼
        (Update cached ETag)       1. Extract serverContent & serverETag
                                   2. Display side-by-side diff UI:
                                      • Remote (server) version
                                      • Staged (local) version
                                      • Combined editor output
                                   3. User resolves differences
                                   4. Client re-sends PUT with
                                      If-Match: <NEW_SERVER_ETAG>
```

---

## 6. Implementation Technical Stack Recommendations

* **Runtime:** Node.js (v20+ LTS)
* **Framework Options:**
  * **Express (v5):** Battle-tested, clean route handling, standard middleware ecosystem.
  * **Fastify:** High throughput, native JSON schema validation, lightweight footprint.
* **Security & Utility Packages:**
  * `jsonwebtoken` - JWT signing and verification.
  * `bcryptjs` - Password hash verification.
  * `picomatch` / `minimatch` - High-performance glob matching for `config.json` rules.
  * `express-rate-limit` - Rate limiting on `/api/login` to prevent brute-force attacks.

---

## 7. Recommended Repository File Structure

```
file-server/
├── config.json               # Local environment configuration & path rules
├── package.json              # Dependencies and scripts
├── README.md                 # Setup and run instructions
├── src/
│   ├── index.js              # Server entry point & HTTP listener
│   ├── config.js             # Configuration loader & validator
│   ├── middleware/
│   │   ├── auth.js           # JWT authentication middleware
│   │   └── rules.js          # Path traversal & policy evaluation rules
│   ├── services/
│   │   ├── fileService.js    # Atomic file I/O operations & ETag generation
│   │   └── authService.js    # Password hashing & JWT token issuance
│   └── routes/
│       ├── authRoutes.js     # /api/login endpoint
│       └── fileRoutes.js     # /api/files/* CRUD endpoints
└── scripts/
    └── generate-hash.js      # CLI helper to generate bcrypt password hashes
```
