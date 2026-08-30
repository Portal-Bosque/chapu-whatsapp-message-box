import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ensureRecordingsDirectory, isWave, recordingsDirectory, wavDurationMs } from "@/lib/recordings";
import { getSelectedRecipient } from "@/lib/settings";
import { sendVoiceMessage } from "@/lib/wacli";
import { appendEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_RECORDING_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_RECORDING_BYTES) {
    return NextResponse.json({ error: "Recording is too large" }, { status: 413 });
  }

  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.length === 0) {
    return NextResponse.json({ error: "Empty recording" }, { status: 400 });
  }
  if (buffer.length > MAX_RECORDING_BYTES) {
    return NextResponse.json({ error: "Recording is too large" }, { status: 413 });
  }
  if (!isWave(buffer)) {
    return NextResponse.json({ error: "Expected a WAV file" }, { status: 415 });
  }

  await ensureRecordingsDirectory();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${timestamp}_${randomUUID().slice(0, 8)}`;
  const filePath = path.join(recordingsDirectory, `${id}.wav`);
  const metadataPath = path.join(recordingsDirectory, `${id}.json`);
  const recipient = await getSelectedRecipient();
  const metadata = {
    source: "emeet",
    recipient,
    delivery: { status: "sending", updatedAt: new Date().toISOString() },
  };
  await Promise.all([
    fs.writeFile(filePath, buffer, { flag: "wx" }),
    fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), { flag: "wx" }),
  ]);
  const durationMs = wavDurationMs(buffer);
  await appendEvent("recording", `Audio recibido desde el EMEET: ${durationMs === null ? "duración desconocida" : `${(durationMs / 1000).toFixed(1)} s`}`);
  const deliveryStartedAt = performance.now();

  void sendVoiceMessage(filePath, recipient.phone, id).then(async (result) => {
    try {
      await fs.access(filePath);
      await fs.writeFile(metadataPath, JSON.stringify({
        ...metadata,
        delivery: { status: "sent", updatedAt: new Date().toISOString(), result },
      }, null, 2));
      await appendEvent("whatsapp", `Nota de voz entregada a ${recipient.label} (${recipient.phone}) · ${(performance.now() - deliveryStartedAt).toFixed(0)} ms desde que llegó a la Mac`);
    } catch {
      // The user may have deleted the recording while it was being sent.
    }
  }).catch(async (error) => {
    try {
      await fs.access(filePath);
      await fs.writeFile(metadataPath, JSON.stringify({
        ...metadata,
        delivery: {
          status: "error",
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "No se pudo enviar por WhatsApp",
        },
      }, null, 2));
      await appendEvent("error", `Falló el envío a WhatsApp: ${error instanceof Error ? error.message.split("\n")[0] : "error desconocido"}`);
    } catch {
      // The user may have deleted the recording while it was being sent.
    }
  });

  return NextResponse.json({
    id,
    url: `/api/recordings/${id}`,
    size: buffer.length,
    durationMs,
  }, { status: 201 });
}

export async function GET() {
  await ensureRecordingsDirectory();
  const entries = await fs.readdir(recordingsDirectory, { withFileTypes: true });
  const wavFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".wav"));

  const recordings = await Promise.all(wavFiles.map(async (entry) => {
    const id = entry.name.slice(0, -4);
    const filePath = path.join(recordingsDirectory, entry.name);
    const metadataPath = path.join(recordingsDirectory, `${id}.json`);
    const [stats, buffer, metadata] = await Promise.all([
      fs.stat(filePath),
      fs.readFile(filePath),
      fs.readFile(metadataPath, "utf8").then((value) => JSON.parse(value)).catch(() => null),
    ]);
    return {
      id,
      createdAt: stats.birthtime.toISOString(),
      size: stats.size,
      durationMs: wavDurationMs(buffer),
      url: `/api/recordings/${id}`,
      recipient: metadata?.recipient ?? null,
      delivery: metadata?.delivery ?? null,
    };
  }));

  recordings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return NextResponse.json({ recordings }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  await ensureRecordingsDirectory();
  const entries = await fs.readdir(recordingsDirectory, { withFileTypes: true });
  const messageFiles = entries.filter((entry) => entry.isFile() && (entry.name.endsWith(".wav") || entry.name.endsWith(".json")));
  const wavFiles = messageFiles.filter((entry) => entry.name.endsWith(".wav"));
  await Promise.all(messageFiles.map((entry) => fs.unlink(path.join(recordingsDirectory, entry.name))));
  return NextResponse.json({ deleted: wavFiles.length });
}
