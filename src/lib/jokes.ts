import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Invented messages that pad the listen button's replay pool on quiet days.
// Each one is spoken once by a Mac voice and cached as PCM16 mono/16 kHz, the
// same format as a WhatsApp note. Editing a text or its voice makes a new id.
export const jokesDirectory = path.join(process.cwd(), "data", "outbox", "jokes");
const JOKE_PREFIX = "joke_";
const FALLBACK_VOICES = ["Paulina", "Mónica"];

const JOKES: { voice: string; text: string }[] = [
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

function jokeId(joke: { voice: string; text: string }) {
  return `${JOKE_PREFIX}${createHash("sha1").update(`${joke.voice}\n${joke.text}`).digest("hex").slice(0, 10)}`;
}

export function jokePath(id: string) {
  return path.join(jokesDirectory, `${id}.wav`);
}

async function speakJoke(joke: { voice: string; text: string }, target: string) {
  const aiffPath = `${target}.aiff`;
  const temporaryPath = `${target}.tmp`;
  try {
    let spoken = false;
    for (const voice of [joke.voice, ...FALLBACK_VOICES]) {
      try {
        await execFileAsync("say", ["-v", voice, "-o", aiffPath, joke.text], { timeout: 30000 });
        spoken = true;
        break;
      } catch {
        // Voice not installed; try the next one.
      }
    }
    if (!spoken) return;
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", aiffPath,
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-f", "wav", temporaryPath,
    ], { timeout: 30000 });
    await fs.rename(temporaryPath, target);
  } finally {
    await Promise.all([fs.rm(aiffPath, { force: true }), fs.rm(temporaryPath, { force: true })]);
  }
}

const runtime = globalThis as typeof globalThis & { __chapuJokesGenerating?: Promise<void> | null };

/**
 * Ids of the invented messages that are ready to play. Missing ones are spoken
 * in the background, so the heartbeat that asks never waits for the voice.
 */
export async function availableJokes() {
  await fs.mkdir(jokesDirectory, { recursive: true });
  const ready: string[] = [];
  const missing: typeof JOKES = [];
  for (const joke of JOKES) {
    const id = jokeId(joke);
    const exists = await fs.access(jokePath(id)).then(() => true, () => false);
    if (exists) ready.push(id);
    else missing.push(joke);
  }
  if (missing.length > 0 && !runtime.__chapuJokesGenerating) {
    runtime.__chapuJokesGenerating = (async () => {
      for (const joke of missing) {
        await speakJoke(joke, jokePath(jokeId(joke))).catch(() => undefined);
      }
    })().finally(() => {
      runtime.__chapuJokesGenerating = null;
    });
  }
  return ready;
}
