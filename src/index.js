const express = require('express');
const cors = require('cors');
const { loadConfig } = require('./config');
const authRoutes = require('./routes/authRoutes');
const fileRoutes = require('./routes/fileRoutes');

const app = express();

// Load configuration
try {
  loadConfig();
  console.log('Configuration loaded successfully');
} catch (error) {
  console.error('Failed to load configuration:', error.message);
  process.exit(1);
}

// Middleware
app.use(cors({
  exposedHeaders: ['ETag']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', authRoutes);
app.use('/api', fileRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const config = loadConfig();
const PORT = config.server.port;
const HOST = config.server.host;

app.listen(PORT, HOST, () => {
  console.log(`Text Bridge server running on http://${HOST}:${PORT}`);
  console.log(`Storage directory: ${config.server.storageDir}`);
});
