require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const RTMP_PORT = parseInt(process.env.RTMP_PORT || '1935', 10);
const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const MEDIA = path.join(__dirname, 'media');
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const CATEGORIES = ['Videojuegos', 'Programación', 'Educación', 'Música', 'Charlas', 'Arte'];

if (!fs.existsSync(MEDIA)) {
  fs.mkdirSync(MEDIA, { recursive: true });
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const key = parts[0]?.trim();
    if (key) {
      cookies[key] = decodeURIComponent(parts.slice(1).join('=').trim());
    }
  });
  return cookies;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.sl_token;
  if (!token) {
    req.user = null;
    return next();
  }
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  if (!session) {
    req.user = null;
    return next();
  }
  const user = db.prepare('SELECT id, username, stream_key, title, category, bio, is_live, created_at FROM users WHERE id = ?').get(session.user_id);
  req.user = user || null;
  next();
});

function auth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

app.use(express.static(path.join(__dirname, 'public')));

app.use('/vendor/hls.js', express.static(path.join(__dirname, 'node_modules', 'hls.js', 'dist')));
app.get('/vendor/hls.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js'));
});

app.use('/media', express.static(MEDIA, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

const viewersMap = new Map();

function getViewers(username) {
  return viewersMap.get(username) || 0;
}

function decorate(u, currentUserId = null) {
  const followersRow = db.prepare('SELECT COUNT(*) as count FROM follows WHERE channel_id = ?').get(u.id);
  const followers = followersRow ? followersRow.count : 0;
  const thumbPath = path.join(MEDIA, 'live', u.username, 'thumb.jpg');
  const thumb = fs.existsSync(thumbPath) ? `/media/live/${u.username}/thumb.jpg` : null;
  const viewers = getViewers(u.username);

  const data = {
    id: u.id,
    username: u.username,
    title: u.title || '',
    category: u.category || '',
    bio: u.bio || '',
    is_live: Number(u.is_live),
    created_at: u.created_at,
    viewers,
    followers,
    thumb
  };

  if (currentUserId !== null) {
    const followRow = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND channel_id = ?').get(currentUserId, u.id);
    data.following = !!followRow;
  }

  return data;
}

function listVods(username) {
  const userDir = path.join(MEDIA, 'live', username);
  if (!fs.existsSync(userDir)) return [];
  try {
    const files = fs.readdirSync(userDir);
    return files
      .filter(file => file.endsWith('.mp4'))
      .map(file => {
        const filePath = path.join(userDir, file);
        const stat = fs.statSync(filePath);
        return {
          filename: file,
          url: `/media/live/${username}/${file}`,
          size_mb: parseFloat((stat.size / (1024 * 1024)).toFixed(2)),
          created_at: stat.mtime
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } catch (err) {
    return [];
  }
}

// Rutas de API
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const usernameRegex = /^[a-z0-9_]{3,20}$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({ error: 'El nombre de usuario debe tener entre 3 y 20 caracteres (minúsculas, números y guion bajo)' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const stream_key = 'sk_' + crypto.randomBytes(12).toString('hex');

  const insert = db.prepare(`
    INSERT INTO users (username, password_hash, stream_key, title, category, bio, is_live)
    VALUES (?, ?, ?, '', 'Videojuegos', '', 0)
  `);
  insert.run(username, password_hash, stream_key);

  const newUser = db.prepare('SELECT id, username, stream_key, title, category, bio, is_live, created_at FROM users WHERE username = ?').get(username);

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, newUser.id);

  res.setHeader('Set-Cookie', `sl_token=${token}; Path=/; HttpOnly; Max-Age=${7 * 86400}; SameSite=Lax`);
  res.json({ ok: true, user: decorate(newUser, newUser.id) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);

  res.setHeader('Set-Cookie', `sl_token=${token}; Path=/; HttpOnly; Max-Age=${7 * 86400}; SameSite=Lax`);
  res.json({ ok: true, user: decorate(user, user.id) });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.sl_token;
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.setHeader('Set-Cookie', 'sl_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) {
    return res.json({ user: null });
  }
  res.json({ user: decorate(req.user, req.user.id) });
});

app.get('/api/categories', (req, res) => {
  const rows = db.prepare('SELECT category, COUNT(*) as live_count FROM users WHERE is_live = 1 GROUP BY category').all();
  const countMap = {};
  for (const row of rows) {
    if (row.category) {
      countMap[row.category] = row.live_count;
    }
  }

  const result = CATEGORIES.map(name => ({
    name,
    live_count: countMap[name] || 0
  }));

  res.json(result);
});

app.get('/api/channels', (req, res) => {
  const { category, live } = req.query;
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  if (live === '1' || live === 'true') {
    sql += ' AND is_live = 1';
  }

  sql += ' ORDER BY is_live DESC, created_at DESC';
  const users = db.prepare(sql).all(...params);
  const currentUserId = req.user ? req.user.id : null;

  res.json(users.map(u => decorate(u, currentUserId)));
});

app.get('/api/channels/:username', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!user) {
    return res.status(404).json({ error: 'Canal no encontrado' });
  }

  const currentUserId = req.user ? req.user.id : null;
  const channelData = decorate(user, currentUserId);
  channelData.hls = `/media/live/${user.username}/index.m3u8`;
  channelData.vods = listVods(user.username);

  res.json(channelData);
});

app.post('/api/channels/:username/follow', auth, (req, res) => {
  const targetUser = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!targetUser) {
    return res.status(404).json({ error: 'Canal no encontrado' });
  }

  if (targetUser.id === req.user.id) {
    return res.status(400).json({ error: 'No puedes seguir tu propio canal' });
  }

  const existing = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND channel_id = ?').get(req.user.id, targetUser.id);
  let following = false;

  if (existing) {
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND channel_id = ?').run(req.user.id, targetUser.id);
    following = false;
  } else {
    db.prepare('INSERT INTO follows (follower_id, channel_id) VALUES (?, ?)').run(req.user.id, targetUser.id);
    following = true;
  }

  const followersCount = db.prepare('SELECT COUNT(*) as count FROM follows WHERE channel_id = ?').get(targetUser.id).count;
  res.json({ ok: true, following, followers: followersCount });
});

app.get('/api/following', auth, (req, res) => {
  const channels = db.prepare(`
    SELECT u.* FROM users u
    JOIN follows f ON u.id = f.channel_id
    WHERE f.follower_id = ?
    ORDER BY u.is_live DESC, u.username ASC
  `).all(req.user.id);

  res.json(channels.map(u => decorate(u, req.user.id)));
});

app.get('/api/dashboard', auth, (req, res) => {
  const host = PUBLIC_HOST || req.hostname;
  const rtmp_url = `rtmp://${host}:${RTMP_PORT}/live`;

  res.json({
    id: req.user.id,
    username: req.user.username,
    stream_key: req.user.stream_key,
    title: req.user.title || '',
    category: req.user.category || 'Videojuegos',
    bio: req.user.bio || '',
    is_live: Number(req.user.is_live),
    rtmp_url,
    categories: CATEGORIES
  });
});

app.put('/api/dashboard', auth, (req, res) => {
  const { title, category, bio } = req.body;
  const validCategory = CATEGORIES.includes(category) ? category : (req.user.category || 'Videojuegos');
  const newTitle = title !== undefined ? String(title).slice(0, 100) : (req.user.title || '');
  const newBio = bio !== undefined ? String(bio).slice(0, 300) : (req.user.bio || '');

  db.prepare(`
    UPDATE users
    SET title = ?, category = ?, bio = ?
    WHERE id = ?
  `).run(newTitle, validCategory, newBio, req.user.id);

  const updatedUser = db.prepare('SELECT id, username, stream_key, title, category, bio, is_live, created_at FROM users WHERE id = ?').get(req.user.id);
  if (typeof io !== 'undefined' && io) {
    io.to(`ch:${req.user.username}`).emit('channel:update', { title: newTitle, category: validCategory });
  }
  res.json({ ok: true, user: decorate(updatedUser, req.user.id) });
});

app.post('/api/dashboard/regenerate-key', auth, (req, res) => {
  const newKey = 'sk_' + crypto.randomBytes(12).toString('hex');
  db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(newKey, req.user.id);
  res.json({ ok: true, stream_key: newKey });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Ruta web de canal
app.get('/c/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'channel.html'));
});

const server = http.createServer(app);

// PARTE 2
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const NodeMediaServer = require('node-media-server');

const io = new Server(server);

const CHAT_COLORS = [
  '#ff7a59', '#2ec4b6', '#3a86ff', '#8338ec', '#ff006e',
  '#fb5607', '#ffbe0b', '#06d6a0', '#118ab2', '#e76f51'
];

function getUserColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }
  return CHAT_COLORS[Math.abs(hash) % CHAT_COLORS.length];
}

io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const token = cookies.sl_token;
  if (token) {
    const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
    if (session) {
      const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(session.user_id);
      if (user) {
        socket.user = user;
      }
    }
  }
  next();
});

function updateViewers(channel) {
  if (!channel) return;
  const room = io.sockets.adapter.rooms.get(`ch:${channel}`);
  const count = room ? room.size : 0;
  viewersMap.set(channel, count);
  io.to(`ch:${channel}`).emit('viewers', count);
}

io.on('connection', (socket) => {
  socket.on('join', (channel) => {
    if (!channel || typeof channel !== 'string') return;
    if (socket.currentChannel && socket.currentChannel !== channel) {
      socket.leave(`ch:${socket.currentChannel}`);
      updateViewers(socket.currentChannel);
    }
    socket.currentChannel = channel;
    socket.join(`ch:${channel}`);
    updateViewers(channel);
  });

  socket.on('chat', (text) => {
    if (!socket.user) {
      return socket.emit('chat:error', 'Debes iniciar sesión para chatear');
    }

    if (!socket.currentChannel) {
      return socket.emit('chat:error', 'Debes unirte a un canal primero');
    }

    const now = Date.now();
    if (socket.lastMessageAt && (now - socket.lastMessageAt < 700)) {
      return socket.emit('chat:error', 'Espera un momento antes de enviar otro mensaje');
    }

    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.length > 300) {
      return socket.emit('chat:error', 'El mensaje supera el límite de 300 caracteres');
    }

    socket.lastMessageAt = now;

    const msg = {
      user: socket.user.username,
      text: trimmed,
      color: getUserColor(socket.user.username),
      at: new Date().toISOString()
    };

    io.to(`ch:${socket.currentChannel}`).emit('chat', msg);
  });

  socket.on('disconnect', () => {
    if (socket.currentChannel) {
      updateViewers(socket.currentChannel);
    }
  });
});

const nmsConfig = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    mediaroot: MEDIA,
    allow_origin: '*',
    host: '127.0.0.1'
  },
  trans: {
    ffmpeg: FFMPEG,
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=2:hls_list_size=4:hls_flags=delete_segments]',
        hlsKeep: false,
        mp4: process.env.RECORD_VOD !== 'false',
        mp4Flags: '[movflags=frag_keyframe+empty_moov]'
      }
    ]
  }
};

const nms = new NodeMediaServer(nmsConfig);

nms.on('prePublish', (id, StreamPath, args) => {
  const parts = StreamPath.split('/').filter(Boolean);
  const app = parts[0];
  const username = parts[1];
  const key = args && args.key;

  const session = nms.getSession(id);
  if (!session) return;

  if (app !== 'live' || !username || !key) {
    session.reject();
    return;
  }

  const user = db.prepare('SELECT id, stream_key FROM users WHERE username = ?').get(username);
  if (!user || user.stream_key !== key) {
    session.reject();
    return;
  }
});

const thumbIntervals = new Map();

function captureThumbnail(username) {
  const userDir = path.join(MEDIA, 'live', username);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  const thumbPath = path.join(userDir, 'thumb.jpg');
  const tempThumb = path.join(userDir, 'thumb_tmp.jpg');
  const input = `rtmp://127.0.0.1:${RTMP_PORT}/live/${username}`;

  const proc = spawn(FFMPEG, [
    '-y',
    '-i', input,
    '-vframes', '1',
    '-q:v', '2',
    tempThumb
  ]);

  proc.on('close', (code) => {
    if (code === 0 && fs.existsSync(tempThumb)) {
      try {
        fs.renameSync(tempThumb, thumbPath);
      } catch (e) {}
    } else if (fs.existsSync(tempThumb)) {
      try {
        fs.unlinkSync(tempThumb);
      } catch (e) {}
    }
  });

  proc.on('error', () => {});
}

nms.on('postPublish', (id, StreamPath, args) => {
  const parts = StreamPath.split('/').filter(Boolean);
  const username = parts[1];
  if (!username) return;

  db.prepare('UPDATE users SET is_live = 1 WHERE username = ?').run(username);
  io.emit('live', { username, live: 1 });

  setTimeout(() => captureThumbnail(username), 3000);
  const interval = setInterval(() => {
    captureThumbnail(username);
  }, 30000);
  thumbIntervals.set(username, interval);
});

nms.on('donePublish', (id, StreamPath, args) => {
  const parts = StreamPath.split('/').filter(Boolean);
  const username = parts[1];
  if (!username) return;

  db.prepare('UPDATE users SET is_live = 0 WHERE username = ?').run(username);
  io.emit('live', { username, live: 0 });

  if (thumbIntervals.has(username)) {
    clearInterval(thumbIntervals.get(username));
    thumbIntervals.delete(username);
  }
});

db.exec('UPDATE users SET is_live = 0;');

nms.run();

server.listen(PORT, () => {
  console.log(`Servidor StreamLab escuchando en http://localhost:${PORT}`);
});
