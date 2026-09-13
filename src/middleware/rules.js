const path = require('path');
const picomatch = require('picomatch');
const { getConfig } = require('../config');

function validateSinglePath(relativePath, config, method) {
  // 2. Dotfile Guard
  if (config.rules.ignoreDotfiles) {
    const pathSegments = relativePath.split(path.sep);
    if (pathSegments.some(segment => segment.startsWith('.'))) {
      return { status: 403, message: 'Dotfiles are not allowed' };
    }
  }
  
  // 3. Exclude Patterns
  const excludeMatcher = picomatch(config.rules.excludePatterns, { dot: true });
  if (excludeMatcher(relativePath)) {
    return { status: 403, message: 'Path matches exclude pattern' };
  }
  
  // 4. Extension Whitelist
  const ext = path.extname(relativePath);
  if (ext && !config.rules.allowedExtensions.includes(ext)) {
    return { status: 415, message: 'File extension not allowed' };
  }
  
  // 5. Permissions Check (for write operations)
  if (method === 'PUT' || method === 'DELETE') {
    const readOnlyMatcher = picomatch(config.rules.readOnlyPatterns, { dot: true });
    if (readOnlyMatcher(relativePath)) {
      return { status: 403, message: 'Path is read-only' };
    }
  }
  
  return null;
}

function validatePath(req, res, next) {
  const config = getConfig();
  let relativePath = req.params.path || req.body?.oldPath || req.body?.newPath || '';
  
  // Special case for GET /api/files (list files) - no path validation needed
  if (req.method === 'GET' && !relativePath && (req.path === '/api/files' || req.path === '/files' || req.route?.path === '/files')) {
    req.storagePath = path.resolve(config.server.storageDir);
    return next();
  }
  
  // For move operations, validate both paths
  if (req.body?.oldPath && req.body?.newPath) {
    const oldPath = req.body.oldPath;
    const newPath = req.body.newPath;
    
    const storageDir = path.resolve(config.server.storageDir);
    const fullOldPath = path.resolve(storageDir, oldPath);
    const fullNewPath = path.resolve(storageDir, newPath);
    
    // Path traversal guard for both paths
    if (!fullOldPath.startsWith(storageDir) || !fullNewPath.startsWith(storageDir)) {
      return res.status(403).json({ error: 'Path traversal detected' });
    }
    
    // Validate old path
    const oldPathError = validateSinglePath(oldPath, config, req.method);
    if (oldPathError) {
      return res.status(oldPathError.status).json({ error: oldPathError.message });
    }
    
    // Validate new path
    const newPathError = validateSinglePath(newPath, config, 'PUT');
    if (newPathError) {
      return res.status(newPathError.status).json({ error: newPathError.message });
    }
    
    req.storagePath = { old: fullOldPath, new: fullNewPath };
    req.relativePath = { old: oldPath, new: newPath };
    return next();
  }
  
  if (!relativePath) {
    return res.status(400).json({ error: 'Path is required' });
  }
  
  const storageDir = path.resolve(config.server.storageDir);
  const fullPath = path.resolve(storageDir, relativePath);
  
  // 1. Path Traversal Guard
  if (!fullPath.startsWith(storageDir)) {
    return res.status(403).json({ error: 'Path traversal detected' });
  }
  
  // 2-5. Validate path rules
  const pathError = validateSinglePath(relativePath, config, req.method);
  if (pathError) {
    return res.status(pathError.status).json({ error: pathError.message });
  }
  
  // 6. File Size Limit (for PUT operations)
  if (req.method === 'PUT' && req.headers['content-length']) {
    const contentLength = parseInt(req.headers['content-length'], 10);
    const maxSizeBytes = config.rules.maxFileSizeMb * 1024 * 1024;
    
    if (contentLength > maxSizeBytes) {
      return res.status(413).json({ error: 'Payload too large' });
    }
  }
  
  req.storagePath = fullPath;
  req.relativePath = relativePath;
  next();
}

module.exports = { validatePath };
