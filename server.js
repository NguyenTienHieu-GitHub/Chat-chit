// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(
  cors({
    origin: [
      "https://chat-chit-real.vercel.app", // domain frontend Vercel
      // thêm origin khác nếu cần (preview *.vercel.app thì cân nhắc wildcard)
    ],
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Online: id -> socketId
const online = new Map();

// Rooms: roomId -> { members: Set<id>, pass: string|null }
const rooms = new Map();
// Invites: inviteId -> { roomId, fromId, toId, createdAt }
const invites = new Map();

// Track user -> rooms (để phát "out phòng" khi rời/đứt kết nối)
const userRooms = new Map(); // userId -> Set<roomId>
const getUserRooms = (uid) => {
  if (!userRooms.has(uid)) userRooms.set(uid, new Set());
  return userRooms.get(uid);
};

const ensureRoom = (roomId) => rooms.get(roomId);
const inRoom = (roomId, userId) => {
  const r = rooms.get(roomId);
  return !!(r && r.members.has(userId));
};

// ===== Unique ID middleware =====
io.use((socket, next) => {
  const raw = socket.handshake.auth?.id;
  if (!raw) return next(new Error("Missing id"));
  const id = String(raw).trim().slice(0, 64);
  const existingSid = online.get(id);
  if (existingSid) {
    const existing = io.sockets.sockets.get(existingSid);
    if (existing && existing.connected)
      return next(new Error("ID đang được sử dụng"));
  }
  socket.data.id = id;
  next();
});

io.on("connection", (socket) => {
  const me = socket.data.id;

  // anti-race
  const prev = online.get(me);
  if (prev && prev !== socket.id) {
    socket.emit("user:error", { error: "ID đang được sử dụng" });
    return socket.disconnect(true);
  }
  online.set(me, socket.id);
  socket.emit("user:registered", { id: me });

  // ===== Room: Exists? (để client hiển thị gợi ý) =====
  socket.on("room:exists", ({ roomId }, ack) => {
    if (!roomId) return ack?.({ ok: false, error: "roomId required" });
    const r = rooms.get(String(roomId).trim());
    ack?.({ ok: true, exists: !!r, locked: !!(r && r.pass) });
  });

  // ===== Room: Create (KHÔNG cho tạo trùng) =====
  socket.on("room:create", ({ roomId, password }, ack) => {
    if (!roomId) return ack?.({ ok: false, error: "roomId required" });
    roomId = String(roomId).trim().slice(0, 64);

    if (rooms.has(roomId)) return ack?.({ ok: false, error: "ROOM_EXISTS" });

    const pass = password ? String(password) : null; // demo: plaintext (prod nên hash)
    const members = new Set([me]);
    rooms.set(roomId, { members, pass });

    socket.join(roomId);
    getUserRooms(me).add(roomId); // <— track
    io.to(roomId).emit("room:system", {
      roomId,
      text: `${me} đã tạo phòng${pass ? " (có mật khẩu)" : ""}`,
      at: Date.now(),
    });
    ack?.({ ok: true, roomId, members: [...members], locked: !!pass });
  });

  // ===== Room: Join (CHỈ join phòng đã tồn tại; nếu có pass phải đúng) =====
  socket.on("room:join", ({ roomId, password }, ack) => {
    if (!roomId) return ack?.({ ok: false, error: "roomId required" });
    roomId = String(roomId).trim().slice(0, 64);

    const r = rooms.get(roomId);
    if (!r) return ack?.({ ok: false, error: "ROOM_NOT_FOUND" });

    // ⛔ đang ở trong phòng rồi -> không join lại
    if (r.members.has(me)) {
      return ack?.({ ok: false, error: "ALREADY_IN_ROOM" });
    }

    if (r.pass && String(password || "") !== r.pass) {
      return ack?.({ ok: false, error: "WRONG_PASSWORD" });
    }

    r.members.add(me);
    socket.join(roomId);
    io.to(roomId).emit("room:system", {
      roomId,
      text: `${me} đã tham gia`,
      at: Date.now(),
    });
    ack?.({ ok: true, roomId, members: [...r.members], locked: !!r.pass });
  });

  // ===== Room: Invite -> cần accept, KHÔNG cần mật khẩu =====
  socket.on("room:invite", ({ roomId, peerId }, ack) => {
    if (!roomId || !peerId)
      return ack?.({ ok: false, error: "roomId,peerId required" });
    roomId = String(roomId).trim().slice(0, 64);
    peerId = String(peerId).trim();

    const r = rooms.get(roomId);
    if (!r) return ack?.({ ok: false, error: "ROOM_NOT_FOUND" });
    if (!r.members.has(me))
      return ack?.({ ok: false, error: "Bạn chưa ở phòng" });

    // ⛔ đối phương đã là member
    if (r.members.has(peerId)) {
      return ack?.({ ok: false, error: "PEER_ALREADY_IN_ROOM" });
    }

    const peerSid = online.get(peerId);
    if (!peerSid)
      return ack?.({ ok: false, error: "Peer offline/không tồn tại" });

    const inviteId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    invites.set(inviteId, {
      roomId,
      fromId: me,
      toId: peerId,
      createdAt: Date.now(),
    });
    io.to(peerSid).emit("room:incoming", {
      inviteId,
      roomId,
      fromId: me,
      at: Date.now(),
    });
    ack?.({ ok: true, inviteId });
  });

  socket.on("room:accept", ({ inviteId }, ack) => {
    const inv = invites.get(inviteId);
    if (!inv) return ack?.({ ok: false, error: "INVITE_NOT_FOUND" });
    if (inv.toId !== me) return ack?.({ ok: false, error: "UNAUTHORIZED" });

    const r = rooms.get(inv.roomId);
    if (!r) {
      invites.delete(inviteId);
      return ack?.({ ok: false, error: "ROOM_NOT_FOUND" });
    }

    const fromSid = online.get(inv.fromId);
    const toSid = online.get(inv.toId);
    if (!fromSid || !toSid) {
      invites.delete(inviteId);
      return ack?.({ ok: false, error: "Một trong hai bên đã offline" });
    }

    r.members.add(inv.fromId);
    r.members.add(inv.toId);
    io.sockets.sockets.get(fromSid)?.join(inv.roomId);
    io.sockets.sockets.get(toSid)?.join(inv.roomId);

    // <— track cả 2 phía
    getUserRooms(inv.fromId).add(inv.roomId);
    getUserRooms(inv.toId).add(inv.roomId);

    invites.delete(inviteId);

    io.to(inv.roomId).emit("room:system", {
      roomId: inv.roomId,
      text: `${me} đã tham gia (theo lời mời)`,
      at: Date.now(),
    });
    ack?.({
      ok: true,
      roomId: inv.roomId,
      members: [...r.members],
      locked: !!r.pass,
    });
  });

  socket.on("room:reject", ({ inviteId }, ack) => {
    const inv = invites.get(inviteId);
    if (inv && inv.toId === me) {
      const fromSid = online.get(inv.fromId);
      if (fromSid)
        io.to(fromSid).emit("room:rejected", {
          inviteId,
          by: me,
          at: Date.now(),
        });
      invites.delete(inviteId);
    }
    ack?.({ ok: true });
  });

  // ===== Room: Leave =====
  socket.on("room:leave", ({ roomId }, ack) => {
    if (!roomId) return ack?.({ ok: false, error: "roomId required" });
    const r = rooms.get(roomId);
    if (r && r.members.has(me)) {
      r.members.delete(me);
      socket.leave(roomId);

      // cập nhật userRooms
      getUserRooms(me).delete(roomId);

      io.to(roomId).emit("room:system", {
        roomId,
        text: `${me} đã rời phòng`,
        at: Date.now(),
      });

      // xóa phòng nếu rỗng (tuỳ chọn)
      if (r.members.size === 0) rooms.delete(roomId);
    }
    ack?.({ ok: true });
  });

  // ===== Room: Send (members only) =====
  socket.on("room:send", ({ roomId, text }, ack) => {
    if (!roomId || !text)
      return ack?.({ ok: false, error: "roomId,text required" });
    const r = rooms.get(roomId);
    if (!r || !r.members.has(me))
      return ack?.({ ok: false, error: "Bạn không ở trong phòng" });
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      roomId,
      from: me,
      text: String(text).slice(0, 4000),
      at: Date.now(),
    };
    io.to(roomId).emit("room:message", msg);
    ack?.({ ok: true, id: msg.id });
  });

  // ===== Khi mất kết nối: phát "đã rời phòng (mất kết nối)" cho tất cả phòng user đang ở =====
  socket.on("disconnect", () => {
    if (online.get(me) === socket.id) online.delete(me);

    const urs = getUserRooms(me);
    for (const roomId of urs) {
      const r = rooms.get(roomId);
      if (!r) continue;
      r.members.delete(me);
      io.to(roomId).emit("room:system", {
        roomId,
        text: `${me} đã rời phòng (mất kết nối)`,
        at: Date.now(),
      });
      if (r.members.size === 0) rooms.delete(roomId);
    }
    userRooms.delete(me);

    // dọn invite liên quan (optional)
    for (const [invId, it] of invites) {
      if (it.fromId === me || it.toId === me) invites.delete(invId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket server -> http://0.0.0.0:${PORT}`);
});
