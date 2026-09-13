const express = require('express');
const { authenticate } = require('../middleware/auth');
const { validatePath } = require('../middleware/rules');
const { readFile, writeFileAtomic, deleteFile, moveFile, listFiles, generateETag } = require('../services/fileService');
const { getConfig } = require('../config');

const router = express.Router();

// Apply authentication to all file routes
router.use(authenticate);

// GET /api/files - List all accessible files
router.get('/files', (req, res) => {
  try {
    const config = getConfig();
    const files = listFiles(config.server.storageDir, config.rules);
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// GET /api/files/*path - Read a specific file
router.get('/files/:path(.*)', validatePath, (req, res) => {
  try {
    const result = readFile(req.storagePath);
    
    if (!result) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('ETag', `"${result.etag}"`);
    res.send(result.content);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// PUT /api/files/*path - Create or update a file
router.put('/files/:path(.*)', validatePath, (req, res) => {
  try {
    const { content } = req.body;
    
    if (content === undefined) {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content must be a string' });
    }
    
    // Check if file exists for ETag validation
    const existingFile = readFile(req.storagePath);
    const ifMatch = req.headers['if-match'];
    
    if (existingFile) {
      // File exists, validate ETag
      if (!ifMatch) {
        return res.status(428).json({ 
          error: 'Precondition Required: If-Match header is required for updates',
          currentETag: `"${existingFile.etag}"`
        });
      }
      
      // Remove quotes from ETag if present
      const clientETag = ifMatch.replace(/^"|"$/g, '');
      
      if (clientETag !== existingFile.etag) {
        return res.status(412).json({
          error: 'Precondition Failed: File on server has changed.',
          serverETag: `"${existingFile.etag}"`,
          serverContent: existingFile.content
        });
      }
    }
    
    // Write file atomically
    writeFileAtomic(req.storagePath, content);
    
    // Generate new ETag
    const newETag = generateETag(content);
    
    res.set('ETag', `"${newETag}"`);
    res.json({
      success: true,
      etag: `"${newETag}"`
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to write file' });
  }
});

// DELETE /api/files/*path - Delete a file
router.delete('/files/:path(.*)', validatePath, (req, res) => {
  try {
    const ifMatch = req.headers['if-match'];
    
    if (ifMatch) {
      const existingFile = readFile(req.storagePath);
      
      if (existingFile) {
        const clientETag = ifMatch.replace(/^"|"$/g, '');
        
        if (clientETag !== existingFile.etag) {
          return res.status(412).json({
            error: 'Precondition Failed: File on server has changed.',
            serverETag: `"${existingFile.etag}"`
          });
        }
      }
    }
    
    const deleted = deleteFile(req.storagePath);
    
    if (!deleted) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// POST /api/move - Move/rename a file
router.post('/move', validatePath, (req, res) => {
  try {
    moveFile(req.storagePath.old, req.storagePath.new);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Source file not found' });
    }
    res.status(500).json({ error: 'Failed to move file' });
  }
});

module.exports = router;
