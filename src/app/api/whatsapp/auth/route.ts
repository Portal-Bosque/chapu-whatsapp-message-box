import { NextResponse } from "next/server";
import { logoutWacli, startWacliAuth } from "@/lib/wacli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(await startWacliAuth(), { status: 202 });
}

export async function DELETE() {
  try {
    await logoutWacli();
    return NextResponse.json({ authenticated: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo desvincular" }, { status: 500 });
  }
}
