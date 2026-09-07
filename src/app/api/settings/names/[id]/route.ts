import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { analyzeAudioQuality } from "@/lib/audio-quality";
import { appendEvent } from "@/lib/events";
import { deleteRecordedName, resolveName, saveRecordedName } from "@/lib/names";
import { isWave } from "@/lib/recordings";
import { readSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_NAME_BYTES = 1024 * 1024;
type RouteContext = { params: Promise<{ id: string }> };

async function findRecipient(id: string) {
  const settings = await readSettings();
  return settings.recipients.find((recipient) => recipient.id === id) ?? null;
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const recipient = await findRecipient(id);
  if (!recipient) return NextResponse.json({ error: "Destinatario desconocido" }, { status: 404 });
  try {
    const name = await resolveName(recipient);
    const buffer = await fs.readFile(name.filePath);
    return new Response(buffer, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(buffer.length),
        "X-Name-Source": name.source,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "No hay audio" }, { status: 404 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const recipient = await findRecipient(id);
  if (!recipient) return NextResponse.json({ error: "Destinatario desconocido" }, { status: 404 });

  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.length > MAX_NAME_BYTES) return NextResponse.json({ error: "El audio es demasiado largo" }, { status: 413 });
  if (!isWave(buffer)) return NextResponse.json({ error: "Se esperaba audio WAV" }, { status: 415 });

  const quality = analyzeAudioQuality(buffer);
  if (quality.discard) {
    return NextResponse.json({ error: "No se escuchó el nombre; probá de nuevo más cerca del micrófono" }, { status: 422 });
  }

  await saveRecordedName(id, buffer);
  await appendEvent("device", `Nombre grabado para ${recipient.label}; Chapu lo va a descargar`);
  return NextResponse.json({ saved: true, source: "recorded" });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const recipient = await findRecipient(id);
  if (!recipient) return NextResponse.json({ error: "Destinatario desconocido" }, { status: 404 });
  await deleteRecordedName(id);
  await appendEvent("device", `Nombre grabado de ${recipient.label} borrado; vuelve la voz de la Mac`);
  return NextResponse.json({ deleted: true, source: "generated" });
}
