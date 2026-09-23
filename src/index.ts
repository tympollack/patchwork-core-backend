import express from 'express';
import dotenv from 'dotenv';
import nodesRouter from './routes/nodes';
import portsRouter from './routes/ports';
import storageRouter from './routes/storage';
import cronRouter from './routes/cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Middleware
app.use(express.json());

// Routes
app.use('/api/nodes', nodesRouter);
app.use('/api/ports', portsRouter);
app.use('/api/storage', storageRouter);
app.use('/api/cron', cronRouter);

// Health check
app.get('/health', (_req, res) => {
  console.log(`[TRACE] GET /health`);
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[TRACE] Server started | port: ${PORT} | env: ${process.env.NODE_ENV ?? 'development'}`);
  console.log(`PatchWork API listening on http://localhost:${PORT}`);
});

export default app;
