import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { appendEvent } from "@/lib/events";

const execFileAsync = promisify(execFile);

// Invented messages that pad the listen button's replay pool on quiet days.
// Each one is spoken once and cached as PCM16 mono/16 kHz, the same format as
// a WhatsApp note. With ELEVENLABS_API_KEY and ELEVENLABS_KID_VOICES (comma
// separated voice ids, see scripts/elevenlabs-kid-voices.mjs) in .env.local
// the kids' voices of ElevenLabs speak them; otherwise, or while ElevenLabs
// fails, the Mac voices do. Editing a text or changing its voice makes a new id.
export const jokesDirectory = path.join(process.cwd(), "data", "outbox", "jokes");
const JOKE_PREFIX = "joke_";
const FALLBACK_VOICES = ["Paulina", "Mónica"];
const ELEVENLABS_RETRY_MS = 10 * 60 * 1000;

type Joke = { voice: string; text: string };

const JOKES: Joke[] = [
  { voice: "Grandpa (Spanish (Mexico))", text: "Atención, atención. Habla el capitán Chapu. Estamos volando a diez mil metros de altura sobre la cocina. Por favor abróchense los cinturones y pidan la merienda." },
  { voice: "Paulina", text: "¿Qué le dijo un semáforo al otro? No me mires, que me estoy cambiando." },
  { voice: "Rocko (Spanish (Mexico))", text: "Mensaje urgente del planeta de las medialunas. Nos quedamos sin dulce de leche. Repito, nos quedamos sin dulce de leche. Manden refuerzos. Cambio y fuera." },
  { voice: "Grandma (Spanish (Mexico))", text: "¿Qué hace una abeja en el gimnasio? ¡Zumba!" },
  { voice: "Paulina", text: "Hola, soy Chapu. Hoy no me llegó ningún mensaje nuevo y las cajas también nos aburrimos. ¿Por qué no le grabás uno a alguien? Dale, que yo lo llevo volando." },
  { voice: "Grandpa (Spanish (Mexico))", text: "¿Por qué los pájaros vuelan al sur en invierno? Porque caminando tardan muchísimo." },
  { voice: "Rocko (Spanish (Mexico))", text: "Informe del tiempo para hoy. Por la mañana, lluvia de besos. Por la tarde, tormenta de cosquillas. Y a la noche, cien por ciento de probabilidad de abrazos." },
  { voice: "Grandma (Spanish (Mexico))", text: "¿Cuál es el colmo de un jardinero? Que lo dejen plantado." },
  { voice: "Paulina", text: "Noticia de último momento. Un dinosaurio fue visto comiendo fideos con manteca. Dijo que estaban riquísimos y pidió repetir." },
  { voice: "Rocko (Spanish (Mexico))", text: "¿Cómo se llama el campeón de buceo japonés? Tokofondo. ¿Y el subcampeón? Kasitoko." },
];

export function isJokeId(id: string) {
  return id.startsWith(JOKE_PREFIX);
}

function hashedId(voice: string, text: string) {
  return `${JOKE_PREFIX}${createHash("sha1").update(`${voice}\n${text}`).digest("hex").slice(0, 10)}`;
}

function macJokeId(joke: Joke) {
  return hashedId(joke.voice, joke.text);
}

function elevenLabsConfig() {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voices = (process.env.ELEVENLABS_KID_VOICES ?? "").split(",").map((voice) => voice.trim()).filter(Boolean);
  if (!apiKey || voices.length === 0) return null;
  return { apiKey, voices, model: process.env.ELEVENLABS_MODEL?.trim() || "eleven_multilingual_v2" };
}

// The kids take turns: joke n is told by voice n modulo the configured voices.
function elevenLabsVoice(index: number, config: NonNullable<ReturnType<typeof elevenLabsConfig>>) {
  return config.voices[index % config.voices.length];
}

export function jokePath(id: string) {
  return path.join(jokesDirectory, `${id}.wav`);
}

async function toNoteFormat(source: string, target: string) {
  const temporaryPath = `${target}.tmp`;
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", source,
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-f", "wav", temporaryPath,
    ], { timeout: 30000 });
    await fs.rename(temporaryPath, target);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function speakWithMac(joke: Joke, target: string) {
  const aiffPath = `${target}.aiff`;
  try {
    for (const voice of [joke.voice, ...FALLBACK_VOICES]) {
      try {
        await execFileAsync("say", ["-v", voice, "-o", aiffPath, joke.text], { timeout: 30000 });
        await toNoteFormat(aiffPath, target);
        return;
      } catch {
        // Voice not installed; try the next one.
      }
    }
  } finally {
    await fs.rm(aiffPath, { force: true });
  }
}

async function speakWithElevenLabs(text: string, voiceId: string, config: NonNullable<ReturnType<typeof elevenLabsConfig>>, target: string) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": config.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: config.model,
      // Lively delivery: jokes read flat with the default stability.
      voice_settings: { stability: 0.35, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs respondió HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const mp3Path = `${target}.mp3`;
  try {
    await fs.writeFile(mp3Path, Buffer.from(await response.arrayBuffer()));
    await toNoteFormat(mp3Path, target);
  } finally {
    await fs.rm(mp3Path, { force: true });
  }
}

const runtime = globalThis as typeof globalThis & {
  __chapuJokesGenerating?: Promise<void> | null;
  __chapuElevenLabsRetryAt?: number;
};

async function exists(filePath: string) {
  return fs.access(filePath).then(() => true, () => false);
}

/**
 * Ids of the invented messages that are ready to play. Missing ones are spoken
 * in the background, so the heartbeat that asks never waits for the voice.
 */
export async function availableJokes() {
  await fs.mkdir(jokesDirectory, { recursive: true });
  const config = elevenLabsConfig();
  const ready: string[] = [];
  const work: { elevenLabs: boolean; run: () => Promise<void> }[] = [];
  for (const [index, joke] of JOKES.entries()) {
    const macId = macJokeId(joke);
    if (config) {
      const voiceId = elevenLabsVoice(index, config);
      const kidId = hashedId(`elevenlabs:${config.model}:${voiceId}`, joke.text);
      if (await exists(jokePath(kidId))) {
        ready.push(kidId);
        continue;
      }
      if (Date.now() >= (runtime.__chapuElevenLabsRetryAt ?? 0)) {
        work.push({ elevenLabs: true, run: () => speakWithElevenLabs(joke.text, voiceId, config, jokePath(kidId)) });
      }
    }
    // No kids' voice (yet): the Mac voice keeps the joke in the pool.
    if (await exists(jokePath(macId))) ready.push(macId);
    else work.push({ elevenLabs: false, run: () => speakWithMac(joke, jokePath(macId)) });
  }
  if (work.length > 0 && !runtime.__chapuJokesGenerating) {
    runtime.__chapuJokesGenerating = (async () => {
      for (const task of work) {
        if (task.elevenLabs && Date.now() < (runtime.__chapuElevenLabsRetryAt ?? 0)) continue;
        try {
          await task.run();
        } catch (error) {
          // Bad key, quota or network: stop asking ElevenLabs for a while.
          if (task.elevenLabs) runtime.__chapuElevenLabsRetryAt = Date.now() + ELEVENLABS_RETRY_MS;
          await appendEvent("error", `Mensajes inventados: ${error instanceof Error ? error.message : "error desconocido"}`);
        }
      }
    })().finally(() => {
      runtime.__chapuJokesGenerating = null;
    });
  }
  return ready;
}
