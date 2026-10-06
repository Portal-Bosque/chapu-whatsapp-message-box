import { NextResponse } from "next/server";
import { appendEvent } from "@/lib/events";
import { requestLiveCommand } from "@/lib/live-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Starts or stops live mode on the ESP32 as if the roulette button had been held.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { action?: string };
  if (body.action !== "start" && body.action !== "stop") {
    return NextResponse.json({ error: "Expected action start or stop" }, { status: 400 });
  }
  requestLiveCommand(body.action);
  await appendEvent("device", body.action === "start"
    ? "Orden de empezar el modo charla enviada al ESP32"
    : "Orden de terminar el modo charla enviada al ESP32");
  return NextResponse.json({ action: body.action }, { status: 202 });
}
