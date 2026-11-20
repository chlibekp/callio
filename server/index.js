import express from "express";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT) || 3000;
const SOURCES = new Set(["mic", "cam", "screen"]);

/** roomId -> Map<peerId, {id, name, sources:Set}> */
const rooms = new Map();

const app = express();
app.use(express.json());
app.post("/api/rooms", (_req, res) => res.json({ id: crypto.randomBytes(6).toString("base64url") }));

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const server = http.createServer(app);
// All signaling, chat and media go through this one WebSocket. Clients only ever talk to the server.
const io = new Server(server, { maxHttpBufferSize: 4e6, transports: ["websocket"] });

io.on("connection", (socket) => {
  let roomId = null;
  const peer = { id: socket.id, name: "Guest", sources: new Set() };
  const view = (p) => ({ id: p.id, name: p.name, sources: [...p.sources] });

  socket.on("join", ({ roomId: id, name } = {}, cb) => {
    if (roomId || typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) return cb?.({ error: "bad room id" });
    roomId = id;
    peer.name = String(name || "Guest").slice(0, 40);
    if (!rooms.has(id)) rooms.set(id, new Map());
    const peers = rooms.get(id);
    const others = [...peers.values()].map(view);
    peers.set(peer.id, peer);
    socket.join(id);
    socket.to(id).emit("peerJoined", view(peer));
    socket.to(id).emit("needKey"); // newcomer needs keyframes
    cb?.({ selfId: peer.id, peers: others });
  });

  socket.on("source", ({ source, on } = {}) => {
    if (!roomId || !SOURCES.has(source)) return;
    on ? peer.sources.add(source) : peer.sources.delete(source);
    socket.to(roomId).emit("source", { peerId: peer.id, source, on: !!on });
  });

  // Encoded media frame: relay to everyone else in the room; volatile = drop if a receiver is backed up.
  socket.on("media", (pkt) => {
    if (!roomId || !pkt || !SOURCES.has(pkt.s)) return;
    socket.to(roomId).volatile.emit("media", peer.id, pkt);
  });

  socket.on("needKey", () => roomId && socket.to(roomId).emit("needKey"));

  socket.on("chat", ({ text } = {}) => {
    const msg = String(text || "").trim().slice(0, 2000);
    if (!msg || !roomId) return;
    io.to(roomId).emit("chat", { id: crypto.randomUUID(), from: peer.id, name: peer.name, text: msg, ts: Date.now() });
  });

  socket.on("disconnect", () => {
    if (!roomId) return;
    const peers = rooms.get(roomId);
    peers?.delete(peer.id);
    if (peers?.size === 0) rooms.delete(roomId);
    socket.to(roomId).emit("peerLeft", { id: peer.id });
  });
});

server.listen(PORT, () => console.log(`Callio on :${PORT}`));
