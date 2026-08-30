import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { appendEvent } from "@/lib/events";
import { ensureOutboxDirectories, queuedDirectory } from "@/lib/outbox";
import { readSettings } from "@/lib/settings";
import { wacliStoreDirectory } from "@/lib/wacli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const incomingDirectory = path.join(process.cwd(), "data", "whatsapp-incoming");

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

async function processIncomingAudio(message: Required<Pick<IncomingMessage, "Chat" | "ID">>, senderLabel: string) {
  const safeId = message.ID.replace(/[^a-zA-Z0-9_-]/g, "_");
  const markerPath = path.join(incomingDirectory, `${safeId}.json`);
  const sourcePath = path.join(incomingDirectory, `${safeId}.media`);
  const waveTempPath = path.join(incomingDirectory, `${safeId}.wav.tmp`);
  const outboxId = `wa_${safeId}`;
  const outboxPath = path.join(queuedDirectory, `${outboxId}.wav`);

  try {
    await appendEvent("whatsapp", `Descargando nota de voz de ${senderLabel}`);
    await execFileAsync("wacli", [
      "--store", wacliStoreDirectory,
      "--read-only",
      "--json",
      "--timeout", "2m",
      "media", "download",
      "--chat", message.Chat,
      "--id", message.ID,
      "--output", sourcePath,
    ], { timeout: 130000, maxBuffer: 1024 * 1024 });

    await appendEvent("conversion", "Convirtiendo audio entrante a WAV mono/16 kHz");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", sourcePath,
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-f", "wav", waveTempPath,
    ], { timeout: 30000 });

    await ensureOutboxDirectories();
    await fs.rename(waveTempPath, outboxPath);
    await fs.writeFile(markerPath, JSON.stringify({ status: "queued", senderLabel, queuedAt: new Date().toISOString() }, null, 2));
    await appendEvent("device", `Nota de voz de ${senderLabel} guardada en la cola de Chapu`);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "error desconocido";
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
  if (message.Chat.endsWith("@g.us") || message.Chat.includes("broadcast")) {
    await appendEvent("whatsapp", "Audio de grupo/estado ignorado");
    return NextResponse.json({ ignored: true, reason: "not-direct" });
  }

  const settings = await readSettings();
  const candidates = new Set([jidDigits(message.SenderJID), jidDigits(message.Chat)].filter(Boolean));
  const allowed = settings.recipients.find((recipient) => candidates.has(recipient.phone.replace(/\D/g, "")));
  if (!allowed) {
    await appendEvent("whatsapp", `Audio entrante ignorado: ${message.PushName || message.ChatName || "número no autorizado"} no está en los botones`);
    return NextResponse.json({ ignored: true, reason: "sender-not-allowed" });
  }

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

  const senderLabel = allowed.label;
  await appendEvent("whatsapp", `Nueva nota de voz recibida de ${senderLabel}`);
  void processIncomingAudio({ Chat: message.Chat, ID: message.ID }, senderLabel);
  return NextResponse.json({ accepted: true }, { status: 202 });
}
