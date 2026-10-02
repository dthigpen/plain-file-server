const express = require('express');
const { authenticate } = require('../middleware/auth');
const { authorize, hasGrant } = require('../middleware/authorization');
const { validatePath } = require('../middleware/rules');
const { ifNoneMatchSatisfied } = require('../services/fileService');
const { getConfig } = require('../config');

function route(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function setVersionHeaders(res, version) {
  res.set('ETag', version.etag);
  res.set('X-Version', String(version.version));
}

function sendCurrent(req, res, fileService) {
  const result = fileService.getCurrent(req.documentPath);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  setVersionHeaders(res, result.version);

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatchSatisfied(ifNoneMatch, result.version.etag)) {
    return res.status(304).end();
  }

  res.set('Content-Length', String(result.content.length));
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }
  return res.status(200).send(result.content);
}

function createFileRoutes(fileService) {
  const router = express.Router();
  router.use(authenticate);

  router.get('/files', route((req, res) => {
    const files = fileService.filesForListing().filter(documentPath =>
      hasGrant({ grants: req.grants }, 'read', documentPath)
    );
    res.json({ files });
  }));

  router.get('/files/:path(.*)/history', validatePath(['history']), authorize('history'), route((req, res) => {
    res.json(fileService.getHistory(req.documentPath));
  }));

  router.get(
    '/files/:path(.*)/versions/:version',
    validatePath(req => ['versions', req.params.version]),
    authorize('history'),
    route((req, res) => {
      const versionNumber = Number(req.params.version);
      if (!/^[1-9]\d*$/.test(req.params.version) || !Number.isSafeInteger(versionNumber)) {
        return res.status(400).json({ error: 'Invalid version identifier' });
      }
      const result = fileService.getVersion(req.documentPath, versionNumber);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      setVersionHeaders(res, result.version);
      if (req.headers['if-none-match'] && ifNoneMatchSatisfied(req.headers['if-none-match'], result.version.etag)) {
        return res.status(304).end();
      }
      res.set('Content-Length', String(result.content.length));
      res.send(result.content);
    })
  );

  router.head('/files/:path(.*)', validatePath(), authorize('read'), route((req, res) => {
    sendCurrent(req, res, fileService);
  }));

  router.get('/files/:path(.*)', validatePath(), authorize('read'), route((req, res) => {
    sendCurrent(req, res, fileService);
  }));

  router.put('/files/:path(.*)', validatePath(), authorize('write'), route((req, res) => {
    const requestContent = typeof req.body === 'string' ? req.body : req.body?.content;
    if (typeof requestContent !== 'string') {
      return res.status(400).json({ error: 'Content must be a string' });
    }
    const content = Buffer.from(requestContent, 'utf8');
    const maxBytes = getConfig().rules.maxFileSizeMb * 1024 * 1024;
    if (content.length > maxBytes) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    const version = fileService.write(req.documentPath, content, req.headers['if-match']);
    setVersionHeaders(res, version);
    res.json({ success: true, version: version.version, etag: version.etag });
  }));

  router.delete('/files/:path(.*)', validatePath(), authorize('delete'), route((req, res) => {
    fileService.delete(req.documentPath, req.headers['if-match']);
    res.json({ success: true });
  }));

  return router;
}

module.exports = { createFileRoutes };
