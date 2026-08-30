import { NextResponse } from "next/server";
import { addRecipient, readSettings, selectRecipient, updateRecipient } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readSettings(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json() as { selectedRecipientId?: string; label?: string; phone?: string };
  try {
    const settings = body.phone
      ? await addRecipient(body.label ?? "", body.phone)
      : await selectRecipient(body.selectedRecipientId ?? "");
    return NextResponse.json(settings);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Datos inválidos" }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const body = await request.json() as { id?: string; label?: string; phone?: string };
  try {
    return NextResponse.json(await updateRecipient(body.id ?? "", body.label ?? "", body.phone ?? ""));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Datos inválidos" }, { status: 400 });
  }
}
