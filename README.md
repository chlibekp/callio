# Callio

Simple video/voice calls with chat and screen sharing. No accounts: create a call, share the link.

Everything (page, API, signaling, chat, audio/video) runs over a single HTTP port. Browsers encode media with WebCodecs (VP8 video, Opus audio) and send frames over a WebSocket. The server relays them to the other people in the room. There's no WebRTC and no peer-to-peer, so clients never see each other's IP addresses.

## Run (Docker, single container, single port)

```sh
docker build -t callio .
docker run -p 3000:3000 callio
```

Put any HTTPS reverse proxy (Caddy, nginx, Cloudflare) in front, with WebSocket upgrades allowed. Browsers only allow camera and mic access on HTTPS or localhost.

## Dev

```sh
npm install
npm run dev   # vite on :5173, server on :3000
```
