import express from 'express';
import dotenv from 'dotenv';
import nodesRouter from './routes/nodes';
import portsRouter from './routes/ports';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Middleware
app.use(express.json());

// Routes
app.use('/api/nodes', nodesRouter);
app.use('/api/ports', portsRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`PatchWork API listening on http://localhost:${PORT}`);
});

export default app;
