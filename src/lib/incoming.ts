import { promises as fs } from "node:fs";
import path from "node:path";
import { appendEvent } from "@/lib/events";
import { readSettings, selectRecipient } from "@/lib/settings";

// One JSON marker per WhatsApp note, written next to the download while the
// audio is being prepared and kept afterwards for reminders and replies.
export const incomingDirectory = path.join(process.cwd(), "data", "whatsapp-incoming");

export type IncomingMarker = {
  status?: string;
  senderId?: string | null;
  senderLabel?: string;
  queuedAt?: string;
  remindersSent?: number;
  lastCueAt?: string;
};

export function incomingMarkerPath(outboxId: string) {
  return path.join(incomingDirectory, `${outboxId.replace(/^wa_/, "")}.json`);
}

export async function readIncomingMarker(outboxId: string): Promise<IncomingMarker> {
  return fs.readFile(incomingMarkerPath(outboxId), "utf8")
    .then((value) => JSON.parse(value) as IncomingMarker)
    .catch(() => ({}));
}

/**
 * Points the agenda at the sender of a note so the send button answers it.
 * Returns true when the selection changed; unknown numbers leave it alone.
 */
export async function selectSenderRecipient(senderId: string | null | undefined, reason: string) {
  if (!senderId) return false;
  const settings = await readSettings();
  const recipient = settings.recipients.find((item) => item.id === senderId);
  if (!recipient || recipient.id === settings.selectedRecipientId) return false;
  await selectRecipient(recipient.id);
  await appendEvent("device", `${reason}: ahora se habla con ${recipient.label}`);
  return true;
}
