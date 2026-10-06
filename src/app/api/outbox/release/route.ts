import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { appendEvent } from "@/lib/events";
import { readIncomingMarker, selectSenderRecipient } from "@/lib/incoming";
import { isJokeId, jokePath } from "@/lib/jokes";
import { advanceRewind, ensureOutboxDirectories, isListenable, noteReleased, pendingDirectory, playedDirectory, queuedDirectory, replayPick, rewindHead, startRewind } from "@/lib/outbox";

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

// The note Chapu is about to hear decides who the send button answers.
async function selectSender(outboxId: string) {
  const marker = await readIncomingMarker(outboxId);
  await selectSenderRecipient(marker.senderId, `Escuchando a ${marker.senderLabel ?? "desconocido"}`);
}

export async function POST(request: Request) {
  await ensureOutboxDirectories();
  const fromDevice = request.headers.get("x-device-id") !== null;

  const pending = await orderedWaveFiles(pendingDirectory);
  if (pending.some((message) => isListenable(message.name))) {
    return NextResponse.json({ error: "Chapu ya está reproduciendo otro mensaje" }, { status: 409 });
  }

  const source = fromDevice ? "Botón físico recibir" : "Botón escuchar de la web";

  // Holding the listen button starts over from the newest note; the presses
  // that follow walk back through the older ones before anything else plays.
  const rewindRequested = request.headers.get("x-rewind") === "1";
  if (rewindRequested) await startRewind();
  const rewinding = await rewindHead();
  if (rewinding) {
    try {
      await fs.rename(path.join(rewinding.directory, `${rewinding.id}.wav`), path.join(pendingDirectory, `${rewinding.id}.wav`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return NextResponse.json({ error: "La cola cambió; probá nuevamente" }, { status: 409 });
      }
      throw error;
    }
    await advanceRewind(rewinding.id);
    await noteReleased(rewinding.id);
    await appendEvent("device", rewindRequested
      ? `${source} mantenido: vuelve a empezar desde el mensaje más nuevo`
      : `${source}: sigue el repaso con el mensaje anterior`);
    await selectSender(rewinding.id);
    return NextResponse.json({ id: rewinding.id, status: "pending", replay: true, remaining: 0 });
  }
  const queued = await orderedWaveFiles(queuedDirectory);
  const next = queued[0];

  if (!next) {
    // Nothing new: replay a random note from yesterday or today, or one of
    // Chapu's invented messages when those days were quiet.
    const lastId = await replayPick();
    if (!lastId) {
      return NextResponse.json({ error: "No hay mensajes por escuchar" }, { status: 404 });
    }
    const pendingPath = path.join(pendingDirectory, `${lastId}.wav`);
    try {
      if (isJokeId(lastId)) {
        // Invented messages stay in their folder; Chapu plays a disposable copy.
        await fs.copyFile(jokePath(lastId), pendingPath);
      } else {
        await fs.rename(path.join(playedDirectory, `${lastId}.wav`), pendingPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return NextResponse.json({ error: "La cola cambió; probá nuevamente" }, { status: 409 });
      }
      throw error;
    }
    await noteReleased(lastId);
    if (isJokeId(lastId)) {
      await appendEvent("device", `${source}: sin mensajes nuevos, Chapu cuenta uno de sus mensajes inventados`);
    } else {
      await appendEvent("device", `${source}: sin mensajes nuevos, repitiendo uno al azar de ayer y hoy`);
      await selectSender(lastId);
    }
    return NextResponse.json({ id: lastId, status: "pending", replay: true, remaining: 0 });
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
  await noteReleased(id);
  await appendEvent("device", `${source}: próximo mensaje liberado para Chapu`);
  await selectSender(id);
  return NextResponse.json({ id, status: "pending", replay: false, remaining: queued.length - 1 });
}
