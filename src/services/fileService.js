const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function generateETag(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function readFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const etag = generateETag(content);
    return { content, etag };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const tempFilePath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    fs.writeFileSync(tempFilePath, content, 'utf8');
    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    throw error;
  }
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function moveFile(oldPath, newPath) {
  const newDir = path.dirname(newPath);
  
  if (!fs.existsSync(newDir)) {
    fs.mkdirSync(newDir, { recursive: true });
  }
  
  fs.renameSync(oldPath, newPath);
}

function listFiles(storageDir, rules) {
  const files = [];
  
  function walkDir(currentDir, relativePath = '') {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      const entryRelativePath = path.join(relativePath, entry.name);
      
      if (entry.isDirectory()) {
        walkDir(entryPath, entryRelativePath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        
        if (rules.allowedExtensions.includes(ext)) {
          files.push(entryRelativePath);
        }
      }
    }
  }
  
  if (fs.existsSync(storageDir)) {
    walkDir(storageDir);
  }
  
  return files;
}

module.exports = {
  generateETag,
  readFile,
  writeFileAtomic,
  deleteFile,
  moveFile,
  listFiles
};
