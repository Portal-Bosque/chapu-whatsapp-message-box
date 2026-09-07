import { NextResponse } from "next/server";
import { listWacliGroups, refreshWacliGroups } from "@/lib/wacli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const message = (error as NodeJS.ErrnoException).code === "ENOENT"
    ? "wacli no está instalado"
    : error instanceof Error ? error.message.split("\n")[0] : "No se pudieron listar los grupos";
  return NextResponse.json({ groups: [], error: message }, { headers: { "Cache-Control": "no-store" } });
}

// Groups a contact button can point at, from wacli's local data.
export async function GET() {
  try {
    return NextResponse.json({ groups: await listWacliGroups() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

// Fetches the live group list (names included), pausing the listener briefly.
export async function POST(request: Request) {
  try {
    const groups = await refreshWacliGroups(new URL(request.url).origin);
    return NextResponse.json({ groups, refreshed: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
