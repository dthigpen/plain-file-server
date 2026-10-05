const fs = require('fs');
const path = require('path');
const { HttpError } = require('../errors');

function validDocumentSegment(segment) {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0') ||
    /^[a-zA-Z]:/.test(segment)
  ) {
    return false;
  }
  if (process.platform === 'win32') {
    return !segment.includes(':') &&
      !/[. ]$/.test(segment) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
  }
  return true;
}

function parseDocumentPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new HttpError(400, 'Document path is required');
  }

  const rawSegments = rawPath.split('/');
  const segments = rawSegments.map(segment => {
    if (segment === '') {
      throw new HttpError(400, 'Invalid document path');
    }

    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new HttpError(400, 'Invalid document path encoding');
    }

    if (!validDocumentSegment(decoded)) {
      throw new HttpError(400, 'Invalid document path');
    }
    return decoded;
  });

  return segments.join('/');
}

function rawDocumentPath(req, suffix = []) {
  const pathname = req.originalUrl.split('?')[0];
  const prefixes = ['/api/v1/files/', '/api/files/'];
  const prefix = prefixes.find(candidate => pathname.startsWith(candidate));
  if (!prefix) {
    throw new HttpError(400, 'Document path is required');
  }

  const rawPath = pathname.slice(prefix.length);
  let segments = rawPath.split('/');
  for (let index = suffix.length - 1; index >= 0; index -= 1) {
    if (segments.pop() !== suffix[index]) {
      throw new HttpError(400, 'Invalid document route');
    }
  }
  return parseDocumentPath(segments.join('/'));
}

function resolveDocumentPath(storageRoot, documentPath) {
  const root = fs.realpathSync(storageRoot);
  const segments = documentPath.split('/');
  let resolved = root;

  for (const segment of segments) {
    resolved = path.join(resolved, segment);
    let stat;
    try {
      stat = fs.lstatSync(resolved);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        continue;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new HttpError(403, 'Symbolic links are not allowed');
    }
    const relative = path.relative(root, fs.realpathSync(resolved));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new HttpError(403, 'Document path is outside the storage root');
    }
  }

  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HttpError(400, 'Invalid document path');
  }
  return resolved;
}

module.exports = { parseDocumentPath, rawDocumentPath, resolveDocumentPath, validDocumentSegment };
