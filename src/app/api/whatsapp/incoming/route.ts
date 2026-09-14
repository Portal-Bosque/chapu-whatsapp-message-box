import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { appendEvent } from "@/lib/events";
import { incomingDirectory, selectSenderRecipient } from "@/lib/incoming";
import { sendReminderCue } from "@/lib/reminders";
import { ensureOutboxDirectories, queuedDirectory } from "@/lib/outbox";
import { isGroupDestination, readSettings } from "@/lib/settings";
import { wacliStoreDirectory } from "@/lib/wacli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type IncomingMessage = {
  Chat?: string;
  ID?: string;
  SenderJID?: string;
  FromMe?: boolean;
  PushName?: string;
  ChatName?: string;
  Media?: { Type?: string; MimeType?: string; Filename?: string };
};

function jidDigits(jid?: string) {
  return (jid?.split("@")[0] ?? "").replace(/\D/g, "");
}

type Sender = { id: string; label: string } | null;

type ExecError = Error & { stdout?: string; stderr?: string };

// With --json wacli reports failures on stdout, so Node's "Command failed"
// message alone says nothing about the cause.
function wacliErrorText(error: unknown) {
  const execError = error as ExecError;
  try {
    const envelope = JSON.parse(execError.stdout ?? "") as { error?: string };
    if (envelope.error) return envelope.error;
  } catch {
    // Not a JSON envelope; fall through to the raw output.
  }
  return execError.stderr?.trim().split("\n")[0] || (execError.message ?? "error desconocido").split("\n")[0];
}

type PartialNote = { expectedBytes: number; receivedBytes: number };

// The sync (--download-media) keeps whatever bytes the CDN served under the
// store, at media/<chat>/<id>/<kind>/<file>, written around the same time
// as it posts the webhook.
async function findSyncedMedia(chat: string, id: string, expectedSize: number) {
  const directory = path.join(wacliStoreDirectory, "media", chat.replace("@", "_"), id.replace(/[^a-zA-Z0-9_-]/g, "_"));
  for (let attempt = 0; attempt < 20; attempt++) {
    const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const candidate = path.join(entry.parentPath, entry.name);
      const stats = await fs.stat(candidate).catch(() => null);
      if (stats?.size === expectedSize) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/**
 * Downloads the note through wacli. When the sender's upload was cut short,
 * WhatsApp still announces the original size and wacli refuses the shorter
 * file; the bytes that did arrive are played instead of dropping the note.
 */
async function downloadNote(message: Required<Pick<IncomingMessage, "Chat" | "ID">>, outputPath: string) {
  try {
    await execFileAsync("wacli", [
      "--store", wacliStoreDirectory,
      "--read-only",
      "--json",
      "--timeout", "2m",
      "media", "download",
      "--chat", message.Chat,
      "--id", message.ID,
      "--output", outputPath,
    ], { timeout: 130000, maxBuffer: 1024 * 1024 });
    return { audioPath: outputPath, partial: null as PartialNote | null };
  } catch (error) {
    const detail = wacliErrorText(error);
    const mismatch = /file length does not match: expected (\d+), got (\d+)/.exec(detail);
    const synced = mismatch ? await findSyncedMedia(message.Chat, message.ID, Number(mismatch[2])) : null;
    if (!mismatch || !synced) throw new Error(detail);
    return { audioPath: synced, partial: { expectedBytes: Number(mismatch[1]), receivedBytes: Number(mismatch[2]) } };
  }
}

function wavSeconds(bytes: number) {
  return Math.max(0, bytes - 44) / (16000 * 2);
}

async function processIncomingAudio(message: Required<Pick<IncomingMessage, "Chat" | "ID">>, sender: Sender) {
  const senderLabel = sender?.label ?? "desconocido";
  const safeId = message.ID.replace(/[^a-zA-Z0-9_-]/g, "_");
  const markerPath = path.join(incomingDirectory, `${safeId}.json`);
  const sourcePath = path.join(incomingDirectory, `${safeId}.media`);
  const waveTempPath = path.join(incomingDirectory, `${safeId}.wav.tmp`);
  const outboxId = `wa_${safeId}`;
  const outboxPath = path.join(queuedDirectory, `${outboxId}.wav`);

  try {
    await appendEvent("whatsapp", `Descargando nota de voz de ${senderLabel}`);
    const { audioPath, partial } = await downloadNote(message, sourcePath);

    await appendEvent("conversion", "Convirtiendo audio entrante a WAV mono/16 kHz");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", audioPath,
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-f", "wav", waveTempPath,
    ], { timeout: 30000 });

    await ensureOutboxDirectories();
    if (partial) {
      const received = wavSeconds((await fs.stat(waveTempPath)).size);
      const expected = received * partial.expectedBytes / partial.receivedBytes;
      await appendEvent("whatsapp", `La nota de ${senderLabel} llegó incompleta a WhatsApp: se subieron ${Math.round(received)} s de unos ${Math.round(expected)} s; Chapu reproduce lo que hay`);
    }
    await fs.rename(waveTempPath, outboxPath);
    await fs.writeFile(markerPath, JSON.stringify({
      status: "queued",
      senderId: sender?.id ?? null,
      senderLabel,
      queuedAt: new Date().toISOString(),
      ...(partial ? { partial } : {}),
    }, null, 2));
    await appendEvent("device", `Nota de voz de ${senderLabel} guardada en la cola de Chapu`);
    // Aim the agenda at whoever wrote, so the send button answers them.
    await selectSenderRecipient(sender?.id, `Mensaje de ${senderLabel}`);
    // The arrival cue plays right away at any hour; the 1/10/60-minute
    // reminders and the boot cue respect the waking window.
    await sendReminderCue("mensaje nuevo", { force: true, ignoreWindow: true, sender });
  } catch (error) {
    const detail = wacliErrorText(error);
    await fs.writeFile(markerPath, JSON.stringify({ status: "error", detail, updatedAt: new Date().toISOString() }, null, 2));
    await appendEvent("error", `No se pudo preparar el audio entrante: ${detail}`);
  } finally {
    await Promise.all([
      fs.rm(sourcePath, { force: true }),
      fs.rm(waveTempPath, { force: true }),
    ]);
  }
}

export async function POST(request: Request) {
  const message = await request.json().catch(() => null) as IncomingMessage | null;
  if (!message?.ID || !message.Chat) {
    return NextResponse.json({ ignored: true, reason: "not-a-message" });
  }
  if (message.FromMe) {
    return NextResponse.json({ ignored: true, reason: "from-me" });
  }
  if (message.Media?.Type?.toLowerCase() !== "audio") {
    return NextResponse.json({ ignored: true, reason: "not-audio" });
  }
  if (message.Chat.includes("broadcast")) {
    return NextResponse.json({ ignored: true, reason: "broadcast" });
  }

  const settings = await readSettings();
  const isGroupChat = message.Chat.endsWith("@g.us");
  const candidates = new Set([jidDigits(message.SenderJID), jidDigits(message.Chat)].filter(Boolean));
  const known = settings.recipients.find((recipient) => isGroupDestination(recipient.phone)
    ? recipient.phone === message.Chat
    : !isGroupChat && candidates.has(recipient.phone.replace(/\D/g, "")));
  if (isGroupChat && !known) {
    // Only groups that have their own agenda button reach Chapu.
    await appendEvent("whatsapp", `Audio de un grupo sin botón ignorado (${message.ChatName || "grupo"})`);
    return NextResponse.json({ ignored: true, reason: "group-not-in-agenda" });
  }
  // Numbers outside the agenda are accepted too; Chapu announces them as "desconocido".
  const sender: Sender = known ? { id: known.id, label: known.label } : null;

  await fs.mkdir(incomingDirectory, { recursive: true });
  const safeId = message.ID.replace(/[^a-zA-Z0-9_-]/g, "_");
  const markerPath = path.join(incomingDirectory, `${safeId}.json`);
  try {
    await fs.writeFile(markerPath, JSON.stringify({ status: "processing", receivedAt: new Date().toISOString() }), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return NextResponse.json({ ignored: true, reason: "duplicate" });
    }
    throw error;
  }

  const senderLabel = sender?.label ?? `desconocido (${message.PushName || message.ChatName || "sin nombre"})`;
  await appendEvent("whatsapp", `Nueva nota de voz recibida de ${senderLabel}`);
  void processIncomingAudio({ Chat: message.Chat, ID: message.ID }, sender);
  return NextResponse.json({ accepted: true }, { status: 202 });
}
