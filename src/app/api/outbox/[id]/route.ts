import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ensureOutboxDirectories, pendingDirectory, playedDirectory, safeOutboxId, servedDirectory } from "@/lib/outbox";
import { appendEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!safeOutboxId(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  await ensureOutboxDirectories();
  try {
    await fs.rename(
      path.join(pendingDirectory, `${id}.wav`),
      path.join(playedDirectory, `${id}.wav`),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "Mensaje no encontrado" }, { status: 404 });
    }
    throw error;
  }

  await fs.rm(path.join(servedDirectory, id), { force: true });
  await appendEvent("device", "EMEET terminó de reproducir la nota de voz");
  return NextResponse.json({ id, status: "played" });
}
