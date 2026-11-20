import express from "express";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";

const PORT = Number(process.env.PORT) || 3000;
const RTC_PORT = Number(process.env.RTC_PORT) || 40000;
// Public IP/hostname clients use to reach the media server. Only the server's address is ever exposed.
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || "127.0.0.1";

const mediaCodecs = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000, parameters: { "x-google-start-bitrate": 1000 } },
];

const worker = await mediasoup.createWorker({ logLevel: "warn" });
worker.on("died", () => {
  console.error("mediasoup worker died");
  process.exit(1);
});
const webRtcServer = await worker.createWebRtcServer({
  listenInfos: [
    { protocol: "udp", ip: "0.0.0.0", announcedAddress: ANNOUNCED_IP, port: RTC_PORT },
    { protocol: "tcp", ip: "0.0.0.0", announcedAddress: ANNOUNCED_IP, port: RTC_PORT },
  ],
});

/** @type {Map<string, {router: import('mediasoup').types.Router, peers: Map<string, any>}>} */
const rooms = new Map();

async function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { router: await worker.createRouter({ mediaCodecs }), peers: new Map() };
    rooms.set(id, room);
  }
  return room;
}

const app = express();
app.use(express.json());
app.post("/api/rooms", (_req, res) => res.json({ id: crypto.randomBytes(6).toString("base64url") }));

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const server = http.createServer(app);
const io = new Server(server);

io.on("connection", (socket) => {
  let room = null;
  let roomId = null;
  const peer = { id: socket.id, name: "Guest", transports: new Map(), producers: new Map(), consumers: new Map() };

  const handle = (event, fn) =>
    socket.on(event, async (data, cb) => {
      try {
        cb?.((await fn(data ?? {})) ?? {});
      } catch (e) {
        console.error(event, e);
        cb?.({ error: String(e?.message ?? e) });
      }
    });

  handle("join", async ({ roomId: id, name }) => {
    if (room) throw new Error("already joined");
    if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) throw new Error("bad room id");
    roomId = id;
    room = await getRoom(id);
    peer.name = String(name || "Guest").slice(0, 40);
    room.peers.set(peer.id, peer);
    socket.join(id);
    socket.to(id).emit("peerJoined", { id: peer.id, name: peer.name });

    const peers = [];
    const producers = [];
    for (const p of room.peers.values()) {
      if (p.id === peer.id) continue;
      peers.push({ id: p.id, name: p.name });
      for (const pr of p.producers.values()) producers.push({ producerId: pr.id, peerId: p.id, source: pr.appData.source });
    }
    return { rtpCapabilities: room.router.rtpCapabilities, peers, producers, selfId: peer.id };
  });

  handle("createTransport", async () => {
    const t = await room.router.createWebRtcTransport({ webRtcServer, enableUdp: true, enableTcp: true, preferUdp: true });
    peer.transports.set(t.id, t);
    return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
  });

  handle("connectTransport", async ({ transportId, dtlsParameters }) => {
    await peer.transports.get(transportId).connect({ dtlsParameters });
  });

  handle("produce", async ({ transportId, kind, rtpParameters, source }) => {
    const producer = await peer.transports.get(transportId).produce({ kind, rtpParameters, appData: { source } });
    peer.producers.set(producer.id, producer);
    producer.on("transportclose", () => peer.producers.delete(producer.id));
    socket.to(roomId).emit("newProducer", { producerId: producer.id, peerId: peer.id, source });
    return { id: producer.id };
  });

  handle("closeProducer", async ({ producerId }) => {
    const producer = peer.producers.get(producerId);
    if (!producer) return;
    producer.close();
    peer.producers.delete(producerId);
    socket.to(roomId).emit("producerClosed", { producerId });
  });

  handle("consume", async ({ transportId, producerId, rtpCapabilities }) => {
    if (!room.router.canConsume({ producerId, rtpCapabilities })) throw new Error("cannot consume");
    const consumer = await peer.transports.get(transportId).consume({ producerId, rtpCapabilities, paused: true });
    peer.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => peer.consumers.delete(consumer.id));
    consumer.on("producerclose", () => peer.consumers.delete(consumer.id));
    return { id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
  });

  handle("resume", async ({ consumerId }) => {
    await peer.consumers.get(consumerId)?.resume();
  });

  handle("chat", async ({ text }) => {
    const msg = String(text || "").trim().slice(0, 2000);
    if (!msg || !room) return;
    io.to(roomId).emit("chat", { id: crypto.randomUUID(), from: peer.id, name: peer.name, text: msg, ts: Date.now() });
  });

  socket.on("disconnect", () => {
    if (!room) return;
    for (const t of peer.transports.values()) t.close();
    room.peers.delete(peer.id);
    socket.to(roomId).emit("peerLeft", { id: peer.id });
    if (room.peers.size === 0) {
      room.router.close();
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => console.log(`Callio on :${PORT} (media ${ANNOUNCED_IP}:${RTC_PORT})`));
