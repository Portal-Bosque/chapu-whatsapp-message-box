import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { analyzeAudioQuality } from "@/lib/audio-quality";
import { ensureRecordingsDirectory, isWave, readLatestAudioResult, recordingsDirectory, wavDurationMs, writeLatestAudioResult } from "@/lib/recordings";
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${timestamp}_${randomUUID().slice(0, 8)}`;
  await appendEvent("recording", "Procesando audio: buscando voz y midiendo el nivel de sonido…");
  const analysisStartedAt = performance.now();
  const quality = analyzeAudioQuality(buffer);
  const analysisElapsedMs = performance.now() - analysisStartedAt;
  const audioResult = {
    id,
    processedAt: new Date().toISOString(),
    discarded: quality.discard,
    reason: quality.reason,
    metrics: quality.metrics && {
      durationMs: quality.metrics.durationMs,
      rmsDbfs: quality.metrics.rmsDbfs,
      peakDbfs: quality.metrics.peakDbfs,
      activeMs: quality.metrics.activeMs,
      activeRatio: quality.metrics.activeRatio,
    },
  };
  await writeLatestAudioResult(audioResult);

  if (quality.discard) {
    const metrics = quality.metrics;
    const reason = quality.reason === "too_short" ? "demasiado corto"
      : quality.reason === "inaudible" ? "señal demasiado baja"
        : "no se detectó voz útil";
    const detail = metrics ? `RMS ${metrics.rmsDbfs.toFixed(1)} dBFS · pico ${metrics.peakDbfs.toFixed(1)} dBFS · voz útil ${metrics.activeMs} ms` : "sin métricas";
    await appendEvent("recording", `Audio descartado: ${reason} (${detail})`);
    // A 2xx tells the ESP32 that the upload was processed, preventing retries.
    return NextResponse.json({ id, discarded: true, reason: quality.reason, metrics: quality.metrics });
  }

  await ensureRecordingsDirectory();
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
  await appendEvent("recording", `Audio válido: se detectó voz en ${analysisElapsedMs.toFixed(0)} ms · ${durationMs === null ? "duración desconocida" : `${(durationMs / 1000).toFixed(1)} s`}`);
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
    discarded: false,
    quality: quality.metrics,
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
  const latestAudioResult = await readLatestAudioResult();
  return NextResponse.json({ recordings, latestAudioResult }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  await ensureRecordingsDirectory();
  const entries = await fs.readdir(recordingsDirectory, { withFileTypes: true });
  const messageFiles = entries.filter((entry) => entry.isFile() && (entry.name.endsWith(".wav") || entry.name.endsWith(".json")));
  const wavFiles = messageFiles.filter((entry) => entry.name.endsWith(".wav"));
  await Promise.all(messageFiles.map((entry) => fs.unlink(path.join(recordingsDirectory, entry.name))));
  return NextResponse.json({ deleted: wavFiles.length });
}
