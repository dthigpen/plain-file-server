const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('../errors');
const { isDocumentAllowed } = require('../middleware/rules');
const { resolveDocumentPath } = require('./documentPath');

function atomicWrite(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.pfs-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw cleanupError;
      }
    }
    throw error;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseEntityTags(header) {
  const normalized = header.trim();
  if (normalized === '*') {
    return { wildcard: true, tags: [] };
  }

  const tags = [];
  let index = 0;
  while (index < normalized.length) {
    while (normalized[index] === ' ' || normalized[index] === '\t') {
      index += 1;
    }
    const start = index;
    if (normalized.startsWith('W/', index)) {
      index += 2;
    }
    if (normalized[index] !== '"') {
      throw new HttpError(400, 'Invalid entity tag header');
    }

    index += 1;
    while (index < normalized.length && normalized[index] !== '"') {
      const code = normalized.charCodeAt(index);
      if (code !== 0x21 && !(code >= 0x23 && code <= 0x7e) && !(code >= 0x80 && code <= 0xff)) {
        throw new HttpError(400, 'Invalid entity tag header');
      }
      index += 1;
    }
    if (normalized[index] !== '"') {
      throw new HttpError(400, 'Invalid entity tag header');
    }
    index += 1;
    tags.push(normalized.slice(start, index));

    while (normalized[index] === ' ' || normalized[index] === '\t') {
      index += 1;
    }
    if (index === normalized.length) {
      break;
    }
    if (normalized[index] !== ',') {
      throw new HttpError(400, 'Invalid entity tag header');
    }
    index += 1;
    if (index === normalized.length) {
      throw new HttpError(400, 'Invalid entity tag header');
    }
  }

  if (tags.length === 0) {
    throw new HttpError(400, 'Invalid entity tag header');
  }
  return { wildcard: false, tags };
}

function ifMatchSatisfied(header, etag, exists) {
  const parsed = parseEntityTags(header);
  return parsed.wildcard ? exists : parsed.tags.some(tag => tag === etag);
}

function ifNoneMatchSatisfied(header, etag) {
  const parsed = parseEntityTags(header);
  if (parsed.wildcard) {
    return true;
  }
  const current = etag.replace(/^W\//, '');
  return parsed.tags.some(tag => tag.replace(/^W\//, '') === current);
}

class FileService {
  constructor(config) {
    this.config = config;
    this.storageRoot = path.resolve(config.server.storageDir);
    this.historyRoot = path.resolve(config.server.historyDir || `${this.storageRoot}.history`);
    if (isWithin(this.storageRoot, this.historyRoot) || isWithin(this.historyRoot, this.storageRoot)) {
      throw new Error('historyDir and storageDir must be separate directories');
    }
    fs.mkdirSync(this.storageRoot, { recursive: true });
    this.storageRoot = fs.realpathSync(this.storageRoot);
    fs.mkdirSync(this.historyRoot, { recursive: true });
    this.historyRoot = fs.realpathSync(this.historyRoot);
    if (isWithin(this.storageRoot, this.historyRoot) || isWithin(this.historyRoot, this.storageRoot)) {
      throw new Error('historyDir and storageDir must be separate directories');
    }
    this.documentsRoot = path.join(this.historyRoot, 'documents');
    this.indexPath = path.join(this.historyRoot, 'index.json');
    fs.mkdirSync(this.documentsRoot, { recursive: true });
    this.index = this.loadIndex();
  }

  loadIndex() {
    try {
      const index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      if (!index || !index.documents || typeof index.documents !== 'object' || Array.isArray(index.documents)) {
        throw new Error('Invalid version history index');
      }
      return {
        ...index,
        documents: Object.assign(Object.create(null), index.documents)
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { documents: Object.create(null) };
      }
      throw new Error(`Unable to load version history: ${error.message}`);
    }
  }

  saveIndex() {
    atomicWrite(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`);
  }

  getDocumentDirectory(documentPath) {
    const key = crypto.createHash('sha256').update(documentPath).digest('hex');
    return path.join(this.documentsRoot, key);
  }

  getVersionPath(documentPath, version) {
    return path.join(this.getDocumentDirectory(documentPath), `${version}.txt`);
  }

  getMetadata(documentPath) {
    return Object.hasOwn(this.index.documents, documentPath)
      ? this.index.documents[documentPath]
      : undefined;
  }

  readVersion(documentPath, versionMetadata) {
    return fs.readFileSync(this.getVersionPath(documentPath, versionMetadata.version));
  }

  versionEtag(documentPath, version, content) {
    const hash = crypto.createHash('sha256');
    hash.update(documentPath);
    hash.update('\0');
    hash.update(String(version));
    hash.update('\0');
    hash.update(content);
    return `"${hash.digest('hex')}"`;
  }

  addVersion(documentPath, content) {
    let document = this.getMetadata(documentPath);
    if (!document) {
      document = { versions: [], deletedAt: null };
      this.index.documents[documentPath] = document;
    }

    const previous = document.versions.at(-1);
    if (previous && !document.deletedAt && this.readVersion(documentPath, previous).equals(content)) {
      return previous;
    }

    const version = previous ? previous.version + 1 : 1;
    const metadata = {
      version,
      etag: this.versionEtag(documentPath, version, content),
      timestamp: new Date().toISOString(),
      sizeBytes: content.length
    };
    atomicWrite(this.getVersionPath(documentPath, version), content);
    document.versions.push(metadata);
    document.deletedAt = null;
    this.saveIndex();
    return metadata;
  }

  markDeleted(documentPath) {
    const document = this.getMetadata(documentPath);
    if (document && !document.deletedAt) {
      document.deletedAt = new Date().toISOString();
      this.saveIndex();
    }
  }

  pathFor(documentPath) {
    return resolveDocumentPath(this.storageRoot, documentPath);
  }

  reconcileDocument(documentPath) {
    let filePath;
    try {
      filePath = this.pathFor(documentPath);
    } catch (error) {
      if (error.status === 403) {
        this.markDeleted(documentPath);
      }
      throw error;
    }

    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        this.markDeleted(documentPath);
        return null;
      }
      throw error;
    }

    if (!stat.isFile()) {
      throw new HttpError(400, 'Document path is not a file');
    }
    let content;
    try {
      content = fs.readFileSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        this.markDeleted(documentPath);
        return null;
      }
      throw error;
    }
    const version = this.addVersion(documentPath, content);
    return { filePath, content, version };
  }

  walkFiles(directory = this.storageRoot, parentPath = '', found = []) {
    let entries;
    try {
      entries = fs.readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return found;
      }
      throw error;
    }

    for (const name of entries) {
      const documentPath = parentPath ? `${parentPath}/${name}` : name;
      const targetPath = path.join(directory, name);
      let stat;
      try {
        stat = fs.lstatSync(targetPath);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
          continue;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        this.walkFiles(targetPath, documentPath, found);
      } else if (stat.isFile()) {
        found.push(documentPath);
      }
    }
    return found;
  }

  reconcile() {
    const existing = new Set(this.walkFiles());
    for (const documentPath of Object.keys(this.index.documents)) {
      if (!existing.has(documentPath)) {
        this.markDeleted(documentPath);
      }
    }
    for (const documentPath of existing) {
      if (isDocumentAllowed(documentPath, this.config.rules)) {
        this.reconcileDocument(documentPath);
      }
    }
  }

  getCurrent(documentPath) {
    const result = this.reconcileDocument(documentPath);
    if (!result) {
      throw new HttpError(404, 'Document not found');
    }
    return result;
  }

  getVersion(documentPath, version) {
    this.reconcileDocument(documentPath);
    const document = this.getMetadata(documentPath);
    const versionMetadata = document?.versions.find(item => item.version === version);
    if (!versionMetadata) {
      throw new HttpError(404, 'Document version not found');
    }
    return { content: this.readVersion(documentPath, versionMetadata), version: versionMetadata };
  }

  getHistory(documentPath) {
    this.reconcileDocument(documentPath);
    const document = this.getMetadata(documentPath);
    if (!document?.versions.length) {
      throw new HttpError(404, 'Document history not found');
    }
    return {
      deleted: Boolean(document.deletedAt),
      versions: document.versions.map(item => ({
        ...item,
        current: !document.deletedAt && item.version === document.versions.at(-1).version
      }))
    };
  }

  listFiles() {
    return this.walkFiles()
      .filter(documentPath => isDocumentAllowed(documentPath, this.config.rules))
      .sort();
  }

  write(documentPath, content, ifMatch) {
    const current = this.reconcileDocument(documentPath);
    if (current && !ifMatch) {
      throw new HttpError(428, 'If-Match is required to update an existing document', {
        currentETag: current.version.etag
      });
    }
    if (current && !ifMatchSatisfied(ifMatch, current.version.etag, true)) {
      throw new HttpError(412, 'Precondition Failed: Document has changed', {
        serverETag: current.version.etag,
        serverContent: current.content.toString('utf8')
      });
    }
    if (!current && ifMatch && !ifMatchSatisfied(ifMatch, null, false)) {
      throw new HttpError(412, 'Precondition Failed: Document does not exist');
    }

    const filePath = this.pathFor(documentPath);
    let mode = 0o666 & ~process.umask();
    if (current) {
      mode = fs.statSync(filePath).mode & 0o777;
    }
    atomicWrite(filePath, content, mode);
    const version = this.addVersion(documentPath, content);
    return version;
  }

  delete(documentPath, ifMatch) {
    const current = this.reconcileDocument(documentPath);
    if (!current) {
      throw new HttpError(404, 'Document not found');
    }
    if (ifMatch && !ifMatchSatisfied(ifMatch, current.version.etag, true)) {
      throw new HttpError(412, 'Precondition Failed: Document has changed', {
        serverETag: current.version.etag
      });
    }
    fs.unlinkSync(current.filePath);
    this.markDeleted(documentPath);
  }

  filesForListing() {
    this.reconcile();
    const files = [];
    for (const documentPath of this.listFiles()) {
      try {
        if (fs.lstatSync(this.pathFor(documentPath)).isFile()) {
          files.push(documentPath);
        }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
          this.markDeleted(documentPath);
          continue;
        }
        throw error;
      }
    }
    return files;
  }
}

module.exports = {
  FileService,
  parseEntityTags,
  ifMatchSatisfied,
  ifNoneMatchSatisfied,
  atomicWrite
};
