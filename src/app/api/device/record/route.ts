import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { appendEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deviceDirectory = path.join(process.cwd(), "data", "device");
const requestPath = path.join(deviceDirectory, "record-request.json");

async function ensureDeviceDirectory() {
  await fs.mkdir(deviceDirectory, { recursive: true });
}

export async function POST(request: Request) {
  await ensureDeviceDirectory();
  const body = await request.json().catch(() => ({})) as { action?: string };
  if (body.action !== "start" && body.action !== "stop") {
    return NextResponse.json({ error: "Expected action start or stop" }, { status: 400 });
  }
  const command = { id: randomUUID(), action: body.action, requestedAt: new Date().toISOString() };
  await fs.writeFile(requestPath, JSON.stringify(command), "utf8");
  await appendEvent("device", body.action === "start"
    ? "Orden de empezar a grabar enviada al ESP32"
    : "Orden de detener y subir enviada al ESP32");
  return NextResponse.json(command, { status: 202 });
}

export async function GET() {
  await ensureDeviceDirectory();
  try {
    const command = JSON.parse(await fs.readFile(requestPath, "utf8")) as { id: string; action: "start" | "stop" };
    return new Response(command.action, {
      status: command.action === "start" ? 200 : 202,
      headers: {
        "Content-Type": "text/plain",
        "X-Command-ID": command.id,
        "X-Record-Action": command.action,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}

export async function DELETE() {
  await ensureDeviceDirectory();
  try {
    const command = JSON.parse(await fs.readFile(requestPath, "utf8")) as { action?: string };
    await fs.unlink(requestPath);
    await appendEvent("device", command.action === "stop"
      ? "ESP32 confirmó la orden de detener"
      : "ESP32 confirmó la orden de empezar");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return NextResponse.json({ acknowledged: true });
}
