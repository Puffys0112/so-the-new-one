'use strict';
const express  = require('express');
const http     = require('http');
const { Server: SocketIO } = require('socket.io');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const os       = require('os');

const app        = express();
const httpServer = http.createServer(app);
const io         = new SocketIO(httpServer);

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'groups.json');
const GAME_SECS = 25 * 60; // 1500 seconds

app.use(express.json());
app.use(express.static(__dirname));

// ── Token store: multiple simultaneous tokens per group are ALL valid ──────
// { token: { groupId, loginTime } }
const groupTokens = new Map();

// ── Admin token store ──────────────────────────────────────────────────────
const adminTokens = new Set();

// ── Per-group live game session (server-authoritative) ─────────────────────
// Initialised on first /api/game/start for that group.
// {
//   solved:       { [key]: boolean },
//   inventory:    string[],
//   notes:        { html, important }[],
//   puzzlesDone:  number,
//   wrongAnswers: number,
//   startedAt:    number (Date.now()),
// }
const groupSessions = new Map();

// ── Per-group chat history (last 60 messages) ──────────────────────────────
const groupChats = new Map();

// Per-group collaborative code confirmations
// groupId → Map { puzzleKey → { code, fromName, confirmed: Set<socketId>, required: number } }
const pendingConfirms = new Map();

// Per-group lobby ready state (before game starts)
// groupId → Map { socketId → memberName }
const groupReadyState = new Map();

// ── Data helpers ───────────────────────────────────────────────────────────
function load() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function save(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

// ── HTTP auth middleware ───────────────────────────────────────────────────
function requireGroup(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const sess = groupTokens.get(token);
  if (!sess) return res.status(401).json({ error: 'Unauthorized' });
  if (Date.now() - sess.loginTime > 4 * 60 * 60 * 1000) {
    groupTokens.delete(token);
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
  req.groupId = sess.groupId;
  next();
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !adminTokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Helper: seconds remaining for a group ─────────────────────────────────
function calcSecsRemaining(groupId) {
  const sess = groupSessions.get(groupId);
  if (!sess || !sess.startedAt) return GAME_SECS;
  return Math.max(0, GAME_SECS - Math.floor((Date.now() - sess.startedAt) / 1000));
}

// ── Helper: members currently online in a group ───────────────────────────
function getOnlineMembers(groupId) {
  const room = io.sockets.adapter.rooms.get(groupId);
  if (!room) return [];
  const names = [];
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.memberName) names.push(s.memberName);
  }
  return names;
}

// ── HTTP Routes ────────────────────────────────────────────────────────────

// List all groups (for login dropdown)
app.get('/api/groups', (req, res) => {
  const data = load();
  res.json(data.groups.map(g => ({ id: g.id, name: g.name })));
});

// Group member login — multiple members can log in simultaneously
app.post('/api/login', (req, res) => {
  const { groupId, pin } = req.body || {};
  if (!groupId || !pin) return res.status(400).json({ error: 'Group and PIN required.' });

  const data  = load();
  const group = data.groups.find(g => g.id === groupId);
  if (!group || group.pin !== String(pin)) {
    return res.status(401).json({ error: 'Invalid group or PIN.' });
  }
  if (group.status === 'completed') {
    return res.json({ status: 'completed', groupName: group.name });
  }

  // Create a new token — do NOT invalidate others (multiple members need concurrent tokens)
  const token = crypto.randomBytes(22).toString('hex');
  groupTokens.set(token, { groupId, loginTime: Date.now() });

  res.json({ token, groupName: group.name, status: group.status });
});

// Mark game as started (called when any member clicks "Begin")
app.post('/api/game/start', requireGroup, (req, res) => {
  const data  = load();
  const group = data.groups.find(g => g.id === req.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.status === 'completed') return res.status(403).json({ error: 'Already completed.' });

  const isFirstStart = group.status !== 'playing';
  if (isFirstStart) {
    group.status    = 'playing';
    group.startedAt = new Date().toISOString();
    save(data);
  }

  // Initialise server session on first start
  if (!groupSessions.has(req.groupId)) {
    groupSessions.set(req.groupId, {
      solved: {}, inventory: [], notes: [],
      puzzlesDone: 0, wrongAnswers: 0,
      startedAt: Date.now(),
    });
  }

  res.json({ ok: true, timerSec: calcSecsRemaining(req.groupId) });
});

// Submit final score — server uses its own state for authoritative values
app.post('/api/game/submit', requireGroup, (req, res) => {
  const { won } = req.body || {};
  const data  = load();
  const group = data.groups.find(g => g.id === req.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.status === 'completed') return res.json({ score: group.score, alreadyDone: true });

  const sess         = groupSessions.get(req.groupId) || {};
  const puzzlesDone  = sess.puzzlesDone  || 0;
  const wrongAnswers = sess.wrongAnswers || 0;
  const secsLeft     = calcSecsRemaining(req.groupId);

  const score = Math.max(0,
    (puzzlesDone  * 200) +
    (won ? secsLeft * 2 : 0) -
    (wrongAnswers * 10)
  );

  group.status           = 'completed';
  group.score            = score;
  group.puzzlesDone      = puzzlesDone;
  group.wrongAnswers     = wrongAnswers;
  group.won              = !!won;
  group.secondsRemaining = secsLeft;
  group.completedAt      = new Date().toISOString();
  save(data);

  // Broadcast to ALL group members (including submitter)
  io.to(req.groupId).emit('game_over', { won: !!won, score, puzzlesDone, wrongAnswers, secondsRemaining: secsLeft });

  res.json({ score, puzzlesDone, wrongAnswers, secondsRemaining: secsLeft });
});

// Admin-only leaderboard
app.get('/api/leaderboard', requireAdmin, (req, res) => {
  const data = load();
  res.json(
    data.groups
      .filter(g => g.status === 'completed')
      .map(g => ({
        name: g.name, score: g.score, puzzlesDone: g.puzzlesDone,
        won: g.won, wrongAnswers: g.wrongAnswers,
        secondsRemaining: g.secondsRemaining, completedAt: g.completedAt,
      }))
      .sort((a, b) => b.score - a.score)
  );
});

// Summary for admin cards
app.get('/api/summary', (req, res) => {
  const data = load();
  res.json({
    total:     data.groups.length,
    pending:   data.groups.filter(g => g.status === 'pending').length,
    playing:   data.groups.filter(g => g.status === 'playing').length,
    completed: data.groups.filter(g => g.status === 'completed').length,
  });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const data = load();
  if (!req.body || req.body.password !== data.adminPassword) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  const token = crypto.randomBytes(22).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

// Admin: full group data
app.get('/api/admin/groups', requireAdmin, (req, res) => {
  const data = load();
  // Enrich with live session data
  const groups = data.groups.map(g => {
    const sess = groupSessions.get(g.id);
    return {
      ...g,
      liveMembers: getOnlineMembers(g.id).length,
      livePuzzles: sess ? sess.puzzlesDone : g.puzzlesDone,
      liveWrong:   sess ? sess.wrongAnswers : g.wrongAnswers,
    };
  });
  res.json(groups);
});

// Admin: reset a group
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const { groupId } = req.body || {};
  const data  = load();
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  group.status = 'pending'; group.score = null;
  group.puzzlesDone = 0; group.wrongAnswers = 0;
  group.won = false; group.secondsRemaining = 0;
  group.completedAt = null; group.startedAt = null;

  // Clear session, chat, and lobby state
  groupSessions.delete(groupId);
  groupChats.delete(groupId);
  pendingConfirms.delete(groupId);
  groupReadyState.delete(groupId);

  // Invalidate all tokens for this group
  for (const [tok, sess] of groupTokens) {
    if (sess.groupId === groupId) groupTokens.delete(tok);
  }

  // Kick any connected sockets
  io.to(groupId).emit('kicked', { reason: 'Group has been reset by admin.' });

  save(data);
  res.json({ ok: true });
});

// Admin: add group
app.post('/api/admin/groups', requireAdmin, (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required.' });
  const data = load();
  const id   = 'g_' + Date.now();
  data.groups.push({
    id, name, pin: String(pin),
    status: 'pending', score: null, puzzlesDone: 0,
    wrongAnswers: 0, won: false, secondsRemaining: 0,
    completedAt: null, startedAt: null,
  });
  save(data);
  res.json({ id });
});

// ── Socket.io auth middleware ──────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));

  const sess = groupTokens.get(token);
  if (!sess) return next(new Error('Unauthorized'));
  if (Date.now() - sess.loginTime > 4 * 60 * 60 * 1000) {
    groupTokens.delete(token);
    return next(new Error('Session expired'));
  }

  socket.groupId    = sess.groupId;
  socket.memberName = String(socket.handshake.auth.memberName || 'Member').slice(0, 24);
  next();
});

// ── Socket.io connection handler ───────────────────────────────────────────
io.on('connection', (socket) => {
  const { groupId, memberName } = socket;

  // Join the group's room
  socket.join(groupId);

  // Build state snapshot for this new member
  const sess = groupSessions.get(groupId);
  socket.emit('state_init', {
    state: sess ? {
      solved:       sess.solved,
      inventory:    sess.inventory,
      notes:        sess.notes,
      puzzlesDone:  sess.puzzlesDone,
      wrongAnswers: sess.wrongAnswers,
      timerSec:     calcSecsRemaining(groupId),
    } : null,
    chats:   groupChats.get(groupId) || [],
    members: getOnlineMembers(groupId),
  });

  // Notify others in the group
  socket.to(groupId).emit('member_join', {
    memberName,
    members: getOnlineMembers(groupId),
  });

  // ── Puzzle solved (validated client-side, stored server-side) ────────────
  socket.on('puzzle_solved', ({ key, puzzlesDone }) => {
    const gs = groupSessions.get(groupId);
    if (!gs || gs.solved[key]) return; // already solved — ignore
    gs.solved[key] = true;
    gs.puzzlesDone = Math.max(gs.puzzlesDone, Number(puzzlesDone) || 0);
    // Broadcast to others (sender already updated their local state)
    socket.to(groupId).emit('puzzle_solved', {
      key, puzzlesDone: gs.puzzlesDone, fromName: memberName,
    });
  });

  // ── Item found ────────────────────────────────────────────────────────────
  socket.on('item_found', ({ itemId }) => {
    const gs = groupSessions.get(groupId);
    if (!gs || gs.inventory.includes(itemId)) return;
    gs.inventory.push(itemId);
    socket.to(groupId).emit('item_found', { itemId, fromName: memberName });
  });

  // ── Note added ────────────────────────────────────────────────────────────
  socket.on('note_added', ({ html, important }) => {
    const gs = groupSessions.get(groupId);
    if (!gs) return;
    const note = { html: String(html || ''), important: !!important };
    gs.notes.push(note);
    socket.to(groupId).emit('note_added', { ...note, fromName: memberName });
  });

  // ── Wrong answer (increments server-side counter) ─────────────────────────
  socket.on('wrong_answer', () => {
    const gs = groupSessions.get(groupId);
    if (gs) gs.wrongAnswers++;
  });

  // ── Lobby: player signals ready to start ─────────────────────────────────
  socket.on('player_ready', () => {
    // Ignore if game already running for this group
    if (groupSessions.has(groupId)) return;

    if (!groupReadyState.has(groupId)) groupReadyState.set(groupId, new Map());
    const rs = groupReadyState.get(groupId);
    rs.set(socket.id, memberName);

    const room = io.sockets.adapter.rooms.get(groupId);
    const online = room ? room.size : 1;
    const readyNames = [...rs.values()];
    const readyCount = readyNames.length;

    if (online < 3) {
      socket.emit('lobby_error', { message: `Need at least 3 members online to start. Currently ${online} connected.` });
      rs.delete(socket.id);
      return;
    }
    if (online > 5) {
      socket.emit('lobby_error', { message: `Maximum group size is 5. Currently ${online} connected.` });
      rs.delete(socket.id);
      return;
    }

    io.to(groupId).emit('ready_update', { readyCount, total: online, readyNames });

    if (readyCount >= online) {
      // All online members are ready — start game
      const data  = load();
      const group = data.groups.find(g => g.id === groupId);
      if (!group || group.status === 'completed') return;

      if (group.status !== 'playing') {
        group.status    = 'playing';
        group.startedAt = new Date().toISOString();
        save(data);
      }

      if (!groupSessions.has(groupId)) {
        groupSessions.set(groupId, {
          solved: {}, inventory: [], notes: [],
          puzzlesDone: 0, wrongAnswers: 0,
          startedAt: Date.now(),
          groupSize: online,
        });
      }

      groupReadyState.delete(groupId);
      io.to(groupId).emit('game_start', { timerSec: GAME_SECS });
    }
  });

  // ── Collaborative: solver found the correct code ──────────────────────────
  socket.on('code_found', ({ puzzleKey, code, label }) => {
    const gs = groupSessions.get(groupId);
    if (!gs || gs.solved[puzzleKey]) return;

    if (!pendingConfirms.has(groupId)) pendingConfirms.set(groupId, new Map());
    const gConfirms = pendingConfirms.get(groupId);
    if (gConfirms.has(puzzleKey)) return; // already pending

    const room = io.sockets.adapter.rooms.get(groupId);
    const required = room ? room.size : 1;
    const confirmed = new Set([socket.id]); // solver auto-confirmed
    gConfirms.set(puzzleKey, { code, fromName: memberName, confirmed, required });

    if (required <= 1) {
      // Solo — complete immediately
      gs.solved[puzzleKey] = true;
      gs.puzzlesDone++;
      gConfirms.delete(puzzleKey);
      io.to(groupId).emit('puzzle_complete', { puzzleKey, puzzlesDone: gs.puzzlesDone, code });
      return;
    }

    io.to(groupId).emit('code_revealed', {
      puzzleKey, code, fromName: memberName, label, required, confirmed: 1,
    });
  });

  // ── Collaborative: teammate confirms the code ─────────────────────────────
  socket.on('confirm_code', ({ puzzleKey, code }) => {
    const gs = groupSessions.get(groupId);
    if (!gs || gs.solved[puzzleKey]) return;

    const gConfirms = pendingConfirms.get(groupId);
    if (!gConfirms) return;
    const pend = gConfirms.get(puzzleKey);
    if (!pend) return;

    // Accept both exact match and stripped versions (remove dashes/spaces)
    const normalise = s => String(s || '').trim().toUpperCase().replace(/[-\s]/g, '');
    if (normalise(code) !== normalise(pend.code)) return;
    if (pend.confirmed.has(socket.id)) return;

    pend.confirmed.add(socket.id);
    const count = pend.confirmed.size;

    io.to(groupId).emit('confirm_progress', {
      puzzleKey, count, required: pend.required, fromName: memberName,
    });

    const room = io.sockets.adapter.rooms.get(groupId);
    const online = room ? room.size : 1;

    if (count >= online || count >= pend.required) {
      gs.solved[puzzleKey] = true;
      gs.puzzlesDone++;
      gConfirms.delete(puzzleKey);
      io.to(groupId).emit('puzzle_complete', { puzzleKey, puzzlesDone: gs.puzzlesDone, code: pend.code });
    }
  });

  // ── Group chat ────────────────────────────────────────────────────────────
  socket.on('chat', ({ text }) => {
    const txt = String(text || '').trim().slice(0, 200);
    if (!txt) return;
    const msg = { from: memberName, text: txt, ts: Date.now() };

    if (!groupChats.has(groupId)) groupChats.set(groupId, []);
    const chats = groupChats.get(groupId);
    chats.push(msg);
    if (chats.length > 60) chats.shift();

    // Broadcast to EVERYONE in group including sender
    io.to(groupId).emit('chat', msg);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    // Remove from lobby ready state if present
    const rs = groupReadyState.get(groupId);
    if (rs) {
      rs.delete(socket.id);
      if (rs.size === 0) groupReadyState.delete(groupId);
      else {
        const room = io.sockets.adapter.rooms.get(groupId);
        const online = room ? room.size : 0;
        io.to(groupId).emit('ready_update', {
          readyCount: rs.size, total: Math.max(online - 1, rs.size),
          readyNames: [...rs.values()],
        });
      }
    }
    // Short delay before announcing departure (handles page reloads gracefully)
    setTimeout(() => {
      const remaining = getOnlineMembers(groupId);
      socket.to(groupId).emit('member_leave', { memberName, members: remaining });
    }, 500);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
function getLanIP() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

httpServer.listen(PORT, '0.0.0.0', () => {
  const ip = getLanIP();
  console.log('\n🏭  MediSeal Quality Week — Game Server v2');
  console.log('─'.repeat(46));
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${ip}:${PORT}   ← share with groups`);
  console.log(`  Admin:    http://${ip}:${PORT}/admin.html`);
  console.log('─'.repeat(46));
  console.log(`  Up to 5 members per group, all on same session.`);
  console.log(`  Admin password: see data/groups.json\n`);
});
