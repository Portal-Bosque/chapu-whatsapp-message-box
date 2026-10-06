import { NextResponse } from "next/server";
import { listConversations } from "@/lib/live-transcripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ conversations: await listConversations() }, { headers: { "Cache-Control": "no-store" } });
}
