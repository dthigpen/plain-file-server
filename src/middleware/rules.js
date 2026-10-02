const path = require('path');
const picomatch = require('picomatch');
const { getConfig } = require('../config');
const { HttpError } = require('../errors');
const { rawDocumentPath, validDocumentSegment } = require('../services/documentPath');

function isDocumentAllowed(documentPath, rules) {
  const segments = documentPath.split('/');
  if (segments.some(segment => !validDocumentSegment(segment))) {
    return false;
  }
  if (segments.some(segment => segment.toLowerCase().startsWith('.pfs-tmp-'))) {
    return false;
  }
  if (rules.ignoreDotfiles && segments.some(segment => segment.startsWith('.'))) {
    return false;
  }

  if (rules.excludePatterns?.length && picomatch(rules.excludePatterns, { dot: true })(documentPath)) {
    return false;
  }

  return extensionRuleError(documentPath, rules) === null;
}

function extensionRuleError(documentPath, rules) {
  const extension = path.posix.extname(documentPath);
  const allowedExtensions = rules.allowedExtensions;

  if (allowedExtensions.includes('*')) {
    return null;
  }
  if (allowedExtensions.includes('.*')) {
    return extension ? null : { status: 415, message: 'A file extension is required' };
  }
  if (!extension || allowedExtensions.includes(extension)) {
    return null;
  }
  return { status: 415, message: 'File extension is not allowed' };
}

function pathRuleError(documentPath, rules) {
  const segments = documentPath.split('/');
  if (segments.some(segment => segment.toLowerCase().startsWith('.pfs-tmp-'))) {
    return { status: 403, message: 'Reserved temporary file path' };
  }
  if (rules.ignoreDotfiles && segments.some(segment => segment.startsWith('.'))) {
    return { status: 403, message: 'Dotfiles are not allowed' };
  }
  if (rules.excludePatterns?.length && picomatch(rules.excludePatterns, { dot: true })(documentPath)) {
    return { status: 403, message: 'Document path is excluded' };
  }
  return extensionRuleError(documentPath, rules);
}

function validatePath(suffix = []) {
  return (req, res, next) => {
    try {
      const config = getConfig();
      const routeSuffix = typeof suffix === 'function' ? suffix(req) : suffix;
      const documentPath = rawDocumentPath(req, routeSuffix);
      const ruleError = pathRuleError(documentPath, config.rules);
      if (ruleError) {
        throw new HttpError(ruleError.status, ruleError.message);
      }

      if (
        ['PUT', 'DELETE'].includes(req.method) &&
        config.rules.readOnlyPatterns?.length &&
        picomatch(config.rules.readOnlyPatterns, { dot: true })(documentPath)
      ) {
        throw new HttpError(403, 'Document is read-only');
      }

      req.documentPath = documentPath;
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { extensionRuleError, isDocumentAllowed, pathRuleError, validatePath };
