import { createWriteStream, type WriteStream } from "node:fs";
import net from "node:net";
import path from "node:path";
import { appendEvent } from "@/lib/events";

// Live mode: holding the roulette button for a second opens a spoken, full-duplex
// conversation with OpenAI's gpt-live-1. The ESP32 cannot hold the API key or
// speak TLS + JSON comfortably, so it opens a plain TCP socket to this bridge and
// streams raw PCM16 mono 16 kHz from the EMEET microphone; the bridge relays it
// to OpenAI and writes the model's audio back in the same format. Closing the
// socket from either side ends the session.
const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
const SAMPLE_RATE = 16000;
const UPLINK_CHUNK_BYTES = SAMPLE_RATE * 2 / 10; // 100 ms per append
// Sessions are billed per second, so nobody may leave one open by accident.
const WRAP_UP_BEFORE_END_MS = 25_000;
const CLOSE_GRACE_MS = 5_000;
const GREETING_DELAY_MS = 700;
const MAX_DOWNLINK_BACKLOG_BYTES = SAMPLE_RATE; // half a second

const INSTRUCTIONS = `Sos Chapu, una caja parlante amiga de los chicos de la casa. Hablás con un nene o una nena.
Hablá siempre en español rioplatense, con voseo, cálido, juguetón y con entusiasmo, a un ritmo tranquilo.
Usá frases cortas y palabras simples. Una idea por vez, y después dejá hablar.
Todo lo que digas tiene que ser apto para chicos. Si aparece un tema que no es para chicos o algo que preocupa, decí con cariño que eso lo charle con mamá o papá y proponé otra cosa.
No pidas datos personales. Si no sabés algo, decilo y no inventes.

Al empezar ofrecé estas cuatro opciones y esperá a que elija:
- Trivia: preguntas de a una, de dificultad para chicos, con pistas si le cuesta. Festejá los aciertos y llevá la cuenta.
- Aprender algo en profundidad: preguntá de qué tema, explicalo de a pedacitos con ejemplos y comparaciones, y cada tanto chequeá si se entendió o qué más quiere saber.
- Un dato curioso: contá uno sorprendente y verdadero, cortito, y preguntá si quiere otro.
- Charlar de cualquier cosa: seguile la conversación con curiosidad y preguntas.
Si cambia de idea en el medio, cambiá de actividad sin problema. Si no elige, proponé vos una.

Backchannel policy: Usá pocos sonidos de escucha, breves, sin tapar al chico.

Interruption policy: Si el chico te interrumpe, callate enseguida y escuchá.

Delegation policy: No hay backend ni herramientas. Nunca delegues: respondé siempre vos con lo que sabés.`;

const GREETING = "Saludá ahora en español, en una frase corta y alegre, decí que sos Chapu y ofrecé las cuatro opciones: una trivia, aprender algo bien a fondo, un dato curioso, o charlar de lo que quiera. Preguntá cuál prefiere y después escuchá.";
const WRAP_UP = "Se termina el tiempo de charla. Cerrá la idea en una frase, despedite con cariño ahora y decí que para seguir hay que volver a mantener apretado el botón rojo.";

type LiveEvent = {
  type: string;
  delta?: string;
  delegation?: { id?: string };
  usage?: { seconds?: number };
  error?: { message?: string };
};

function minutesFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function runSession(socket: net.Socket) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    void appendEvent("error", "Modo charla: falta OPENAI_API_KEY en .env.local");
    socket.destroy();
    return;
  }
  const maxMs = minutesFromEnv("OPENAI_LIVE_MAX_MINUTES", 10) * 60_000;
  const idleMs = minutesFromEnv("OPENAI_LIVE_IDLE_MINUTES", 2) * 60_000;

  // Node's WebSocket accepts request headers as an extension to the DOM signature.
  const upstream = new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(
    LIVE_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  let started = false;
  let closing = false;
  let finished = false;
  let closeReason = "se cortó la conexión con OpenAI";
  let usageSeconds: number | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let lastSpeechAt = Date.now();
  const timers: NodeJS.Timeout[] = [];

  const send = (event: Record<string, unknown>) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event));
  };

  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    clearInterval(idleTimer);
    socket.destroy();
    dump?.end();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    if (activeSession === close) activeSession = null;
    const duration = usageSeconds === null ? "" : ` (${usageSeconds} s)`;
    void appendEvent("device", `Modo charla terminado: ${reason}${duration}`);
  };

  // Ask OpenAI to finalize so the billed duration is known, then drop everything.
  const close = (reason: string) => {
    if (finished || closing) return;
    if (!started || upstream.readyState !== WebSocket.OPEN) {
      finish(reason);
      return;
    }
    closing = true;
    started = false; // stop relaying microphone audio
    closeReason = reason;
    socket.end();
    send({ type: "session.close" });
    timers.push(setTimeout(() => finish(reason), CLOSE_GRACE_MS));
  };

  const idleTimer = setInterval(() => {
    if (started && Date.now() - lastSpeechAt > idleMs) close("nadie habló por un rato");
  }, 5_000);

  upstream.onopen = () => {
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

  upstream.onmessage = (message) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(String(message.data)) as LiveEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "session.output_audio.delta":
        // The box plays in real time; anything piling up here would only add delay, so it is dropped.
        if (event.delta && socket.writable && socket.writableLength < MAX_DOWNLINK_BACKLOG_BYTES) {
          socket.write(Buffer.from(event.delta, "base64"));
        }
        break;
      case "session.started":
        started = true;
        lastSpeechAt = Date.now();
        // Sent at once the model ignores it: it only opens the conversation after hearing some input audio.
        timers.push(setTimeout(() => {
          send({ type: "session.instructions.append", event_id: "greeting", delegation_id: null, content: GREETING });
        }, GREETING_DELAY_MS));
        timers.push(setTimeout(() => {
          send({ type: "session.instructions.append", event_id: "wrap_up", delegation_id: null, content: WRAP_UP });
        }, Math.max(0, maxMs - WRAP_UP_BEFORE_END_MS)));
        timers.push(setTimeout(() => close("se cumplió el tiempo máximo"), maxMs));
        void appendEvent("device", "Modo charla iniciado");
        break;
      case "session.input_transcript.delta":
        lastSpeechAt = Date.now();
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
        if (typeof event.usage?.seconds === "number") usageSeconds = event.usage.seconds;
        break;
      case "session.closed":
        if (typeof event.usage?.seconds === "number") usageSeconds = event.usage.seconds;
        finish(closeReason);
        break;
      case "error":
        void appendEvent("error", `Modo charla: ${event.error?.message ?? "error de OpenAI"}`);
        break;
    }
  };
  upstream.onerror = () => {
    if (!started && !finished) void appendEvent("error", "Modo charla: no se pudo conectar con OpenAI");
  };
  upstream.onclose = () => finish(closeReason);

  // LIVE_DEBUG_DUMP=1 keeps what the microphone sent, to check the audio path.
  const dump: WriteStream | null = process.env.LIVE_DEBUG_DUMP
    ? createWriteStream(path.join(process.cwd(), "data", "device", "live-mic.pcm"))
    : null;
  socket.on("data", (chunk: Buffer) => {
    dump?.write(chunk);
    if (!started) return; // the model is not listening yet
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= UPLINK_CHUNK_BYTES) {
      send({ type: "session.input_audio.append", audio: pending.subarray(0, UPLINK_CHUNK_BYTES).toString("base64") });
      pending = pending.subarray(UPLINK_CHUNK_BYTES);
    }
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
