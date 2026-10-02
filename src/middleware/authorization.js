function hasGrant(principal, operation, documentPath) {
  const target = `/${documentPath}`;
  return principal.grants.some(grant => {
    if (!grant.operations.includes(operation)) {
      return false;
    }
    if (grant.path === '/*') {
      return true;
    }
    if (grant.path.endsWith('/*')) {
      const prefix = grant.path.slice(0, -1);
      return target.startsWith(prefix) && target.length > prefix.length;
    }
    return grant.path === target;
  });
}

function authorize(operation) {
  return (req, res, next) => {
    if (!hasGrant({ grants: req.grants }, operation, req.documentPath)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { authorize, hasGrant };
