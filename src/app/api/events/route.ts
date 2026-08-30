import { NextResponse } from "next/server";
import { clearEvents, readEvents } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ events: await readEvents() }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  await clearEvents();
  return NextResponse.json({ cleared: true });
}
