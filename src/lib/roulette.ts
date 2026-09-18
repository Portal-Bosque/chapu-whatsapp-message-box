import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { appendEvent } from "@/lib/events";
import { resolveName } from "@/lib/names";
import { NOTIFICATION_PREFIX } from "@/lib/notifications";
import { ensureOutboxDirectories, pendingDirectory } from "@/lib/outbox";
import { AGENDA_SLOTS, readSettings, selectRecipient } from "@/lib/settings";

const execFileAsync = promisify(execFile);

// The fourth agenda button (GPIO 12) is a roulette. Firmware that does not
// know about it still plays its slot's "name" clip the instant the button is
// pressed, so the web hands it a lottery sound as that clip, draws a random
// contact while it plays, and then queues a cue that says who won.
export const ROULETTE_SLOT = 3;
export const ROULETTE_NAME_VERSION = "roulette-v1";
export const ROULETTE_CUE_PREFIX = `${NOTIFICATION_PREFIX}roulette_`;
const SPIN_MS = 3000;
// The heartbeat reporting the press arrives a few hundred ms after it; draw
// slightly early so the cue is waiting when the lottery sound ends.
const DRAW_AFTER_MS = 2500;
const LAMP_HOP_MS = 330;
const SAMPLE_RATE = 16000;

const soundsDirectory = path.join(process.cwd(), "data", "names", "roulette");
const spinClipPath = path.join(soundsDirectory, `${ROULETTE_NAME_VERSION}.wav`);
const winClipPath = path.join(soundsDirectory, `${ROULETTE_NAME_VERSION}-win.wav`);

function wavFile(samples: Int16Array) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

// Lottery wheel: bright ticks over a pentatonic scale that start fast and slow down.
function spinSamples() {
  const scale = [1046.5, 1174.66, 1318.51, 1567.98, 1760];
  const samples = new Int16Array(Math.floor(SAMPLE_RATE * SPIN_MS / 1000));
  const tickLength = Math.floor(SAMPLE_RATE * 0.038);
  let atMs = 0;
  let gapMs = 55;
  for (let tick = 0; atMs < SPIN_MS - 60; tick++) {
    const start = Math.floor(atMs * SAMPLE_RATE / 1000);
    const hz = scale[tick % scale.length];
    for (let i = 0; i < tickLength && start + i < samples.length; i++) {
      const envelope = (1 - i / tickLength) ** 2;
      const phase = 2 * Math.PI * hz * i / SAMPLE_RATE;
      samples[start + i] = Math.round(9000 * envelope * (Math.sin(phase) + 0.3 * Math.sin(phase * 3)));
    }
    atMs += gapMs;
    gapMs *= 1.09;
  }
  return samples;
}

// Two rising bell notes announcing the winner.
function winSamples() {
  const notes = [{ hz: 783.99, ms: 110 }, { hz: 1567.98, ms: 260 }];
  const gap = Math.floor(SAMPLE_RATE * 0.03);
  const total = notes.reduce((sum, note) => sum + Math.floor(SAMPLE_RATE * note.ms / 1000) + gap, 0);
  const samples = new Int16Array(total);
  let offset = 0;
  for (const note of notes) {
    const length = Math.floor(SAMPLE_RATE * note.ms / 1000);
    for (let i = 0; i < length; i++) {
      const progress = i / length;
      const envelope = Math.sin(Math.PI * progress) * (1 - 0.35 * progress);
      const phase = 2 * Math.PI * note.hz * i / SAMPLE_RATE;
      samples[offset + i] = Math.round(8000 * envelope * (Math.sin(phase) + 0.18 * Math.sin(phase * 2)));
    }
    offset += length + gap;
  }
  return samples;
}

async function ensureClip(filePath: string, make: () => Int16Array) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(soundsDirectory, { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, wavFile(make()));
    await fs.rename(temporary, filePath);
  }
  return filePath;
}

/** The lottery sound the ESP32 caches as the "name" of the roulette button. */
export function rouletteSpinClip() {
  return ensureClip(spinClipPath, spinSamples);
}

type SpinRuntime = { timer: NodeJS.Timeout | null; startedAt: number };
const runtime = globalThis as typeof globalThis & { __chapuRoulette?: SpinRuntime };
const spin = (runtime.__chapuRoulette ??= { timer: null, startedAt: 0 });

/** While the wheel turns the agenda lamps hop around; null once it has stopped. */
export function spinningLampSlot() {
  if (!spin.timer) return null;
  return Math.floor((Date.now() - spin.startedAt) / LAMP_HOP_MS) % AGENDA_SLOTS;
}

async function draw() {
  spin.timer = null;
  const settings = await readSettings();
  const agenda = settings.recipients.slice(0, AGENDA_SLOTS);
  const others = agenda.filter((recipient) => recipient.id !== settings.selectedRecipientId);
  const candidates = others.length > 0 ? others : agenda;
  if (candidates.length === 0) {
    await appendEvent("device", "Ruleta: no hay contactos en la agenda");
    return;
  }
  const winner = candidates[Math.floor(Math.random() * candidates.length)];
  await selectRecipient(winner.id);
  await appendEvent("device", `Ruleta: le tocó a ${winner.label}, ahora se habla con ${winner.label}`);

  await ensureOutboxDirectories();
  const id = `${ROULETTE_CUE_PREFIX}${Date.now()}`;
  const target = path.join(pendingDirectory, `${id}.wav`);
  const temporary = path.join(soundsDirectory, `${id}.tmp.wav`);
  try {
    const [fanfare, name] = await Promise.all([ensureClip(winClipPath, winSamples), resolveName(winner)]);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", fanfare,
      "-f", "lavfi", "-t", "0.15", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
      "-i", name.filePath,
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
      "-map", "[out]", "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav",
      temporary,
    ], { timeout: 30000 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    await appendEvent("error", `Ruleta: no se pudo preparar el anuncio de ${winner.label}: ${error instanceof Error ? error.message.split("\n")[0] : "error desconocido"}`);
  }
}

/** A press of the roulette button; pressing again while it turns restarts the spin. */
export async function startRouletteSpin() {
  const restarted = spin.timer !== null;
  if (spin.timer) clearTimeout(spin.timer);
  spin.startedAt = Date.now();
  spin.timer = setTimeout(() => {
    void draw().catch((error) => appendEvent("error", `Ruleta: ${error instanceof Error ? error.message : "error desconocido"}`));
  }, DRAW_AFTER_MS);
  if (!restarted) await appendEvent("device", "Botón de la ruleta: girando…");
}
