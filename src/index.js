const express = require('express');
const cors = require('cors');
const path = require('path');
const { getConfig, loadConfig } = require('./config');
const authRoutes = require('./routes/authRoutes');
const { createFileRoutes } = require('./routes/fileRoutes');
const { FileService } = require('./services/fileService');

function createApp(config = getConfig(), fileService = new FileService(config)) {
  fileService.reconcile();
  const app = express();
  const parserLimit = `${config.rules.maxFileSizeMb + 1}mb`;

  app.use(cors({
    exposedHeaders: ['ETag', 'X-Version']
  }));
  app.use(express.text({ type: 'text/plain', limit: parserLimit }));
  app.use(express.json({ limit: parserLimit }));
  app.use(express.urlencoded({ extended: true, limit: parserLimit }));
  app.use('/api', authRoutes);
  app.use('/api', createFileRoutes(fileService));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) {
      console.error('Unhandled request error:', error);
    }
    res.status(status).json({
      error: status === 500 ? 'Internal server error' : error.message,
      ...error.details
    });
  });

  app.locals.fileService = fileService;
  return app;
}

function startServer(configPath = path.join(process.cwd(), 'config.json')) {
  const config = loadConfig(configPath);
  const fileService = new FileService(config);
  const app = createApp(config, fileService);
  const { port, host, reconcileIntervalMs = 5000 } = config.server;
  const reconcileTimer = setInterval(() => {
    try {
      fileService.reconcile();
    } catch (error) {
      console.error('Filesystem reconciliation failed:', error);
    }
  }, reconcileIntervalMs);
  reconcileTimer.unref();

  const server = app.listen(port, host, () => {
    console.log(`Plain file server running on http://${host}:${port}`);
    console.log(`Storage directory: ${fileService.storageRoot}`);
  });
  server.on('close', () => clearInterval(reconcileTimer));
  return server;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let configPath = path.join(process.cwd(), 'config.json');
    if (args.length > 0) {
      if (args.length !== 2 || args[0] !== '--config') {
        throw new Error('Usage: node src/index.js [--config <path>]');
      }
      configPath = path.resolve(args[1]);
    }
    startServer(configPath);
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

module.exports = { createApp, startServer };
