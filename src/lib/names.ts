import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AGENDA_SLOTS, type MessageBoxSettings, type Recipient } from "@/lib/settings";

const execFileAsync = promisify(execFile);

// Spoken contact names Chapu plays when an agenda button is pressed.
// Recorded from the web into data/names/<id>.wav; otherwise the Mac speaks the
// label with the system voice and the result is cached under generated/.
export const namesDirectory = path.join(process.cwd(), "data", "names");
const generatedDirectory = path.join(namesDirectory, "generated");
const SPANISH_VOICES = ["Paulina", "Mónica"];

export type NameSource = "recorded" | "generated";
export type ResolvedName = { source: NameSource; version: string; filePath: string };

export function recordedNamePath(id: string) {
  return path.join(namesDirectory, `${id}.wav`);
}

async function recordedVersion(id: string) {
  try {
    const stats = await fs.stat(recordedNamePath(id));
    return `rec-${Math.round(stats.mtimeMs)}`;
  } catch {
    return null;
  }
}

function generatedVersion(recipient: Recipient) {
  return `say-${createHash("sha1").update(recipient.label).digest("hex").slice(0, 10)}`;
}

function generatedPath(recipient: Recipient) {
  return path.join(generatedDirectory, `${recipient.id}-${generatedVersion(recipient)}.wav`);
}

/** Version string per agenda slot, cheap enough to include in every heartbeat. */
export async function slotNameVersions(settings: MessageBoxSettings) {
  return Promise.all(Array.from({ length: AGENDA_SLOTS }, async (_, slot) => {
    const recipient = settings.recipients[slot];
    if (!recipient) return null;
    return (await recordedVersion(recipient.id)) ?? generatedVersion(recipient);
  }));
}

export async function nameSource(recipient: Recipient): Promise<NameSource> {
  return (await recordedVersion(recipient.id)) ? "recorded" : "generated";
}

async function speakLabel(recipient: Recipient) {
  await fs.mkdir(generatedDirectory, { recursive: true });
  const target = generatedPath(recipient);
  try {
    await fs.access(target);
    return target;
  } catch {
    // Not generated yet.
  }

  const aiffPath = `${target}.aiff`;
  let spoken = false;
  for (const voice of SPANISH_VOICES) {
    try {
      await execFileAsync("say", ["-v", voice, "-o", aiffPath, recipient.label], { timeout: 15000 });
      spoken = true;
      break;
    } catch {
      // Try the next voice; the last failure is reported below.
    }
  }
  if (!spoken) throw new Error("La voz del sistema no está disponible");

  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", aiffPath,
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-f", "wav", target,
    ], { timeout: 30000 });
  } finally {
    await fs.rm(aiffPath, { force: true });
  }
  return target;
}

/** Recorded clip when it exists, otherwise the generated one (created on demand). */
export async function resolveName(recipient: Recipient): Promise<ResolvedName> {
  const recorded = await recordedVersion(recipient.id);
  if (recorded) return { source: "recorded", version: recorded, filePath: recordedNamePath(recipient.id) };
  return { source: "generated", version: generatedVersion(recipient), filePath: await speakLabel(recipient) };
}

// Boot greeting: "Bienvenido a la vitrola". A recorded data/names/greeting.wav
// wins; otherwise the Mac voice generates it once and caches the result.
const GREETING_TEXT = "Bienvenido a la vitrola";
const greetingRecipient: Recipient = { id: "greeting", label: GREETING_TEXT, phone: "", color: "" };

export async function resolveGreeting(): Promise<ResolvedName> {
  return resolveName(greetingRecipient);
}

// Spoken for senders that are not in the agenda. data/names/unknown.wav overrides.
const unknownRecipient: Recipient = { id: "unknown", label: "desconocido", phone: "", color: "" };

export async function resolveUnknownName(): Promise<ResolvedName> {
  return resolveName(unknownRecipient);
}

export async function saveRecordedName(id: string, wave: Buffer) {
  await fs.mkdir(namesDirectory, { recursive: true });
  const target = recordedNamePath(id);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, wave);
  await fs.rename(temporary, target);
}

export async function deleteRecordedName(id: string) {
  await fs.rm(recordedNamePath(id), { force: true });
}
