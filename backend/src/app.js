const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const env = require('./config/env');
const apiRoutes = require('./routes');
const { notFoundMiddleware, errorMiddleware } = require('./middlewares/errorMiddleware');

function createApp() {
  const app = express();
  const frontendPath = path.resolve(__dirname, '..', 'public');

  app.set('trust proxy', true);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((item) => item.trim()),
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', apiRoutes);

  app.use(express.static(frontendPath));
  app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

module.exports = {
  createApp,
};
