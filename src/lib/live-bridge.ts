import { createWriteStream, type WriteStream } from "node:fs";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { appendEvent } from "@/lib/events";

// Live mode: holding the send button for a second opens a spoken, full-duplex
// conversation with OpenAI's gpt-live-1. The ESP32 cannot hold credentials or
// speak WebRTC, so it opens a plain TCP socket to this bridge and streams raw
// PCM16 mono 16 kHz from the EMEET microphone; the bridge relays it to the model
// and writes the model's audio back in the same format. Closing the socket from
// either side ends the session.
//
// Two ways to reach the model (LIVE_PROVIDER):
// - "codex" (default): the Codex CLI's app-server brokers a gpt-live-1-codex
//   session on the ChatGPT subscription it is logged in with. Codex only does
//   that over WebRTC, so the bridge is the WebRTC peer a browser would be.
// - "openai": the Live API over a WebSocket, billed per minute to OPENAI_API_KEY.
const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
const SAMPLE_RATE = 16000;
const UPLINK_CHUNK_BYTES = SAMPLE_RATE * 2 / 10; // 100 ms per append
// Sessions cost money or subscription quota, so nobody may leave one open by accident.
const WRAP_UP_BEFORE_END_MS = 25_000;
const CLOSE_GRACE_MS = 5_000;
const GREETING_DELAY_MS = 700;
const MAX_DOWNLINK_BACKLOG_BYTES = SAMPLE_RATE; // half a second

const INSTRUCTIONS = `Sos Chapu, una caja parlante amiga de los chicos de la casa: Dan, Chloe y Chiara. Hablás con uno de ellos, o con varios a la vez.
Cuando sepas quién es, llamalo por su nombre.
Hablá siempre en español rioplatense, con voseo, cálido, juguetón y con entusiasmo, a un ritmo tranquilo.
Usá frases cortas y palabras simples. Una idea por vez, y después dejá hablar.
Todo lo que digas tiene que ser apto para chicos. Si aparece un tema que no es para chicos o algo que preocupa, decí con cariño que eso lo charle con mamá o papá y proponé otra cosa.
No pidas datos personales. Si no sabés algo, decilo y no inventes.

Al empezar preguntá quién anda por ahí. Cuando te contesten, ofrecé estas cuatro opciones y esperá a que elijan:
- Trivia: preguntas de a una, de dificultad para chicos, con pistas si le cuesta. Festejá los aciertos y llevá la cuenta.
- Aprender algo en profundidad: preguntá de qué tema, explicalo de a pedacitos con ejemplos y comparaciones, y cada tanto chequeá si se entendió o qué más quiere saber.
- Un dato curioso: contá uno sorprendente y verdadero, cortito, y preguntá si quiere otro.
- Charlar de cualquier cosa: seguile la conversación con curiosidad y preguntas.
Si cambia de idea en el medio, cambiá de actividad sin problema. Si no elige, proponé vos una.

Backchannel policy: Usá pocos sonidos de escucha, breves, sin tapar al chico.

Interruption policy: Si el chico te interrumpe, callate enseguida y escuchá.

Delegation policy: No hay backend ni herramientas. Nunca delegues: respondé siempre vos con lo que sabés.`;

const GREETING = "Saludá ahora en español, en una frase corta y alegre, decí que sos Chapu y preguntá quién anda por ahí: ¿Dan, Chloe, Chiara? Después escuchá. Cuando te digan quién es, saludalo por su nombre y ofrecé las cuatro opciones: una trivia, aprender algo bien a fondo, un dato curioso, o charlar de lo que quiera.";
const WRAP_UP = "Se termina el tiempo de charla. Cerrá la idea en una frase, despedite con cariño ahora y decí que para seguir hay que volver a mantener apretado el botón rojo grande.";

// What a provider gives the session: a model that hears PCM16 mono 16 kHz and answers in it.
type Upstream = {
  sendAudio(pcm: Buffer): void;
  instruct(text: string): void;
  // Ends the conversation on the provider's side and settles the usage.
  close(): Promise<void>;
};

type UpstreamHandlers = {
  onStarted(): void;
  onAudio(pcm: Buffer): void;
  onUserSpeech(): void;
  onUsage(seconds: number): void;
  onError(message: string): void;
  onEnded(): void;
};

function minutesFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// ---------- OpenAI Live API over WebSocket (API key) ----------

type LiveEvent = {
  type: string;
  delta?: string;
  delegation?: { id?: string };
  usage?: { seconds?: number };
  error?: { message?: string };
};

function openaiUpstream(handlers: UpstreamHandlers): Upstream | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    handlers.onError("falta OPENAI_API_KEY en .env.local");
    return null;
  }
  // Node's WebSocket accepts request headers as an extension to the DOM signature.
  const ws = new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(
    LIVE_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  let started = false;
  let pending: Buffer = Buffer.alloc(0);
  let closed: (() => void) | null = null;

  const send = (event: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };

  ws.onopen = () => {
    send({
      type: "session.start",
      event_id: "start",
      session: {
        model: process.env.OPENAI_LIVE_MODEL || "gpt-live-1",
        instructions: INSTRUCTIONS,
        audio: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          output: { voice: process.env.OPENAI_LIVE_VOICE || "marin" },
        },
      },
    });
  };
  ws.onmessage = (message) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(String(message.data)) as LiveEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "session.output_audio.delta":
        if (event.delta) handlers.onAudio(Buffer.from(event.delta, "base64"));
        break;
      case "session.started":
        started = true;
        handlers.onStarted();
        break;
      case "session.input_transcript.delta":
        handlers.onUserSpeech();
        break;
      case "session.delegation.created":
        // Client delegation is the only mode without a backend bill; answer it so the model never waits.
        send({
          type: "session.thinking.append",
          delegation_id: event.delegation?.id ?? null,
          content: "No hay backend disponible. Respondé vos con lo que sabés.",
        });
        break;
      case "session.usage.updated":
      case "session.closed":
        if (typeof event.usage?.seconds === "number") handlers.onUsage(event.usage.seconds);
        if (event.type === "session.closed") closed?.();
        break;
      case "error":
        handlers.onError(event.error?.message ?? "error de OpenAI");
        break;
    }
  };
  ws.onerror = () => {
    if (!started) handlers.onError("no se pudo conectar con OpenAI");
  };
  ws.onclose = () => {
    closed?.();
    handlers.onEnded();
  };

  return {
    sendAudio(pcm) {
      if (!started) return; // the model is not listening yet
      pending = pending.length ? Buffer.concat([pending, pcm]) : pcm;
      while (pending.length >= UPLINK_CHUNK_BYTES) {
        send({ type: "session.input_audio.append", audio: pending.subarray(0, UPLINK_CHUNK_BYTES).toString("base64") });
        pending = pending.subarray(UPLINK_CHUNK_BYTES);
      }
    },
    instruct(text) {
      send({ type: "session.instructions.append", delegation_id: null, content: text });
    },
    async close() {
      if (started && ws.readyState === WebSocket.OPEN) {
        started = false;
        // The final usage only arrives with session.closed.
        await new Promise<void>((resolve) => {
          closed = resolve;
          send({ type: "session.close" });
          setTimeout(resolve, CLOSE_GRACE_MS);
        });
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}

// ---------- gpt-live-1-codex through `codex app-server` (ChatGPT subscription) ----------

type RpcMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
type RpcListener = (method: string, params: Record<string, unknown>) => void;

// One app-server for every conversation, started on first use and replaced if it dies.
class CodexAppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<RpcListener>();
  alive = true;
  ready: Promise<void>;

  constructor() {
    this.child = spawn(process.env.CODEX_BIN || "codex",
      ["app-server", "--listen", "stdio://", "-c", "features.realtime_conversation=true", "-c", "suppress_unstable_features_warning=true"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` } });
    this.child.stderr.resume();
    this.child.on("error", () => this.died());
    this.child.on("exit", () => this.died());
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "error de Codex"));
        else waiter.resolve(message.result);
      } else if (message.method) {
        this.listeners.forEach((listener) => listener(message.method!, message.params ?? {}));
      }
    });
    this.ready = this.request("initialize", {
      clientInfo: { name: "chapu", title: "Chapu", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    });
    this.ready.catch(() => undefined);
  }

  private died() {
    if (!this.alive) return;
    this.alive = false;
    this.pending.forEach((waiter) => waiter.reject(new Error("Codex se cerró")));
    this.pending.clear();
    this.listeners.forEach((listener) => listener("exit", {}));
  }

  request(method: string, params: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.alive) {
        reject(new Error("Codex no está corriendo"));
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Codex no respondió a ${method}`));
      }, 30_000);
    });
  }

  on(listener: RpcListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const codexState = globalThis as typeof globalThis & { chapuCodex?: CodexAppServer };

function codexAppServer() {
  if (!codexState.chapuCodex?.alive) codexState.chapuCodex = new CodexAppServer();
  return codexState.chapuCodex;
}

// The slice of @roamhq/wrtc this bridge uses. It is a native module, loaded at
// run time so the bundler leaves it alone.
type AudioFrame = { samples: Int16Array; sampleRate: number; bitsPerSample?: number; channelCount?: number; numberOfFrames?: number };
type Wrtc = {
  RTCPeerConnection: typeof RTCPeerConnection;
  MediaStream: typeof MediaStream;
  nonstandard: {
    RTCAudioSource: new () => { createTrack(): MediaStreamTrack; onData(frame: AudioFrame): void };
    RTCAudioSink: new (track: MediaStreamTrack) => { ondata: ((frame: AudioFrame) => void) | null; stop(): void };
  };
};

const RTC_FRAME_SAMPLES = SAMPLE_RATE / 100; // WebRTC audio moves in 10 ms frames
const ICE_SETTLE_MS = 1500;

function codexUpstream(handlers: UpstreamHandlers): Upstream | null {
  let wrtc: Wrtc;
  try {
    wrtc = createRequire(path.join(process.cwd(), "package.json"))("@roamhq/wrtc") as Wrtc;
  } catch {
    handlers.onError("falta el módulo @roamhq/wrtc (npm install)");
    return null;
  }
  const codex = codexAppServer();
  const peer = new wrtc.RTCPeerConnection();
  const source = new wrtc.nonstandard.RTCAudioSource();
  const track = source.createTrack();
  peer.addTrack(track, new wrtc.MediaStream([track]));
  const channel = peer.createDataChannel("oai-events", { ordered: true });
  let sink: { stop(): void } | null = null;
  let threadId: string | null = null;
  let started = false;
  let ended = false;
  let pending: Buffer = Buffer.alloc(0);

  const end = () => {
    if (ended) return;
    ended = true;
    off();
    sink?.stop();
    track.stop();
    peer.close();
    handlers.onEnded();
  };

  const off = codex.on((method, params) => {
    if (method === "exit") {
      handlers.onError("Codex se cerró en medio de la charla");
      end();
    }
    if (!threadId || params.threadId !== threadId) return;
    if (method === "thread/realtime/transcript/delta" && params.role === "user") handlers.onUserSpeech();
    if (method === "thread/realtime/error") handlers.onError(String(params.message ?? "error de Codex"));
    if (method === "thread/realtime/error" || method === "thread/realtime/closed") end();
  });

  channel.onmessage = ({ data }) => {
    let event: { type?: string; usage?: { audio_duration_ms?: number } };
    try {
      event = JSON.parse(String(data));
    } catch {
      return;
    }
    if (event.type === "session.started" && !started) {
      started = true;
      handlers.onStarted();
    }
    if (event.type === "session.usage.updated" && typeof event.usage?.audio_duration_ms === "number") {
      handlers.onUsage(Math.round(event.usage.audio_duration_ms / 1000));
    }
  };
  peer.ontrack = ({ track: remote }) => {
    const audioSink = new wrtc.nonstandard.RTCAudioSink(remote);
    sink = audioSink;
    audioSink.ondata = (frame) => {
      if (!started) return;
      // Whatever rate and layout the decoder hands over, the box wants mono 16 kHz.
      const channels = frame.channelCount ?? 1;
      const step = Math.max(1, Math.round(frame.sampleRate / SAMPLE_RATE)) * channels;
      const pcm = Buffer.alloc(Math.floor(frame.samples.length / step) * 2);
      for (let i = 0; i < pcm.length / 2; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += frame.samples[i * step + j];
        pcm.writeInt16LE(Math.round(sum / step), i * 2);
      }
      handlers.onAudio(pcm);
    };
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed" || peer.connectionState === "closed") end();
  };

  void (async () => {
    const cwd = path.join(process.cwd(), "data", "live-codex"); // empty on purpose: Codex has nothing to read here
    mkdirSync(cwd, { recursive: true });
    await codex.ready;
    const thread = await codex.request("thread/start", {
      ephemeral: true, sandbox: "read-only", approvalPolicy: "never", developerInstructions: INSTRUCTIONS, cwd,
    }) as { thread: { id: string } };
    threadId = thread.thread.id;
    await peer.setLocalDescription(await peer.createOffer({ offerToReceiveAudio: true }));
    // OpenAI answers with its own candidates, so a complete local gather is not required.
    await new Promise<void>((resolve) => {
      const done = () => peer.iceGatheringState === "complete" && resolve();
      peer.onicegatheringstatechange = done;
      done();
      setTimeout(resolve, ICE_SETTLE_MS);
    });
    const answer = new Promise<string>((resolve, reject) => {
      const offAnswer = codex.on((method, params) => {
        if (params.threadId !== threadId) return;
        if (method === "thread/realtime/sdp") { offAnswer(); resolve(String(params.sdp)); }
        if (method === "thread/realtime/error") { offAnswer(); reject(new Error(String(params.message))); }
      });
      setTimeout(() => { offAnswer(); reject(new Error("Codex no contestó la conexión de voz")); }, 30_000);
    });
    await codex.request("thread/realtime/start", {
      threadId,
      transport: { type: "webrtc", sdp: peer.localDescription?.sdp },
      outputModality: "audio",
      version: "v3",
      voice: process.env.CODEX_LIVE_VOICE || "sol",
      model: process.env.CODEX_LIVE_MODEL || "gpt-live-1-codex",
      initialItems: [{ role: "developer", text: INSTRUCTIONS }],
    });
    if (ended) return;
    await peer.setRemoteDescription({ type: "answer", sdp: await answer });
  })().catch((error: Error) => {
    if (ended) return;
    handlers.onError(error.message);
    end();
  });

  return {
    sendAudio(pcm) {
      if (ended) return;
      pending = pending.length ? Buffer.concat([pending, pcm]) : pcm;
      const frameBytes = RTC_FRAME_SAMPLES * 2;
      while (pending.length >= frameBytes) {
        const samples = new Int16Array(RTC_FRAME_SAMPLES);
        for (let i = 0; i < RTC_FRAME_SAMPLES; i++) samples[i] = pending.readInt16LE(i * 2);
        source.onData({ samples, sampleRate: SAMPLE_RATE, bitsPerSample: 16, channelCount: 1, numberOfFrames: RTC_FRAME_SAMPLES });
        pending = pending.subarray(frameBytes);
      }
    },
    instruct(text) {
      if (threadId && !ended) void codex.request("thread/realtime/appendText", { threadId, role: "developer", text }).catch(() => undefined);
    },
    async close() {
      if (threadId && !ended) await codex.request("thread/realtime/stop", { threadId }).catch(() => undefined);
      end();
    },
  };
}

// ---------- one conversation with the box ----------

function runSession(socket: net.Socket) {
  const maxMs = minutesFromEnv("OPENAI_LIVE_MAX_MINUTES", 10) * 60_000;
  const idleMs = minutesFromEnv("OPENAI_LIVE_IDLE_MINUTES", 2) * 60_000;
  const viaCodex = (process.env.LIVE_PROVIDER || "codex") !== "openai";
  let started = false;
  let closing = false;
  let finished = false;
  let closeReason = "se cortó la conexión con el modelo";
  let usageSeconds: number | null = null;
  let lastSpeechAt = Date.now();
  const timers: NodeJS.Timeout[] = [];

  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    clearInterval(idleTimer);
    socket.destroy();
    dump?.end();
    if (activeSession === close) activeSession = null;
    const duration = usageSeconds === null ? "" : ` (${usageSeconds} s)`;
    void appendEvent("device", `Modo charla terminado: ${reason}${duration}`);
  };

  // Let the provider finalize so the used time is known, then drop everything.
  const close = (reason: string) => {
    if (finished || closing) return;
    closing = true;
    started = false; // stop relaying microphone audio
    closeReason = reason;
    socket.end();
    timers.push(setTimeout(() => finish(reason), CLOSE_GRACE_MS + 1_000));
    void upstream?.close().then(() => finish(reason));
  };

  const upstream = (viaCodex ? codexUpstream : openaiUpstream)({
    onStarted() {
      started = true;
      lastSpeechAt = Date.now();
      // Sent at once the model ignores it: it only opens the conversation after hearing some input audio.
      timers.push(setTimeout(() => upstream?.instruct(GREETING), GREETING_DELAY_MS));
      timers.push(setTimeout(() => upstream?.instruct(WRAP_UP), Math.max(0, maxMs - WRAP_UP_BEFORE_END_MS)));
      timers.push(setTimeout(() => close("se cumplió el tiempo máximo"), maxMs));
      void appendEvent("device", `Modo charla iniciado (${viaCodex ? "suscripción de Codex" : "API de OpenAI"})`);
    },
    onAudio(pcm) {
      // The box plays in real time; anything piling up here would only add delay, so it is dropped.
      if (socket.writable && socket.writableLength < MAX_DOWNLINK_BACKLOG_BYTES) socket.write(pcm);
    },
    onUserSpeech() {
      lastSpeechAt = Date.now();
    },
    onUsage(seconds) {
      usageSeconds = seconds;
    },
    onError(message) {
      void appendEvent("error", `Modo charla: ${message}`);
    },
    onEnded() {
      finish(closeReason);
    },
  });

  const idleTimer = setInterval(() => {
    if (started && Date.now() - lastSpeechAt > idleMs) close("nadie habló por un rato");
  }, 5_000);

  // LIVE_DEBUG_DUMP=1 keeps what the microphone sent, to check the audio path.
  const dump: WriteStream | null = process.env.LIVE_DEBUG_DUMP
    ? createWriteStream(path.join(process.cwd(), "data", "device", "live-mic.pcm"))
    : null;
  if (!upstream) {
    finish("no se pudo empezar");
    return;
  }
  socket.on("data", (chunk: Buffer) => {
    dump?.write(chunk);
    if (started) upstream.sendAudio(chunk);
  });
  // The box simply drops the socket, which can surface as a reset.
  socket.on("error", () => close("terminó desde la caja"));
  socket.on("close", () => close("terminó desde la caja"));

  return close;
}

let activeSession: ((reason: string) => void) | null = null;

// The web can start or stop a conversation without the physical button; the
// order rides on the next heartbeat response. Kept on globalThis because routes
// and the instrumentation hook are bundled separately.
type LiveCommand = "start" | "stop";
const commandState = globalThis as typeof globalThis & { chapuLiveCommand?: LiveCommand };

export function requestLiveCommand(command: LiveCommand) {
  commandState.chapuLiveCommand = command;
}

export function takeLiveCommand() {
  const command = commandState.chapuLiveCommand;
  commandState.chapuLiveCommand = undefined;
  return command;
}

export function startLiveBridge() {
  const state = globalThis as typeof globalThis & { chapuLiveBridge?: net.Server };
  if (state.chapuLiveBridge) return;
  const port = Number(process.env.LIVE_BRIDGE_PORT ?? 3010);
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    // A session only starts once microphone audio arrives, so a stray
    // connection to the port never opens a billed session.
    socket.once("data", () => {
      activeSession?.("empezó otra charla");
      activeSession = runSession(socket) ?? null;
    });
    socket.on("error", () => socket.destroy());
    socket.setTimeout(15_000, () => socket.destroy()); // the box streams continuously
  });
  server.on("error", (error) => {
    console.error("Live bridge could not start:", error.message);
    state.chapuLiveBridge = undefined;
  });
  server.listen(port, "0.0.0.0");
  state.chapuLiveBridge = server;
}
