import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ensureOutboxDirectories, listOutboxMessages, pendingDirectory, playedDirectory, queuedDirectory, servedDirectory } from "@/lib/outbox";
import { isWave, wavDurationMs } from "@/lib/recordings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_MESSAGE_BYTES) {
    return NextResponse.json({ error: "El mensaje es demasiado largo" }, { status: 413 });
  }

  const buffer = Buffer.from(await request.arrayBuffer());
  if (!isWave(buffer)) {
    return NextResponse.json({ error: "Se esperaba audio WAV" }, { status: 415 });
  }
  if (buffer.length > MAX_MESSAGE_BYTES) {
    return NextResponse.json({ error: "El mensaje es demasiado largo" }, { status: 413 });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${timestamp}_${randomUUID().slice(0, 8)}`;
  await ensureOutboxDirectories();
  await fs.writeFile(path.join(pendingDirectory, `${id}.wav`), buffer, { flag: "wx" });

  return NextResponse.json({
    id,
    status: "pending",
    size: buffer.length,
    durationMs: wavDurationMs(buffer),
  }, { status: 201 });
}

export async function GET() {
  const messages = await listOutboxMessages();
  return NextResponse.json({ messages }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  await ensureOutboxDirectories();
  const removeWaveFiles = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const wavFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".wav"));
    await Promise.all(wavFiles.map((entry) => fs.unlink(path.join(directory, entry.name))));
    return wavFiles.length;
  };
  const [queued, pending, played] = await Promise.all([
    removeWaveFiles(queuedDirectory),
    removeWaveFiles(pendingDirectory),
    removeWaveFiles(playedDirectory),
    fs.rm(servedDirectory, { recursive: true, force: true }),
  ]);
  await fs.mkdir(servedDirectory, { recursive: true });
  return NextResponse.json({ deleted: queued + pending + played });
}
