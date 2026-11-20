// Media over WebSocket: WebCodecs encode -> server relay -> WebCodecs decode.
export type Source = "mic" | "cam" | "screen";
export type Packet = { s: Source; k: 0 | 1; t: number; q?: number; d: ArrayBuffer | Uint8Array };
type Send = (p: Packet) => void;

const SAMPLE_RATE = 48000;
const AUDIO_FRAME = 960; // 20ms @ 48kHz

let sharedCtx: AudioContext | null = null;
/** Call synchronously inside a click handler so audio is allowed to start. */
export function audioCtx() {
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  sharedCtx.resume();
  return sharedCtx;
}

export function supported() {
  return typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined" && typeof AudioWorkletNode !== "undefined";
}

// Worker-based ticker: not throttled when the tab is in the background.
function ticker(ms: number, fn: () => void) {
  const w = new Worker(URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${ms})`], { type: "text/javascript" })));
  w.onmessage = fn;
  return () => w.terminate();
}

export class VideoSender {
  private enc: VideoEncoder | null = null;
  private canvas = new OffscreenCanvas(2, 2);
  private ctx2d = this.canvas.getContext("2d")!;
  private video: HTMLVideoElement;
  private stopTick: () => void;
  private forceKey = true;
  private lastKey = 0;
  private t0 = performance.now();
  private seq = 0;

  constructor(
    track: MediaStreamTrack,
    private source: Source,
    private send: Send,
    private opts: { fps: number; bitrate: number; maxW: number; maxH: number }
  ) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = new MediaStream([track]);
    this.video.play().catch(() => {});
    this.stopTick = ticker(1000 / opts.fps, () => this.tick());
  }

  requestKey() {
    this.forceKey = true;
  }

  private tick() {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    const scale = Math.min(1, this.opts.maxW / v.videoWidth, this.opts.maxH / v.videoHeight);
    const w = Math.round((v.videoWidth * scale) / 2) * 2;
    const h = Math.round((v.videoHeight * scale) / 2) * 2;

    if (!this.enc || this.canvas.width !== w || this.canvas.height !== h) {
      this.enc?.close();
      this.canvas.width = w;
      this.canvas.height = h;
      this.enc = new VideoEncoder({
        output: (chunk) => {
          const d = new Uint8Array(chunk.byteLength);
          chunk.copyTo(d);
          this.send({ s: this.source, k: chunk.type === "key" ? 1 : 0, t: chunk.timestamp, q: this.seq++, d });
        },
        error: (e) => {
          console.error("encoder", e);
          this.enc = null;
        },
      });
      this.enc.configure({ codec: "vp8", width: w, height: h, bitrate: this.opts.bitrate, framerate: this.opts.fps, latencyMode: "realtime" });
      this.forceKey = true;
    }
    if (this.enc.encodeQueueSize > 2) return; // drop frames instead of building latency

    this.ctx2d.drawImage(v, 0, 0, w, h);
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round((performance.now() - this.t0) * 1000) });
    const now = performance.now();
    const keyFrame = this.forceKey || now - this.lastKey > 3000;
    if (keyFrame) {
      this.forceKey = false;
      this.lastKey = now;
    }
    this.enc.encode(frame, { keyFrame });
    frame.close();
  }

  stop() {
    this.stopTick();
    if (this.enc?.state !== "closed") this.enc?.close();
    this.video.srcObject = null;
  }
}

const CAPTURE_WORKLET = `
class Cap extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
}
registerProcessor("cap", Cap);`;
let workletLoaded: Promise<void> | null = null;

export class AudioSender {
  private enc: AudioEncoder;
  private node?: AudioWorkletNode;
  private src?: MediaStreamAudioSourceNode;
  private buf = new Float32Array(AUDIO_FRAME);
  private fill = 0;
  private n = 0;

  private constructor(private send: Send) {
    this.enc = new AudioEncoder({
      output: (chunk) => {
        const d = new Uint8Array(chunk.byteLength);
        chunk.copyTo(d);
        this.send({ s: "mic", k: 1, t: chunk.timestamp, d });
      },
      error: (e) => console.error("audio encoder", e),
    });
    this.enc.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 32000 });
  }

  static async create(track: MediaStreamTrack, send: Send) {
    const ctx = audioCtx();
    workletLoaded ??= ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" })));
    await workletLoaded;
    const s = new AudioSender(send);
    s.src = ctx.createMediaStreamSource(new MediaStream([track]));
    s.node = new AudioWorkletNode(ctx, "cap", { numberOfOutputs: 1 });
    s.node.port.onmessage = (e) => s.push(e.data as Float32Array);
    s.src.connect(s.node);
    s.node.connect(ctx.destination); // outputs silence; keeps the node pulled
    return s;
  }

  private push(samples: Float32Array) {
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(AUDIO_FRAME - this.fill, samples.length - i);
      this.buf.set(samples.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === AUDIO_FRAME) {
        const data = new AudioData({
          format: "f32-planar",
          sampleRate: SAMPLE_RATE,
          numberOfFrames: AUDIO_FRAME,
          numberOfChannels: 1,
          timestamp: this.n++ * 20000,
          data: this.buf.slice(),
        });
        if (this.enc.state === "configured") this.enc.encode(data);
        data.close();
        this.fill = 0;
      }
    }
  }

  requestKey() {}

  stop() {
    this.src?.disconnect();
    this.node?.disconnect();
    if (this.enc.state !== "closed") this.enc.close();
  }
}

/** Decodes incoming packets: video onto registered canvases, audio to speakers. */
export class Receiver {
  canvases = new Map<string, HTMLCanvasElement>();
  private video = new Map<string, { dec: VideoDecoder; gotKey: boolean; seq: number }>();
  private audio = new Map<string, { dec: AudioDecoder; next: number }>();
  private lastKeyReq = 0;

  constructor(private needKey: () => void) {}

  private askKey() {
    const now = performance.now();
    if (now - this.lastKeyReq < 500) return;
    this.lastKeyReq = now;
    this.needKey();
  }

  handle(peerId: string, p: Packet) {
    const key = `${peerId}:${p.s}`;
    if (p.s === "mic") return this.handleAudio(key, p);

    let st = this.video.get(key);
    if (!st || st.dec.state === "closed") {
      const dec = new VideoDecoder({
        output: (f) => {
          const c = this.canvases.get(key);
          if (c) {
            if (c.width !== f.displayWidth || c.height !== f.displayHeight) {
              c.width = f.displayWidth;
              c.height = f.displayHeight;
            }
            c.getContext("2d")!.drawImage(f, 0, 0);
          }
          f.close();
        },
        error: () => {
          this.video.delete(key);
          this.askKey();
        },
      });
      dec.configure({ codec: "vp8", optimizeForLatency: true });
      st = { dec, gotKey: false, seq: -1 };
      this.video.set(key, st);
    }
    // A lost delta frame corrupts every following frame until the next keyframe:
    // on any gap, freeze on the last good frame and wait for a fresh keyframe.
    const gap = p.q !== undefined && st.seq >= 0 && p.q !== st.seq + 1;
    if (p.q !== undefined) st.seq = p.q;
    if (gap && !p.k) st.gotKey = false;
    if (!st.gotKey) {
      if (!p.k) return this.askKey();
      st.gotKey = true;
    }
    if (st.dec.decodeQueueSize > 10) {
      // fell behind: reset and wait for a fresh keyframe
      st.dec.reset();
      st.dec.configure({ codec: "vp8", optimizeForLatency: true });
      st.gotKey = false;
      return this.askKey();
    }
    st.dec.decode(new EncodedVideoChunk({ type: p.k ? "key" : "delta", timestamp: p.t, data: p.d }));
  }

  private handleAudio(key: string, p: Packet) {
    let st = this.audio.get(key);
    if (!st || st.dec.state === "closed") {
      const ctx = audioCtx();
      const s = { dec: null as unknown as AudioDecoder, next: 0 };
      s.dec = new AudioDecoder({
        output: (ad) => {
          const buf = ctx.createBuffer(ad.numberOfChannels, ad.numberOfFrames, ad.sampleRate);
          for (let ch = 0; ch < ad.numberOfChannels; ch++) {
            const arr = new Float32Array(ad.numberOfFrames);
            ad.copyTo(arr, { planeIndex: ch, format: "f32-planar" });
            buf.copyToChannel(arr, ch);
          }
          ad.close();
          const node = ctx.createBufferSource();
          node.buffer = buf;
          node.connect(ctx.destination);
          const now = ctx.currentTime;
          // small jitter buffer; resync if we drift too far behind or ahead
          if (s.next < now + 0.01 || s.next > now + 0.3) s.next = now + 0.06;
          node.start(s.next);
          s.next += buf.duration;
        },
        error: () => this.audio.delete(key),
      });
      s.dec.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
      st = s;
      this.audio.set(key, st);
    }
    st.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: p.t, data: p.d }));
  }

  drop(peerId: string, source?: Source) {
    for (const map of [this.video, this.audio] as Map<string, { dec: VideoDecoder | AudioDecoder }>[]) {
      for (const [k, v] of map) {
        if (k === `${peerId}:${source}` || (!source && k.startsWith(peerId + ":"))) {
          if (v.dec.state !== "closed") v.dec.close();
          map.delete(k);
        }
      }
    }
  }

  close() {
    for (const map of [this.video, this.audio] as Map<string, { dec: VideoDecoder | AudioDecoder }>[]) {
      for (const v of map.values()) if (v.dec.state !== "closed") v.dec.close();
      map.clear();
    }
  }
}
