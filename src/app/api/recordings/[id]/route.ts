import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { recordingsDirectory, safeRecordingId } from "@/lib/recordings";
import { sendVoiceMessage } from "@/lib/wacli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

type RecordingMetadata = {
  source?: string;
  recipient?: { id: string; label: string; phone: string; color?: string };
  delivery?: { status: string; updatedAt?: string; error?: string; result?: unknown };
};

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!safeRecordingId(id)) return new Response("Invalid recording id", { status: 400 });

  try {
    const buffer = await fs.readFile(path.join(recordingsDirectory, `${id}.wav`));
    const range = request.headers.get("range");
    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store",
    };

    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416 });
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), buffer.length - 1) : buffer.length - 1;
      if (start > end || start >= buffer.length) return new Response(null, { status: 416 });
      const chunk = buffer.subarray(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          ...commonHeaders,
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
        },
      });
    }

    return new Response(buffer, {
      headers: { ...commonHeaders, "Content-Length": String(buffer.length) },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Response("Recording not found", { status: 404 });
    }
    throw error;
  }
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!safeRecordingId(id)) return NextResponse.json({ error: "Invalid recording id" }, { status: 400 });

  const filePath = path.join(recordingsDirectory, `${id}.wav`);
  const metadataPath = path.join(recordingsDirectory, `${id}.json`);
  try {
    await fs.access(filePath);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as RecordingMetadata;
    if (!metadata.recipient?.phone) {
      return NextResponse.json({ error: "La grabación no tiene destinatario" }, { status: 400 });
    }
    if (metadata.delivery?.status === "sent") {
      return NextResponse.json({ error: "El mensaje ya fue enviado" }, { status: 409 });
    }

    const sendingMetadata = {
      ...metadata,
      delivery: { status: "sending", updatedAt: new Date().toISOString() },
    };
    await fs.writeFile(metadataPath, JSON.stringify(sendingMetadata, null, 2));

    try {
      const result = await sendVoiceMessage(filePath, metadata.recipient.phone, id);
      await fs.writeFile(metadataPath, JSON.stringify({
        ...metadata,
        delivery: { status: "sent", updatedAt: new Date().toISOString(), result },
      }, null, 2));
      return NextResponse.json({ sent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo enviar por WhatsApp";
      await fs.writeFile(metadataPath, JSON.stringify({
        ...metadata,
        delivery: { status: "error", updatedAt: new Date().toISOString(), error: message },
      }, null, 2));
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "Recording not found" }, { status: 404 });
    }
    throw error;
  }
}
