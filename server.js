'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS = 20;
const ROOM_TTL_MS = 30 * 60 * 1000;       // Empty room cleanup
const RECONNECT_GRACE_MS = 45 * 1000;     // Keep disconnected player briefly
const MAX_PACKET_BYTES = 64 * 1024;
const rooms = new Map();                    // roomId -> room
const socketInfo = new WeakMap();           // socket -> { roomId, playerId }

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Nayroda Backroom multiplayer server is online.');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocket.Server({
  server,
  path: '/ws',
  maxPayload: MAX_PACKET_BYTES,
  perMessageDeflate: false
});

function safeText(value, max = 32) {
  return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}
function validRoomId(value) {
  return /^\d{1,7}$/.test(String(value || ''));
}
function send(socket, packet) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(packet)); } catch (_) {}
  }
}
function roomMembers(room) {
  return Object.values(room.players);
}
function snapshot(room) {
  const publicPlayers = {};
  for (const [id, player] of Object.entries(room.players)) {
    const { socket, disconnectedAt, ...safePlayer } = player;
    publicPlayers[id] = safePlayer;
  }
  return { id: room.id, hostId: room.hostId, started: room.started, players: publicPlayers };
}
function broadcast(room, packet, exceptSocket = null) {
  const encoded = JSON.stringify(packet);
  for (const player of Object.values(room.players)) {
    const socket = player.socket;
    if (socket && socket !== exceptSocket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(encoded); } catch (_) {}
    }
  }
}
function sendSnapshot(room) {
  broadcast(room, { type: 'room_snapshot', room: snapshot(room), chests: room.chests });
}
function errorTo(socket, message) {
  send(socket, { type: 'room_error', message });
}
function getRoom(roomId) {
  return rooms.get(String(roomId));
}
function detachSocket(socket, keepPlayer = true) {
  const info = socketInfo.get(socket);
  if (!info) return;
  socketInfo.delete(socket);
  const room = getRoom(info.roomId);
  if (!room) return;
  const player = room.players[info.playerId];
  if (!player || player.socket !== socket) return;
  player.socket = null;
  player.disconnectedAt = Date.now();
  room.updatedAt = Date.now();
  if (!keepPlayer) {
    delete room.players[info.playerId];
    if (room.hostId === info.playerId) {
      const next = roomMembers(room).find(p => !p.isBot);
      room.hostId = next ? next.id : null;
      if (next) next.isHost = true;
    }
  }
  if (!roomMembers(room).some(p => p.socket)) {
    room.emptySince = Date.now();
  }
  sendSnapshot(room);
  if (!roomMembers(room).some(p => !p.isBot)) rooms.delete(room.id);
}
function attachSocket(room, player, socket) {
  if (player.socket && player.socket !== socket) {
    try { player.socket.close(4001, 'Reconnected from another connection'); } catch (_) {}
  }
  player.socket = socket;
  player.disconnectedAt = 0;
  socketInfo.set(socket, { roomId: room.id, playerId: player.id });
  room.updatedAt = Date.now();
  room.emptySince = 0;
}
function normalizePlayer(input, fallbackId) {
  const p = input && typeof input === 'object' ? input : {};
  const id = safeText(p.id || fallbackId, 64);
  if (!id || id.startsWith('bot_')) return null;
  return {
    id,
    name: safeText(p.name || 'Player', 20) || 'Player',
    isHost: false,
    isBot: false,
    hp: finiteNumber(p.hp, 200, 0, 200),
    kills: finiteNumber(p.kills, 0, 0, 100000),
    dead: !!p.dead,
    hidden: !!p.hidden,
    weapon: safeText(p.weapon || 'ar', 16),
    skin: safeText(p.skin || 'agent', 16),
    x: finiteNumber(p.x, 0, -10000, 10000),
    y: finiteNumber(p.y, 1.7, -10000, 10000),
    z: finiteNumber(p.z, 0, -10000, 10000),
    yaw: finiteNumber(p.yaw, 0, -1000, 1000),
    joinedAt: finiteNumber(p.joinedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER)
  };
}
function finiteNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function relay(room, packet, socket) {
  broadcast(room, packet, socket);
}
function removePlayer(room, playerId) {
  const player = room.players[playerId];
  if (!player) return;
  if (player.socket) socketInfo.delete(player.socket);
  delete room.players[playerId];
  if (room.hostId === playerId) {
    const next = roomMembers(room).find(p => !p.isBot);
    room.hostId = next ? next.id : null;
    if (next) next.isHost = true;
  }
  room.updatedAt = Date.now();
  if (!roomMembers(room).some(p => p.socket)) room.emptySince = Date.now();
  sendSnapshot(room);
  if (!roomMembers(room).some(p => !p.isBot)) rooms.delete(room.id);
}
function handleCreate(socket, msg) {
  const roomId = String(msg.roomId || '');
  if (!validRoomId(roomId)) return errorTo(socket, 'Ma phong khong hop le.');
  if (rooms.has(roomId)) return errorTo(socket, 'Phong nay da ton tai. Hay tao lai phong.');
  const host = normalizePlayer(msg.player, 'host');
  if (!host) return errorTo(socket, 'Thong tin nguoi tao phong khong hop le.');
  const sourceRoom = msg.room && typeof msg.room === 'object' ? msg.room : {};
  const players = {};
  // Preserve initial bots created by the client, but never allow more than 20.
  const initialPlayers = sourceRoom.players && typeof sourceRoom.players === 'object'
    ? Object.values(sourceRoom.players) : [host];
  for (const item of initialPlayers.slice(0, MAX_PLAYERS)) {
    if (item && item.isBot && item.id) {
      const botId = safeText(item.id, 64);
      players[botId] = {
        id: botId, name: safeText(item.name || 'Bot', 20), isHost: false, isBot: true,
        hp: finiteNumber(item.hp, 200, 0, 200), kills: finiteNumber(item.kills, 0, 0, 100000),
        dead: !!item.dead, hidden: !!item.hidden, weapon: safeText(item.weapon || 'ar', 16),
        skin: safeText(item.skin || 'agent', 16), x: finiteNumber(item.x, 0, -10000, 10000),
        y: finiteNumber(item.y, 1.7, -10000, 10000), z: finiteNumber(item.z, 0, -10000, 10000),
        yaw: finiteNumber(item.yaw, 0, -1000, 1000), joinedAt: finiteNumber(item.joinedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
        socket: null, disconnectedAt: 0
      };
    }
  }
  host.isHost = true;
  players[host.id] = { ...host, socket, disconnectedAt: 0 };
  const room = {
    id: roomId,
    hostId: host.id,
    started: !!msg.autoStart || !!sourceRoom.started,
    players,
    chests: Array.isArray(msg.chests) ? msg.chests.slice(0, 300) : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    emptySince: 0
  };
  rooms.set(roomId, room);
  attachSocket(room, players[host.id], socket);
  send(socket, { type: 'room_snapshot', room: snapshot(room), chests: room.chests });
}
function handleJoin(socket, msg) {
  const roomId = String(msg.roomId || '');
  if (!validRoomId(roomId)) return errorTo(socket, 'Ma phong khong hop le.');
  const room = getRoom(roomId);
  if (!room) return errorTo(socket, 'Khong tim thay phong.');
  const p = normalizePlayer(msg.player, '');
  if (!p) return errorTo(socket, 'Thong tin nguoi choi khong hop le.');
  const existing = room.players[p.id];
  if (!existing && roomMembers(room).length >= MAX_PLAYERS) {
    return errorTo(socket, 'Phong da du 20 nguoi.');
  }
  const player = existing || { ...p, socket: null, disconnectedAt: 0 };
  Object.assign(player, p);
  attachSocket(room, player, socket);
  room.players[player.id] = player;
  send(socket, { type: 'room_snapshot', room: snapshot(room), chests: room.chests });
  sendSnapshot(room);
}
function handleReconnect(socket, msg) {
  const room = getRoom(String(msg.roomId || ''));
  const playerId = safeText(msg.playerId, 64);
  if (!room || !room.players[playerId]) return errorTo(socket, 'Khong the ket noi lai phong. Hay vao phong lai.');
  const player = room.players[playerId];
  attachSocket(room, player, socket);
  send(socket, { type: 'room_snapshot', room: snapshot(room), chests: room.chests });
  sendSnapshot(room);
}
function handleMessage(socket, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  const info = socketInfo.get(socket);
  if (msg.type === 'create_room') return handleCreate(socket, msg);
  if (msg.type === 'join_room') return handleJoin(socket, msg);
  if (msg.type === 'reconnect') return handleReconnect(socket, msg);
  if (!info) return;
  const room = getRoom(info.roomId);
  if (!room) return;
  const player = room.players[info.playerId];
  if (!player || player.socket !== socket) return;

  if (msg.type === 'leave_room') {
    removePlayer(room, info.playerId);
    return;
  }

  // The host's room snapshot carries the waiting-room bot list and match state.
  if (msg.type === 'room_snapshot') {
    if (info.playerId !== room.hostId || !msg.room || typeof msg.room !== 'object') return;
    room.started = !!msg.room.started;
    if (msg.room.players && typeof msg.room.players === 'object') {
      for (const [id, item] of Object.entries(msg.room.players)) {
        if (id.startsWith('bot_') && item && item.isBot) {
          room.players[id] = {
            ...room.players[id],
            id, name: safeText(item.name || 'Bot', 20), isHost: false, isBot: true,
            hp: finiteNumber(item.hp, 200, 0, 200), kills: finiteNumber(item.kills, 0, 0, 100000),
            dead: !!item.dead, hidden: !!item.hidden, weapon: safeText(item.weapon || 'ar', 16),
            x: finiteNumber(item.x, 0, -10000, 10000), y: finiteNumber(item.y, 1.7, -10000, 10000),
            z: finiteNumber(item.z, 0, -10000, 10000), yaw: finiteNumber(item.yaw, 0, -1000, 1000),
            joinedAt: finiteNumber(item.joinedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
            socket: null, disconnectedAt: 0
          };
        }
      }
      for (const [id, item] of Object.entries(room.players)) {
        if (item.isBot && !msg.room.players[id]) delete room.players[id];
      }
    }
    if (Array.isArray(msg.chests)) room.chests = msg.chests.slice(0, 300);
    sendSnapshot(room);
    return;
  }
  if (msg.type === 'start_match') {
    if (info.playerId !== room.hostId) return;
    room.started = true;
    if (msg.room && msg.room.players) {
      for (const [id, item] of Object.entries(msg.room.players)) {
        const p = room.players[id];
        if (p) {
          p.kills = finiteNumber(item.kills, p.kills, 0, 100000);
          p.hp = finiteNumber(item.hp, p.hp, 0, 200);
        }
      }
    }
    if (Array.isArray(msg.chests)) room.chests = msg.chests.slice(0, 300);
    broadcast(room, { type: 'start_match', room: snapshot(room), chests: room.chests });
    return;
  }
  if (msg.type === 'player_state') {
    const p = msg.player;
    if (!p || p.id !== info.playerId) return;
    const cleaned = normalizePlayer(p, info.playerId);
    if (!cleaned) return;
    Object.assign(player, cleaned, { socket, disconnectedAt: 0 });
    relay(room, { type: 'player_state', player: cleaned }, socket);
    return;
  }
  // Game event relay. Clients apply their own local validation/game logic.
  const allowedRelay = new Set([
    'chest_opened', 'chests_sync', 'tracer', 'grenade',
    'damage', 'kill_credit', 'kill_feed', 'bot_damage'
  ]);
  if (!allowedRelay.has(msg.type)) return;
  if (msg.type === 'chests_sync' && info.playerId !== room.hostId) return;
  if (msg.type === 'bot_damage' && info.playerId !== room.hostId) return;
  if (msg.type === 'damage' && msg.targetId) {
    const target = room.players[safeText(msg.targetId, 64)];
    if (!target || !target.socket) return;
    send(target.socket, msg);
    return;
  }
  if (msg.type === 'kill_credit' && msg.killerId) {
    const target = room.players[safeText(msg.killerId, 64)];
    if (target && target.socket) send(target.socket, msg);
    return;
  }
  if (msg.type === 'bot_damage' && msg.targetId) {
    const target = room.players[safeText(msg.targetId, 64)];
    if (target && target.socket) send(target.socket, msg);
    return;
  }
  relay(room, msg, socket);
}

wss.on('connection', socket => {
  send(socket, { type: 'connected', message: 'Connected to Nayroda server' });
  socket.on('message', data => {
    try {
      const raw = data.toString();
      if (Buffer.byteLength(raw, 'utf8') > MAX_PACKET_BYTES) return socket.close(1009, 'Packet too large');
      handleMessage(socket, JSON.parse(raw));
    } catch (_) {
      send(socket, { type: 'room_error', message: 'Du lieu gui len khong hop le.' });
    }
  });
  socket.on('close', () => detachSocket(socket, true));
  socket.on('error', () => detachSocket(socket, true));
  socket.on('pong', () => { socket.isAlive = true; });
  socket.isAlive = true;
});

// WebSocket heartbeat detects broken mobile connections.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    try { socket.ping(); } catch (_) {}
  }
}, 25000);
heartbeat.unref();

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const player of roomMembers(room)) {
      if (!player.isBot && !player.socket && player.disconnectedAt &&
          now - player.disconnectedAt > RECONNECT_GRACE_MS) {
        removePlayer(room, player.id);
      }
    }
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) rooms.delete(room.id);
  }
}, 10000);
cleanup.unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nayroda multiplayer server listening on ${PORT}`);
});
