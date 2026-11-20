import { useEffect, useRef, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import { Mic, MicOff, Video, VideoOff, MonitorUp, MonitorX, MessageSquare, PhoneOff, Link2, Check, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AudioSender, Receiver, VideoSender, audioCtx, supported, type Packet, type Source } from "@/lib/media";

type Remote = { name: string } & Partial<Record<Source, boolean>>;
type Msg = { id: string; from: string; name: string; text: string; ts: number };

type Session = {
  socket: Socket;
  recv: Receiver;
  senders: Partial<Record<Source, { stop(): void; requestKey(): void }>>;
};

function MediaView({ track, mirror }: { track: MediaStreamTrack; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={cn("h-full w-full object-contain", mirror && "-scale-x-100")} />;
}

function RemoteCanvas({ recv, id }: { recv: Receiver; id: string }) {
  return (
    <canvas
      ref={(el) => {
        if (el) recv.canvases.set(id, el);
        else recv.canvases.delete(id);
      }}
      className="h-full w-full object-contain"
    />
  );
}

function Tile({ name, media, mic, screen }: { name: string; media?: ReactNode; mic?: boolean; screen?: boolean }) {
  return (
    <div className="relative flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-xl border bg-card">
      {media ?? <div className="flex size-20 items-center justify-center rounded-full bg-secondary text-2xl font-semibold uppercase">{name.slice(0, 1)}</div>}
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
  const [error, setError] = useState(() => (supported() ? "" : "This browser does not support WebCodecs. Use a recent Chrome, Edge, Firefox or Safari."));
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
  const tracks = useRef<Partial<Record<Source, MediaStreamTrack>>>({});
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), [messages, chatOpen]);
  useEffect(() => () => teardown(), []);

  function teardown() {
    const s = session.current;
    session.current = null;
    if (!s) return;
    Object.values(s.senders).forEach((x) => x?.stop());
    Object.values(tracks.current).forEach((t) => t?.stop());
    tracks.current = {};
    s.recv.close();
    s.socket.disconnect();
  }

  async function join() {
    audioCtx(); // unlock audio inside the click
    setJoining(true);
    setError("");
    localStorage.setItem("callio:name", name);
    try {
      const socket = io({ transports: ["websocket"] });
      const recv = new Receiver(() => socket.emit("needKey"));
      session.current = { socket, recv, senders: {} };

      socket.on("peerJoined", ({ id, name }) => setRemotes((r) => ({ ...r, [id]: { name } })));
      socket.on("peerLeft", ({ id }) => {
        recv.drop(id);
        setRemotes((r) => {
          const { [id]: _, ...rest } = r;
          return rest;
        });
      });
      socket.on("source", ({ peerId, source, on }: { peerId: string; source: Source; on: boolean }) => {
        if (!on) recv.drop(peerId, source);
        setRemotes((r) => (r[peerId] ? { ...r, [peerId]: { ...r[peerId], [source]: on } } : r));
      });
      socket.on("media", (peerId: string, p: Packet) => recv.handle(peerId, p));
      socket.on("needKey", () => Object.values(session.current?.senders ?? {}).forEach((x) => x?.requestKey()));
      socket.on("chat", (m: Msg) => {
        setMessages((ms) => [...ms, m]);
        if (!chatOpenRef.current) setUnread((u) => u + 1);
      });
      socket.on("disconnect", () => setError("Disconnected from server"));

      const joinRes = await new Promise<any>((res, rej) =>
        socket.emit("join", { roomId, name: name.trim() || "Guest" }, (r: any) => (r?.error ? rej(new Error(r.error)) : res(r)))
      );
      setSelfId(joinRes.selfId);
      setRemotes(
        Object.fromEntries(joinRes.peers.map((p: any) => [p.id, { name: p.name, ...Object.fromEntries(p.sources.map((s: string) => [s, true])) }]))
      );
      setJoined(true);

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
    if (!s || s.senders[source]) return;
    let track: MediaStreamTrack;
    if (source === "screen") {
      track = (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 } })).getVideoTracks()[0];
      track.onended = () => stop("screen");
    } else if (source === "mic") {
      track = (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })).getAudioTracks()[0];
    } else {
      track = (await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })).getVideoTracks()[0];
    }
    const send = (p: Packet) => s.socket.connected && s.socket.emit("media", p);
    s.senders[source] =
      source === "mic"
        ? await AudioSender.create(track, send)
        : new VideoSender(track, source, send, source === "cam" ? { fps: 24, bitrate: 900_000, maxW: 1280, maxH: 720 } : { fps: 12, bitrate: 1_800_000, maxW: 1920, maxH: 1080 });
    tracks.current[source] = track;
    setLocal((l) => ({ ...l, [source]: track }));
    s.socket.emit("source", { source, on: true });
  }

  async function stop(source: Source) {
    const s = session.current;
    if (!s?.senders[source]) return;
    s.senders[source]!.stop();
    delete s.senders[source];
    tracks.current[source]?.stop();
    delete tracks.current[source];
    setLocal((l) => ({ ...l, [source]: undefined }));
    s.socket.emit("source", { source, on: false });
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
  const screens: React.ReactNode[] = [];
  if (local.screen) screens.push(<Tile key="me-screen" name="Your screen" media={<MediaView track={local.screen} />} screen />);
  for (const [id, r] of Object.entries(remotes)) if (r.screen) screens.push(<Tile key={id + "-screen"} name={`${r.name}'s screen`} media={<RemoteCanvas recv={session.current!.recv} id={`${id}:screen`} />} screen />);
  const people: React.ReactNode[] = [<Tile key="me" name={`${myName} (you)`} media={local.cam && <MediaView track={local.cam} mirror />} mic={!!local.mic} />];
  for (const [id, r] of Object.entries(remotes)) people.push(<Tile key={id} name={r.name} media={r.cam && <RemoteCanvas recv={session.current!.recv} id={`${id}:cam`} />} mic={!!r.mic} />);

  const grid = (items: React.ReactNode[]) => {
    const cols = Math.ceil(Math.sqrt(items.length));
    const rows = Math.ceil(items.length / cols);
    return (
      <div
        className="grid h-full min-h-0 w-full gap-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {items}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
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
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:flex-row">
            {screens.length > 0 ? (
              <>
                <div className="min-h-0 min-w-0 flex-[3]">{grid(screens)}</div>
                <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-auto md:max-w-72 md:flex-col">
                  {people.map((t, i) => (
                    <div key={i} className="aspect-video w-48 shrink-0 md:w-full">{t}</div>
                  ))}
                </div>
              </>
            ) : (
              grid(people)
            )}
          </div>
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
