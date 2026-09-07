import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { appendEvent } from "@/lib/events";
import { resolveName, resolveUnknownName } from "@/lib/names";
import { ensureOutboxDirectories, pendingDirectory } from "@/lib/outbox";
import type { Recipient } from "@/lib/settings";

const execFileAsync = promisify(execFile);

// Short voice cues Chapu plays through the EMEET when a new WhatsApp note is
// queued. They live outside Git (data/ is private) and alternate on every use.
const notificationsDirectory = path.join(process.cwd(), "data", "notifications");
const notificationStatePath = path.join(notificationsDirectory, "state.json");
const notificationVoices = ["dan", "chloe"];

export const NOTIFICATION_PREFIX = "notify_";

export function isNotificationId(id: string) {
  return id.startsWith(NOTIFICATION_PREFIX);
}

async function nextNotificationVoice() {
  let nextIndex = 0;
  try {
    const state = JSON.parse(await fs.readFile(notificationStatePath, "utf8")) as { nextIndex?: number };
    if (Number.isInteger(state.nextIndex)) nextIndex = (state.nextIndex as number) % notificationVoices.length;
  } catch {
    // First use, or unreadable state: start from the first voice.
  }
  const voice = notificationVoices[nextIndex];
  await fs.writeFile(notificationStatePath, JSON.stringify({ nextIndex: (nextIndex + 1) % notificationVoices.length }));
  return voice;
}

export type NotificationSender = Pick<Recipient, "id" | "label"> | null;

/**
 * Queues the "new message" cue for Chapu: the alternating Dan/Chloe voice
 * followed by the sender's spoken name ("desconocido" for numbers outside
 * the agenda), joined into one WAV with a short pause in between.
 */
export async function queueNewMessageNotification(reason = "mensaje nuevo", sender: NotificationSender = null) {
  await fs.mkdir(notificationsDirectory, { recursive: true });
  const voice = await nextNotificationVoice();
  const cuePath = path.join(notificationsDirectory, `${voice}.wav`);
  try {
    await fs.access(cuePath);
  } catch {
    await appendEvent("error", `Falta el aviso de voz ${voice}.wav en data/notifications`);
    return null;
  }

  await ensureOutboxDirectories();
  const id = `${NOTIFICATION_PREFIX}${Date.now()}_${voice}`;
  const target = path.join(pendingDirectory, `${id}.wav`);
  const temporary = path.join(notificationsDirectory, `${id}.tmp.wav`);
  const spokenSender = sender ? sender.label : "desconocido";
  try {
    const name = sender
      ? await resolveName({ id: sender.id, label: sender.label, phone: "", color: "" })
      : await resolveUnknownName();
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", cuePath,
      "-f", "lavfi", "-t", "0.3", "-i", "anullsrc=r=16000:cl=mono",
      "-i", name.filePath,
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
      "-map", "[out]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav",
      temporary,
    ], { timeout: 30000 });
    await fs.rename(temporary, target);
  } catch (error) {
    // Never lose the cue because the name failed: fall back to the bare voice.
    await fs.rm(temporary, { force: true });
    await fs.copyFile(cuePath, target);
    await appendEvent("error", `No se pudo agregar el nombre al aviso: ${error instanceof Error ? error.message.split("\n")[0] : "error desconocido"}`);
  }
  await appendEvent("device", `Aviso de voz (${reason}) con la voz de ${voice} y el nombre "${spokenSender}" en camino a Chapu`);
  return id;
}
