const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const apiRoutes     = require('./src/routes/api');
const profileRoutes = require('./src/routes/profile');
const { registerSocketHandlers } = require('./src/socket/socketHandler');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6,
  pingTimeout:  60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  perMessageDeflate: false,
  path: '/voice/socket.io'
});

app.use(express.json());
app.use('/voice', express.static(path.join(__dirname, 'public')));
app.get('/voice', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// REST API routes
app.use('/voice/api', apiRoutes);
app.use('/voice/api', profileRoutes);

// Socket.IO handlers
registerSocketHandlers(io);

// Express error handler — return JSON instead of HTML stack traces
app.use((err, _req, res, _next) => {
  console.error('[Express error]', err.message);
  res.status(err.status || 500).json({ ok: false, error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙️  OathlyVoice running at http://localhost:${PORT}\n`);
});
