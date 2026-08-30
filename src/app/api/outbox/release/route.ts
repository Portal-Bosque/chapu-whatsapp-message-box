import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { appendEvent } from "@/lib/events";
import { ensureOutboxDirectories, pendingDirectory, queuedDirectory } from "@/lib/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function orderedWaveFiles(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".wav"))
    .map(async (entry) => ({
      name: entry.name,
      createdAt: (await fs.stat(path.join(directory, entry.name))).birthtimeMs,
    })));
  return candidates.sort((a, b) => a.createdAt - b.createdAt);
}

export async function POST() {
  await ensureOutboxDirectories();

  const pending = await orderedWaveFiles(pendingDirectory);
  if (pending.some((message) => message.name.startsWith("wa_"))) {
    return NextResponse.json({ error: "Chapu ya está reproduciendo otro mensaje" }, { status: 409 });
  }

  const queued = await orderedWaveFiles(queuedDirectory);
  const next = queued[0];
  if (!next) {
    return NextResponse.json({ error: "No hay mensajes por escuchar" }, { status: 404 });
  }

  try {
    await fs.rename(
      path.join(queuedDirectory, next.name),
      path.join(pendingDirectory, next.name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "La cola cambió; probá nuevamente" }, { status: 409 });
    }
    throw error;
  }

  const id = next.name.slice(0, -4);
  await appendEvent("device", "Botón escuchar: próximo mensaje liberado para Chapu");
  return NextResponse.json({ id, status: "pending", remaining: queued.length - 1 });
}
