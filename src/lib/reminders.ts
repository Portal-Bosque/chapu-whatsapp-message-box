import { promises as fs } from "node:fs";
import path from "node:path";
import { appendEvent } from "@/lib/events";
import { isDeviceOnline } from "@/lib/device";
import { isNotificationId, queueNewMessageNotification, type NotificationSender } from "@/lib/notifications";
import { ensureOutboxDirectories, pendingDirectory, queuedDirectory } from "@/lib/outbox";

// A WhatsApp note that nobody listened to gets the voice cue again 1 minute,
// 10 minutes and 1 hour after it arrived, but only inside the waking window.
export const REMINDER_OFFSETS_MS = [60_000, 10 * 60_000, 60 * 60_000];
export const REMINDER_WINDOW = { startHour: 7, endHour: 21 };
const TICK_MS = 30_000;

const incomingDirectory = path.join(process.cwd(), "data", "whatsapp-incoming");

type IncomingMarker = {
  status?: string;
  senderId?: string | null;
  senderLabel?: string;
  queuedAt?: string;
  remindersSent?: number;
  lastCueAt?: string;
};

type UnheardMessage = {
  id: string;
  markerPath: string;
  marker: IncomingMarker;
  queuedAtMs: number;
};

export function isInsideReminderWindow(date = new Date()) {
  const hour = date.getHours();
  return hour >= REMINDER_WINDOW.startHour && hour < REMINDER_WINDOW.endHour;
}

function dueReminders(message: UnheardMessage, now: number) {
  return REMINDER_OFFSETS_MS.filter((offset) => message.queuedAtMs + offset <= now).length;
}

async function listUnheardMessages(): Promise<UnheardMessage[]> {
  await ensureOutboxDirectories();
  const entries = await fs.readdir(queuedDirectory, { withFileTypes: true });
  const messages = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".wav") && entry.name.startsWith("wa_"))
    .map(async (entry) => {
      const id = entry.name.slice(0, -4);
      const markerPath = path.join(incomingDirectory, `${id.slice("wa_".length)}.json`);
      const marker = await fs.readFile(markerPath, "utf8")
        .then((value) => JSON.parse(value) as IncomingMarker)
        .catch(() => ({} as IncomingMarker));
      const queuedAtMs = marker.queuedAt
        ? new Date(marker.queuedAt).getTime()
        : (await fs.stat(path.join(queuedDirectory, entry.name))).birthtimeMs;
      return { id, markerPath, marker, queuedAtMs };
    }));
  return messages.sort((a, b) => a.queuedAtMs - b.queuedAtMs);
}

async function hasPendingNotification() {
  await ensureOutboxDirectories();
  const entries = await fs.readdir(pendingDirectory);
  return entries.some((name) => name.endsWith(".wav") && isNotificationId(name.slice(0, -4)));
}

async function markCueSent(messages: UnheardMessage[], now: number) {
  await fs.mkdir(incomingDirectory, { recursive: true });
  await Promise.all(messages.map((message) => fs.writeFile(message.markerPath, JSON.stringify({
    ...message.marker,
    status: message.marker.status ?? "queued",
    queuedAt: message.marker.queuedAt ?? new Date(message.queuedAtMs).toISOString(),
    // One cue covers every reminder that was already due, so an overnight
    // backlog produces a single cue in the morning instead of three in a row.
    remindersSent: Math.max(message.marker.remindersSent ?? 0, dueReminders(message, now)),
    lastCueAt: new Date(now).toISOString(),
  }, null, 2))));
}

/**
 * Plays the "new message" voice cue if Chapu can hear it right now: inside the
 * window, with the ESP32 online, unheard notes waiting and no cue still queued.
 * Returns true when a cue was queued.
 */
export async function sendReminderCue(
  reason: string,
  options: { force?: boolean; ignoreWindow?: boolean; sender?: NotificationSender } = {},
) {
  const now = Date.now();
  if (!options.ignoreWindow && !isInsideReminderWindow(new Date(now))) return false;
  if (!(await isDeviceOnline())) return false;
  if (await hasPendingNotification()) return false;

  const unheard = await listUnheardMessages();
  if (unheard.length === 0) return false;

  if (!options.force) {
    const somethingDue = unheard.some((message) => dueReminders(message, now) > (message.marker.remindersSent ?? 0));
    if (!somethingDue) return false;
  }

  // Name the sender of the message that triggered the cue, else the oldest unheard one.
  const oldest = unheard[0].marker;
  const sender = options.sender !== undefined
    ? options.sender
    : oldest.senderId && oldest.senderLabel ? { id: oldest.senderId, label: oldest.senderLabel } : null;
  const queued = await queueNewMessageNotification(reason, sender);
  if (!queued) return false;
  await markCueSent(unheard, now);
  return true;
}

export async function runReminderTick() {
  try {
    return await sendReminderCue("recordatorio de mensaje sin escuchar");
  } catch (error) {
    await appendEvent("error", `Falló el recordatorio: ${error instanceof Error ? error.message : "error desconocido"}`);
    return false;
  }
}

const globalRuntime = globalThis as typeof globalThis & { __messageBoxReminderTimer?: NodeJS.Timeout };

export function startReminderScheduler() {
  if (globalRuntime.__messageBoxReminderTimer) return;
  globalRuntime.__messageBoxReminderTimer = setInterval(() => {
    void runReminderTick();
  }, TICK_MS);
  globalRuntime.__messageBoxReminderTimer.unref();
}
