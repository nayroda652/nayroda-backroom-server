const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS = 20;
const DISCONNECT_GRACE_MS = 30_000;
const ROOM_EMPTY_TTL_MS = 5 * 60_000;
const rooms = new Map();
const sockets = new Set();

function send(ws, packet) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet));
}
function broadcast(room, packet, except = null) {
  for (const p of Object.values(room.players)) {
    if (p.socket && p.socket !== except) send(p.socket, packet);
  }
}
function publicRoom(room) {
  const players = {};
  for (const [id, p] of Object.entries(room.players)) {
    const { socket, disconnectTimer, ...safe } = p;
    players[id] = safe;
  }
  return { id: room.id, hostId: room.hostId, started: room.started, players };
}
function snapshot(room, chests) {
  return { type: "room_snapshot", room: publicRoom(room), chests: chests || room.chests || null };
}
function error(ws, code, message) { send(ws, { type: "room_error", code, message }); }
function cleanRoomId(v) { return String(v || "").replace(/\D/g, "").slice(0, 7); }
function cleanName(v) {
  return String(v || "Player").replace(/[<>]/g, "").trim().slice(0, 18) || "Player";
}
function cleanPlayer(data, isBot = false) {
  const id = String(data && data.id || "").slice(0, 64);
  return {
    id, name: cleanName(data && data.name), isHost: false, isBot,
    hp: 200, kills: 0, dead: false, hidden: false,
    weapon: String(data && data.weapon || "ar").slice(0, 24),
    skin: data && data.skin || "default", joinedAt: Date.now(),
    online: !isBot, x: 0, y: 0, z: 0, yaw: 0
  };
}
function detach(ws) {
  const room = ws.room;
  if (!room || !ws.playerId) return;
  const p = room.players[ws.playerId];
  if (!p || p.socket !== ws) return;
  p.socket = null;
  p.online = false;
  p.disconnectTimer = setTimeout(() => {
    if (rooms.get(room.id) !== room || room.players[p.id] !== p || p.socket) return;
    delete room.players[p.id];
    if (room.hostId === p.id) electHost(room);
    if (!Object.values(room.players).some(x => x.online)) {
      room.emptyTimer = setTimeout(() => {
        if (!Object.values(room.players).some(x => x.online)) rooms.delete(room.id);
      }, ROOM_EMPTY_TTL_MS);
    }
    broadcast(room, snapshot(room));
  }, DISCONNECT_GRACE_MS);
  if (room.hostId === p.id) electHost(room);
  broadcast(room, snapshot(room));
}
function electHost(room) {
  const next = Object.values(room.players).find(p => !p.isBot && p.online);
  room.hostId = next ? next.id : null;
  for (const p of Object.values(room.players)) p.isHost = p.id === room.hostId;
}
function bindPlayer(ws, room, playerId) {
  const p = room.players[playerId];
  if (!p) return false;
  if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
  p.disconnectTimer = null;
  p.socket = ws; p.online = true;
  ws.room = room; ws.playerId = playerId;
  if (!room.hostId) electHost(room);
  return true;
}
function handlePacket(ws, msg) {
  if (!msg || typeof msg.type !== "string") return;
  const roomId = cleanRoomId(msg.roomId || (ws.room && ws.room.id));
  if (msg.type === "create_room") {
    const id = cleanRoomId(msg.roomId);
    if (!id) return error(ws, "BAD_ROOM", "Mã phòng không hợp lệ.");
    if (rooms.has(id)) return error(ws, "ROOM_EXISTS", "Mã phòng đã tồn tại, hãy tạo lại.");
    const owner = cleanPlayer(msg.player);
    if (!owner.id) return error(ws, "BAD_PLAYER", "Thiếu mã người chơi.");
    const room = { id, hostId: owner.id, started: !!msg.autoStart, players: {}, chests: msg.chests || null };
    owner.isHost = true; owner.socket = ws; owner.online = true;
    room.players[owner.id] = owner;
    const requested = msg.room && msg.room.players ? Object.values(msg.room.players) : [];
    for (const raw of requested) {
      if (!raw || !raw.isBot || Object.keys(room.players).length >= MAX_PLAYERS) continue;
      const bot = cleanPlayer(raw, true);
      if (!bot.id || room.players[bot.id]) continue;
      bot.hp = Number(raw.hp) || 200; bot.kills = Number(raw.kills) || 0;
      bot.dead = !!raw.dead; bot.hidden = !!raw.hidden;
      bot.weapon = raw.weapon || "ar"; bot.joinedAt = Number(raw.joinedAt) || Date.now();
      room.players[bot.id] = bot;
    }
    rooms.set(id, room); ws.room = room; ws.playerId = owner.id;
    send(ws, snapshot(room, msg.chests));
    if (room.started) send(ws, { type: "start_match", room: publicRoom(room), chests: room.chests });
    return;
  }
  if (msg.type === "join_room") {
    const room = rooms.get(roomId);
    if (!room) return error(ws, "ROOM_NOT_FOUND", "Không tìm thấy phòng. Kiểm tra mã phòng.");
    const raw = msg.player || {};
    const id = String(raw.id || "").slice(0, 64);
    if (!id) return error(ws, "BAD_PLAYER", "Thiếu mã người chơi.");
    if (room.players[id]) {
      bindPlayer(ws, room, id);
      send(ws, snapshot(room));
      if (room.started) send(ws, { type: "start_match", room: publicRoom(room), chests: room.chests });
      broadcast(room, snapshot(room), ws);
      return;
    }
    if (Object.keys(room.players).length >= MAX_PLAYERS) return error(ws, "ROOM_FULL", "Phòng đã đủ 20 người.");
    if (room.started) return error(ws, "MATCH_STARTED", "Trận đấu đã bắt đầu, không thể vào phòng.");
    const p = cleanPlayer(raw);
    room.players[p.id] = p;
    bindPlayer(ws, room, p.id);
    send(ws, snapshot(room));
    broadcast(room, snapshot(room), ws);
    return;
  }
  if (msg.type === "reconnect") {
    const room = rooms.get(roomId);
    if (!room || !bindPlayer(ws, room, String(msg.playerId || ""))) {
      return error(ws, "RECONNECT_FAILED", "Không thể khôi phục kết nối phòng.");
    }
    send(ws, snapshot(room));
    if (room.started) send(ws, { type: "start_match", room: publicRoom(room), chests: room.chests });
    broadcast(room, snapshot(room), ws);
    return;
  }
  if (msg.type === "leave_room") {
    if (ws.room && ws.playerId) {
      const room = ws.room, p = room.players[ws.playerId];
      if (p) {
        if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
        delete room.players[ws.playerId];
        if (room.hostId === ws.playerId) electHost(room);
        broadcast(room, snapshot(room));
      }
      ws.room = null; ws.playerId = null;
    }
    return;
  }
  const room = ws.room;
  if (!room || room.id !== roomId || !ws.playerId) return;
  const sender = room.players[ws.playerId];
  if (!sender || sender.socket !== ws) return;

  if (msg.type === "room_snapshot") {
    if (room.hostId !== ws.playerId || !msg.room || !msg.room.players) return;
    const updated = {};
    for (const [id, raw] of Object.entries(msg.room.players)) {
      if (Object.keys(updated).length >= MAX_PLAYERS) break;
      if (raw && raw.isBot) {
        const bot = cleanPlayer({ ...raw, id }, true);
        bot.hp = Number(raw.hp) || 200; bot.kills = Number(raw.kills) || 0;
        bot.dead = !!raw.dead; bot.hidden = !!raw.hidden;
        bot.x = Number(raw.x) || 0; bot.y = Number(raw.y) || 0; bot.z = Number(raw.z) || 0;
        bot.weapon = raw.weapon || "ar"; updated[id] = bot;
      } else if (room.players[id]) updated[id] = room.players[id];
    }
    if (!updated[ws.playerId]) updated[ws.playerId] = sender;
    room.players = updated;
    broadcast(room, snapshot(room, msg.chests));
    return;
  }
  if (msg.type === "start_match") {
    if (room.hostId !== ws.playerId) return;
    room.started = true; room.chests = msg.chests || room.chests;
    broadcast(room, { type: "start_match", room: publicRoom(room), chests: room.chests });
    return;
  }
  if (msg.type === "player_state") {
    const raw = msg.player || {};
    const id = String(raw.id || "");
    const target = room.players[id];
    if (!target || (id !== ws.playerId && !(target.isBot && room.hostId === ws.playerId))) return;
    const safe = {
      name: cleanName(raw.name || target.name), isHost: id === room.hostId,
      isBot: !!target.isBot, weapon: String(raw.weapon || target.weapon).slice(0, 24),
      skin: raw.skin || target.skin, kills: target.kills, hp: target.hp,
      dead: target.dead, hidden: !!raw.hidden,
      x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : target.x,
      y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : target.y,
      z: Number.isFinite(Number(raw.z)) ? Number(raw.z) : target.z,
      yaw: Number.isFinite(Number(raw.yaw)) ? Number(raw.yaw) : target.yaw
    };
    Object.assign(target, safe);
    broadcast(room, { type: "player_state", player: { id, ...safe } }, ws);
    return;
  }
  if (msg.type === "bot_damage") {
    if (room.hostId !== ws.playerId) return;
    const bot = room.players[String(msg.botId || "")];
    const target = room.players[String(msg.targetId || "")];
    if (!bot || !bot.isBot || !target || target.isBot || target.dead) return;
    const amount = Math.max(1, Math.min(40, Math.floor(Number(msg.amount) || 1)));
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp <= 0) target.dead = true;
    send(target.socket, { type: "damage", targetId: target.id, fromId: bot.id, fromName: bot.name, amount });
    broadcast(room, { type: "player_state", player: { id: target.id, hp: target.hp, dead: target.dead, x: target.x, y: target.y, z: target.z, yaw: target.yaw, name: target.name, weapon: target.weapon, skin: target.skin, hidden: target.hidden, kills: target.kills, isBot: false, isHost: target.id === room.hostId } });
    return;
  }
  if (msg.type === "damage") {
    const targetId = String(msg.targetId || "");
    const target = room.players[targetId];
    if (!target || target.dead || targetId === ws.playerId) return;
    const amount = Math.max(1, Math.min(120, Math.floor(Number(msg.amount) || 1)));
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp <= 0) target.dead = true;
    if (!target.isBot) {
      send(target.socket, { type: "damage", targetId, fromId: ws.playerId, fromName: sender.name, amount });
    }
    broadcast(room, { type: "player_state", player: { id: target.id, hp: target.hp, dead: target.dead, x: target.x, y: target.y, z: target.z, yaw: target.yaw, name: target.name, weapon: target.weapon, skin: target.skin, hidden: target.hidden, kills: target.kills, isBot: !!target.isBot, isHost: target.id === room.hostId } });
    return;
  }
  if (msg.type === "kill_credit") {
    if (String(msg.fromId || "") !== ws.playerId) return;
    const killer = room.players[String(msg.killerId || "")];
    if (!killer || killer.isBot) return;
    killer.kills = Math.min(9999, (Number(killer.kills) || 0) + 1);
    send(killer.socket, { type: "kill_credit", killerId: killer.id, fromId: ws.playerId, victimName: cleanName(msg.victimName) });
    return;
  }
  if (msg.type === "chest_opened") {
    // Any player may request a chest interaction; the current room authority applies
    // the chest cooldown/respawn and publishes the resulting chest state.
    const owner = room.players[room.hostId];
    send(owner && owner.socket, { ...msg, roomId: room.id });
    return;
  }
  if (msg.type === "chests_sync") {
    if (room.hostId !== ws.playerId) return;
    room.chests = msg.chests || room.chests;
    broadcast(room, msg, ws);
    return;
  }
  if (msg.type === "room_full") return;
  // Gameplay effects (tracers, grenades, kill feed, etc.) are relayed to the room.
  if (["tracer", "grenade", "kill_feed"].includes(msg.type)) {
    if (JSON.stringify(msg).length > 12_000) return;
    broadcast(room, msg, ws);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("Nayroda Backroom Arena WebSocket server is running. Connect at /ws");
});
const wss = new WebSocket.Server({ server, path: "/ws", maxPayload: 32 * 1024 });
wss.on("connection", ws => {
  sockets.add(ws);
  send(ws, { type: "connected", message: "Connected to Nayroda server" });
  ws.on("message", raw => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return error(ws, "BAD_JSON", "Dữ liệu gửi lên không hợp lệ."); }
    try { handlePacket(ws, packet); } catch (e) {
      console.error("Packet error:", e && e.message);
      error(ws, "SERVER_ERROR", "Máy chủ không xử lý được yêu cầu.");
    }
  });
  ws.on("close", () => { sockets.delete(ws); detach(ws); });
  ws.on("error", () => {});
});
server.listen(PORT, "0.0.0.0", () => console.log("Nayroda server listening on", PORT));
