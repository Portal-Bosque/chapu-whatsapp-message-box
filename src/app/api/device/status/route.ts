import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statusPath = path.join(process.cwd(), "data", "device", "status.json");
const ONLINE_WINDOW_MS = 7000;

type DeviceHeartbeat = {
  speaker: boolean;
  microphone: boolean;
  recording: boolean;
  lastSeenAt: string;
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Partial<DeviceHeartbeat> | null;
  if (!body || typeof body.speaker !== "boolean" || typeof body.microphone !== "boolean") {
    return NextResponse.json({ error: "Invalid device status" }, { status: 400 });
  }

  const heartbeat: DeviceHeartbeat = {
    speaker: body.speaker,
    microphone: body.microphone,
    recording: body.recording === true,
    lastSeenAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, JSON.stringify(heartbeat), "utf8");
  return NextResponse.json({ received: true });
}

export async function GET() {
  try {
    const heartbeat = JSON.parse(await fs.readFile(statusPath, "utf8")) as DeviceHeartbeat;
    const ageMs = Date.now() - new Date(heartbeat.lastSeenAt).getTime();
    const espConnected = Number.isFinite(ageMs) && ageMs <= ONLINE_WINDOW_MS;
    return NextResponse.json({
      espConnected,
      speaker: espConnected && heartbeat.speaker,
      microphone: espConnected && heartbeat.microphone,
      recording: espConnected && heartbeat.recording,
      functional: espConnected && heartbeat.speaker && heartbeat.microphone,
      lastSeenAt: heartbeat.lastSeenAt,
      ageMs: Math.max(0, ageMs),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return NextResponse.json({
      espConnected: false,
      speaker: false,
      microphone: false,
      recording: false,
      functional: false,
      lastSeenAt: null,
      ageMs: null,
    }, { headers: { "Cache-Control": "no-store" } });
  }
}
