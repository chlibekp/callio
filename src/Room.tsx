import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Device, types } from "mediasoup-client";
import { Mic, MicOff, Video, VideoOff, MonitorUp, MonitorX, MessageSquare, PhoneOff, Link2, Check, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Source = "mic" | "cam" | "screen";
type Remote = { name: string } & Partial<Record<Source, MediaStreamTrack>>;
type Msg = { id: string; from: string; name: string; text: string; ts: number };

type Session = {
  socket: Socket;
  req: <T = any>(ev: string, data?: unknown) => Promise<T>;
  send: types.Transport;
  recv: types.Transport;
  producers: Partial<Record<Source, types.Producer>>;
  consumers: Map<string, { peerId: string; source: Source; consumer: types.Consumer }>;
};

function MediaView({ track, mirror }: { track: MediaStreamTrack; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={cn("h-full w-full object-contain", mirror && "-scale-x-100")} />;
}

function AudioOut({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

function Tile({ name, video, mic, mirror, screen }: { name: string; video?: MediaStreamTrack; mic?: boolean; mirror?: boolean; screen?: boolean }) {
  return (
    <div className="relative flex aspect-video min-h-0 items-center justify-center overflow-hidden rounded-xl border bg-card">
      {video ? (
        <MediaView track={video} mirror={mirror} />
      ) : (
        <div className="flex size-20 items-center justify-center rounded-full bg-secondary text-2xl font-semibold uppercase">{name.slice(0, 1)}</div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs">
        {!screen && (mic ? <Mic className="size-3" /> : <MicOff className="size-3 text-destructive" />)}
        {screen && <MonitorUp className="size-3" />}
        {name}
      </div>
    </div>
  );
}

export default function Room({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const [name, setName] = useState(() => localStorage.getItem("callio:name") ?? "");
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [wantMic, setWantMic] = useState(true);
  const [wantCam, setWantCam] = useState(true);

  const [local, setLocal] = useState<Partial<Record<Source, MediaStreamTrack>>>({});
  const [remotes, setRemotes] = useState<Record<string, Remote>>({});
  const [messages, setMessages] = useState<Msg[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [selfId, setSelfId] = useState("");

  const session = useRef<Session | null>(null);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), [messages, chatOpen]);
  useEffect(() => () => teardown(), []);

  function teardown() {
    const s = session.current;
    session.current = null;
    if (!s) return;
    Object.values(s.producers).forEach((p) => p?.track?.stop());
    s.send.close();
    s.recv.close();
    s.socket.disconnect();
  }

  const patchRemote = (peerId: string, patch: Partial<Remote>) =>
    setRemotes((r) => (r[peerId] || patch.name ? { ...r, [peerId]: { ...r[peerId], ...patch } as Remote } : r));

  async function join() {
    setJoining(true);
    setError("");
    localStorage.setItem("callio:name", name);
    try {
      const socket = io({ transports: ["websocket"] });
      const req = <T,>(ev: string, data?: unknown) =>
        new Promise<T>((res, rej) => socket.emit(ev, data, (r: any) => (r?.error ? rej(new Error(r.error)) : res(r))));

      let ready!: () => void;
      const readyP = new Promise<void>((r) => (ready = r));

      const consume = async (producerId: string, peerId: string, source: Source) => {
        await readyP;
        const s = session.current!;
        const params = await req<any>("consume", { transportId: s.recv.id, producerId, rtpCapabilities: device.rtpCapabilities });
        const consumer = await s.recv.consume(params);
        s.consumers.set(producerId, { peerId, source, consumer });
        await req("resume", { consumerId: consumer.id });
        patchRemote(peerId, { [source]: consumer.track });
      };

      socket.on("peerJoined", ({ id, name }) => setRemotes((r) => ({ ...r, [id]: { name } })));
      socket.on("peerLeft", ({ id }) =>
        setRemotes((r) => {
          const { [id]: _, ...rest } = r;
          return rest;
        })
      );
      socket.on("newProducer", ({ producerId, peerId, source }) => consume(producerId, peerId, source).catch(console.error));
      socket.on("producerClosed", ({ producerId }) => {
        const c = session.current?.consumers.get(producerId);
        if (!c) return;
        c.consumer.close();
        session.current!.consumers.delete(producerId);
        patchRemote(c.peerId, { [c.source]: undefined });
      });
      socket.on("chat", (m: Msg) => {
        setMessages((ms) => [...ms, m]);
        if (!chatOpenRef.current) setUnread((u) => u + 1);
      });
      socket.on("disconnect", () => setError("Disconnected from server"));

      const joinRes = await req<any>("join", { roomId, name: name.trim() || "Guest" });
      setSelfId(joinRes.selfId);
      setRemotes(Object.fromEntries(joinRes.peers.map((p: any) => [p.id, { name: p.name }])));

      const device = new Device();
      await device.load({ routerRtpCapabilities: joinRes.rtpCapabilities });

      const send = device.createSendTransport(await req<any>("createTransport"));
      send.on("connect", ({ dtlsParameters }, cb, eb) => req("connectTransport", { transportId: send.id, dtlsParameters }).then(cb, eb));
      send.on("produce", ({ kind, rtpParameters, appData }, cb, eb) =>
        req<{ id: string }>("produce", { transportId: send.id, kind, rtpParameters, source: appData.source }).then(cb, eb)
      );
      const recv = device.createRecvTransport(await req<any>("createTransport"));
      recv.on("connect", ({ dtlsParameters }, cb, eb) => req("connectTransport", { transportId: recv.id, dtlsParameters }).then(cb, eb));

      session.current = { socket, req, send, recv, producers: {}, consumers: new Map() };
      ready();
      setJoined(true);

      for (const p of joinRes.producers) consume(p.producerId, p.peerId, p.source).catch(console.error);
      if (wantMic) await start("mic").catch(() => setError("Microphone unavailable"));
      if (wantCam) await start("cam").catch(() => setError("Camera unavailable"));
    } catch (e: any) {
      teardown();
      setError(e?.message ?? "Failed to join");
    } finally {
      setJoining(false);
    }
  }

  async function start(source: Source) {
    const s = session.current;
    if (!s || s.producers[source]) return;
    let track: MediaStreamTrack;
    if (source === "screen") {
      track = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0];
      track.onended = () => stop("screen");
    } else if (source === "mic") {
      track = (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })).getAudioTracks()[0];
    } else {
      track = (await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })).getVideoTracks()[0];
    }
    const producer = await s.send.produce({
      track,
      appData: { source },
      ...(source === "screen" ? {} : source === "cam" ? { encodings: [{ maxBitrate: 1_200_000 }] } : {}),
    });
    s.producers[source] = producer;
    setLocal((l) => ({ ...l, [source]: track }));
  }

  async function stop(source: Source) {
    const s = session.current;
    const p = s?.producers[source];
    if (!s || !p) return;
    delete s.producers[source];
    p.track?.stop();
    p.close();
    setLocal((l) => ({ ...l, [source]: undefined }));
    await s.req("closeProducer", { producerId: p.id }).catch(() => {});
  }

  const toggle = (source: Source) => (local[source] ? stop(source) : start(source).catch((e) => e?.name !== "NotAllowedError" && setError(String(e?.message ?? e))));

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    session.current?.socket.emit("chat", { text: draft });
    setDraft("");
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const leave = () => {
    teardown();
    onLeave();
  };

  if (!joined) {
    return (
      <main className="flex h-full items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Join call</CardTitle>
            <CardDescription className="font-mono text-xs">{roomId}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), join())}>
              <Input autoFocus placeholder="Your name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              <div className="flex gap-2">
                <Button type="button" variant={wantMic ? "secondary" : "outline"} className="flex-1" onClick={() => setWantMic(!wantMic)}>
                  {wantMic ? <Mic /> : <MicOff />} {wantMic ? "Mic on" : "Mic off"}
                </Button>
                <Button type="button" variant={wantCam ? "secondary" : "outline"} className="flex-1" onClick={() => setWantCam(!wantCam)}>
                  {wantCam ? <Video /> : <VideoOff />} {wantCam ? "Cam on" : "Cam off"}
                </Button>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={onLeave}>
                  Back
                </Button>
                <Button type="submit" className="flex-1" disabled={joining}>
                  {joining ? "Joining…" : "Join"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  const myName = name.trim() || "Guest";
  const tiles: React.ReactNode[] = [];
  if (local.screen) tiles.push(<Tile key="me-screen" name="Your screen" video={local.screen} screen />);
  for (const [id, r] of Object.entries(remotes)) if (r.screen) tiles.push(<Tile key={id + "-screen"} name={`${r.name}'s screen`} video={r.screen} screen />);
  tiles.push(<Tile key="me" name={`${myName} (you)`} video={local.cam} mic={!!local.mic} mirror />);
  for (const [id, r] of Object.entries(remotes)) tiles.push(<Tile key={id} name={r.name} video={r.cam} mic={!!r.mic} />);

  const cols = tiles.length <= 1 ? "grid-cols-1" : tiles.length <= 4 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 lg:grid-cols-3";

  return (
    <div className="flex h-full flex-col">
      {Object.entries(remotes).map(([id, r]) => r.mic && <AudioOut key={id} track={r.mic} />)}
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="text-sm">
          <span className="font-semibold">Callio</span>
          <span className="ml-2 text-muted-foreground">{Object.keys(remotes).length + 1} in call</span>
        </div>
        <Button variant="outline" size="sm" onClick={copyLink}>
          {copied ? <Check /> : <Link2 />} {copied ? "Copied" : "Copy invite link"}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className={cn("grid min-h-0 flex-1 content-center gap-3 overflow-auto p-4", cols)}>{tiles}</div>
          {error && <p className="pb-2 text-center text-sm text-destructive">{error}</p>}
          <div className="flex justify-center gap-3 pb-5">
            <Button size="icon" variant={local.mic ? "secondary" : "destructive"} onClick={() => toggle("mic")} title="Microphone">
              {local.mic ? <Mic /> : <MicOff />}
            </Button>
            <Button size="icon" variant={local.cam ? "secondary" : "destructive"} onClick={() => toggle("cam")} title="Camera">
              {local.cam ? <Video /> : <VideoOff />}
            </Button>
            <Button size="icon" variant={local.screen ? "default" : "secondary"} onClick={() => toggle("screen")} title="Share screen">
              {local.screen ? <MonitorX /> : <MonitorUp />}
            </Button>
            <Button
              size="icon"
              variant={chatOpen ? "default" : "secondary"}
              className="relative"
              onClick={() => {
                setChatOpen(!chatOpen);
                setUnread(0);
              }}
              title="Chat"
            >
              <MessageSquare />
              {unread > 0 && !chatOpen && (
                <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] text-white">{unread}</span>
              )}
            </Button>
            <Button size="icon" variant="destructive" className="w-14" onClick={leave} title="Leave">
              <PhoneOff />
            </Button>
          </div>
        </div>

        {chatOpen && (
          <aside className="absolute inset-0 z-10 flex flex-col bg-background sm:static sm:w-80 sm:border-l">
            <div className="flex items-center justify-between border-b px-4 py-2">
              <span className="text-sm font-medium">Chat</span>
              <Button size="sm" variant="ghost" onClick={() => setChatOpen(false)}>
                <X />
              </Button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 && <p className="text-center text-sm text-muted-foreground">No messages yet</p>}
              {messages.map((m) => (
                <div key={m.id} className={cn("flex flex-col", m.from === selfId && "items-end")}>
                  <span className="mb-1 text-xs text-muted-foreground">
                    {m.from === selfId ? "You" : m.name} · {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <div className={cn("max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm", m.from === selfId ? "bg-primary text-primary-foreground" : "bg-secondary")}>
                    {m.text}
                  </div>
                </div>
              ))}
              <div ref={chatEnd} />
            </div>
            <form className="flex gap-2 border-t p-3" onSubmit={sendChat}>
              <Input placeholder="Message" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <Button type="submit" size="default" disabled={!draft.trim()}>
                <Send />
              </Button>
            </form>
          </aside>
        )}
      </div>
    </div>
  );
}
