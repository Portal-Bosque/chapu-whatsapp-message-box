import { NextResponse } from "next/server";
import { nameSource } from "@/lib/names";
import { appendEvent } from "@/lib/events";
import { addRecipient, moveRecipient, readSettings, selectRecipient, updateRecipient, type MessageBoxSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The panel shows whether each contact has a recorded name or uses the Mac voice.
async function withNameSources(settings: MessageBoxSettings) {
  const recipients = await Promise.all(settings.recipients.map(async (recipient) => ({
    ...recipient,
    nameSource: await nameSource(recipient),
  })));
  return { ...settings, recipients };
}

export async function GET() {
  return NextResponse.json(await withNameSources(await readSettings()), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const body = await request.json() as { selectedRecipientId?: string; label?: string; phone?: string };
  try {
    const settings = body.phone
      ? await addRecipient(body.label ?? "", body.phone)
      : await selectRecipient(body.selectedRecipientId ?? "");
    return NextResponse.json(await withNameSources(settings));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Datos inválidos" }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const body = await request.json() as { id?: string; label?: string; phone?: string; toSlot?: number };
  try {
    if (typeof body.toSlot === "number") {
      const { settings, swappedWith } = await moveRecipient(body.id ?? "", body.toSlot);
      const moved = settings.recipients.find((recipient) => recipient.id === body.id);
      const slot = settings.recipients.findIndex((recipient) => recipient.id === body.id) + 1;
      if (moved) {
        await appendEvent("device", swappedWith
          ? `${moved.label} pasa al botón ${slot}; ${swappedWith.label} toma el suyo`
          : `${moved.label} pasa al botón ${slot}`);
      }
      return NextResponse.json(await withNameSources(settings));
    }
    return NextResponse.json(await withNameSources(await updateRecipient(body.id ?? "", body.label ?? "", body.phone ?? "")));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Datos inválidos" }, { status: 400 });
  }
}
