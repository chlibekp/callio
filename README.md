# Callio

Simple video/voice calls with chat and screen sharing. No accounts: create a call, share the link.

All media goes through a mediasoup SFU on the server, so clients only connect to the server and never see each other's IP addresses. Signaling and chat go over Socket.IO, and rooms are created with `POST /api/rooms`.

## Run (Docker, single container)

```sh
docker build -t callio .
docker run -p 3000:3000 -p 40000:40000/udp -p 40000:40000/tcp -e ANNOUNCED_IP=<server public IP> callio
```

- `ANNOUNCED_IP`: the public IP that browsers use to reach the media port (default `127.0.0.1`)
- `PORT`: HTTP port (default 3000)
- `RTC_PORT`: single UDP/TCP media port (default 40000)

Browsers only allow camera and mic access on HTTPS or localhost, so put a TLS reverse proxy (Caddy, nginx) in front of port 3000 when you deploy.

## Dev

```sh
npm install
npm run dev   # vite on :5173, server on :3000
```
