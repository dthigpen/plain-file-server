# Actual Files Example Client

This is a local development/testing tool for the Actual Files API. It demonstrates authentication, file listing, reading, creating, updating, and deleting files with ETag handling.

**Note:** This is intended for local development and testing only. Since Actual Files is a dynamic API, this client needs to connect to a running server instance.

## Features

- JWT authentication with token persistence
- File listing and selection
- File reading with ETag extraction
- File updates with ETag validation (conflict detection)
- File creation and deletion
- Configurable server URL
- CORS support for cross-origin requests

## Local Testing

1. Start Actual Files:
   ```bash
   cd ..
   npm start
   ```

2. Open this HTML file in your browser:
   ```bash
   # Option 1: Open directly
   open example-client/index.html
   
   # Option 2: Use a simple HTTP server
   npx http-server example-client -p 8080
   # Then visit http://localhost:8080
   ```

3. Configure the server URL (default: `http://127.0.0.1:3000/api/v1`)

4. Login with your server credentials

5. Interact with files through the UI

## Security Notes

- This example client stores the JWT token in localStorage (for demonstration purposes only)
- The server URL is stored in localStorage
- For production applications, implement proper token storage and security measures
- Ensure your server has proper CORS configuration for production domains

## API Integration

The client demonstrates these API patterns using the versioned API base
`http://127.0.0.1:3000/api/v1`:

### Authentication
```javascript
const response = await fetch(`${API_BASE}/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password })
});
const { token } = await response.json();
```

### File Operations
```javascript
// Read file
const response = await fetch(`${API_BASE}/files/path/to/file.txt`, {
  headers: { 'Authorization': `Bearer ${token}` }
});
const content = await response.text();
const etag = response.headers.get('ETag');

// Update file with ETag
await fetch(`${API_BASE}/files/path/to/file.txt`, {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'If-Match': etag
  },
  body: JSON.stringify({ content: 'new content' })
});
```

## Building Your Own Client

You can use this example as a starting point for your own application:

- Change the UI styling and layout
- Add file type-specific editors (Markdown preview, etc.)
- Implement offline support with service workers
- Add conflict resolution UI for 412 errors
- Integrate with your existing authentication system
- Deploy alongside your server instance or as a separate application
