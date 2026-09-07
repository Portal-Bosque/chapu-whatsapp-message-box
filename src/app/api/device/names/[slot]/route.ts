import { promises as fs } from "node:fs";
import { resolveGreeting, resolveName, type ResolvedName } from "@/lib/names";
import { AGENDA_SLOTS, readSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveSlot(slot: string): Promise<ResolvedName | null> {
  if (slot === "greeting") return resolveGreeting();
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 0 || index >= AGENDA_SLOTS) {
    throw new Error("Invalid slot");
  }
  const settings = await readSettings();
  const recipient = settings.recipients[index];
  return recipient ? resolveName(recipient) : null;
}

// The ESP32 downloads the spoken name for an agenda slot (or the boot greeting) and caches it.
export async function GET(_request: Request, context: { params: Promise<{ slot: string }> }) {
  const { slot } = await context.params;
  try {
    const name = await resolveSlot(slot);
    if (!name) return new Response(null, { status: 404 });
    const buffer = await fs.readFile(name.filePath);
    return new Response(buffer, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(buffer.length),
        "X-Name-Version": name.version,
        "X-Name-Source": name.source,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid slot") return new Response("Invalid slot", { status: 400 });
    return new Response(null, { status: 404 });
  }
}
