import { NextResponse } from "next/server";
import { DEVICE_ONLINE_WINDOW_MS, heartbeatAgeMs, readDeviceHeartbeat, writeDeviceHeartbeat, type DeviceHeartbeat } from "@/lib/device";
import { appendEvent } from "@/lib/events";
import { slotNameVersions } from "@/lib/names";
import { listOutboxMessages } from "@/lib/outbox";
import { sendReminderCue } from "@/lib/reminders";
import { AGENDA_SLOTS, readSettings, selectRecipient } from "@/lib/settings";
import { isWhatsappReady } from "@/lib/wacli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type HeartbeatBody = Partial<DeviceHeartbeat> & { selectedSlot?: unknown };

// The ESP32 posts its inputs and receives the state its lamps must show.
async function panelState() {
  const [settings, messages] = await Promise.all([readSettings(), listOutboxMessages()]);
  const incoming = messages.filter((message) => message.id.startsWith("wa_"));
  const selectedSlot = settings.recipients.findIndex((recipient) => recipient.id === settings.selectedRecipientId);
  return {
    selectedSlot: selectedSlot >= 0 && selectedSlot < AGENDA_SLOTS ? selectedSlot : null,
    slots: Array.from({ length: AGENDA_SLOTS }, (_, index) => Boolean(settings.recipients[index])),
    // Spoken-name versions; the ESP32 re-downloads a slot when its version changes.
    names: await slotNameVersions(settings),
    queued: incoming.filter((message) => message.status === "queued").length,
    playing: incoming.some((message) => message.status === "pending"),
    // Lets the ESP32 announce itself only once it can really send and receive.
    whatsappReady: await isWhatsappReady(),
  };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as HeartbeatBody | null;
  if (!body || typeof body.speaker !== "boolean" || typeof body.microphone !== "boolean") {
    return NextResponse.json({ error: "Invalid device status" }, { status: 400 });
  }

  const previous = await readDeviceHeartbeat();
  const cameBack = heartbeatAgeMs(previous) > DEVICE_ONLINE_WINDOW_MS;
  const heartbeat: DeviceHeartbeat = {
    speaker: body.speaker,
    microphone: body.microphone,
    recording: body.recording === true,
    playing: body.playing === true,
    lastSeenAt: new Date().toISOString(),
  };
  await writeDeviceHeartbeat(heartbeat);
  if (cameBack) {
    await appendEvent("device", previous ? "ESP32 de vuelta en línea" : "ESP32 conectado por primera vez");
    // A boot or reconnection with unheard notes waiting gets the voice cue.
    void sendReminderCue("el ESP32 arrancó con mensajes sin escuchar", { force: true });
  }

  if (Number.isInteger(body.selectedSlot)) {
    const slot = body.selectedSlot as number;
    const settings = await readSettings();
    const recipient = settings.recipients[slot];
    if (slot < 0 || slot >= AGENDA_SLOTS || !recipient) {
      await appendEvent("device", `Botón de agenda ${slot + 1} presionado, pero no tiene contacto asignado`);
    } else if (recipient.id !== settings.selectedRecipientId) {
      await selectRecipient(recipient.id);
      await appendEvent("device", `Botón de agenda ${slot + 1}: ahora se habla con ${recipient.label}`);
    }
  }

  return NextResponse.json({ received: true, ...(await panelState()) }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const heartbeat = await readDeviceHeartbeat();
  if (heartbeat) {
    const ageMs = heartbeatAgeMs(heartbeat);
    const espConnected = ageMs <= DEVICE_ONLINE_WINDOW_MS;
    return NextResponse.json({
      espConnected,
      speaker: espConnected && heartbeat.speaker,
      microphone: espConnected && heartbeat.microphone,
      recording: espConnected && heartbeat.recording,
      playing: espConnected && heartbeat.playing === true,
      functional: espConnected && heartbeat.speaker && heartbeat.microphone,
      lastSeenAt: heartbeat.lastSeenAt,
      ageMs,
    }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({
    espConnected: false,
    speaker: false,
    microphone: false,
    recording: false,
    playing: false,
    functional: false,
    lastSeenAt: null,
    ageMs: null,
  }, { headers: { "Cache-Control": "no-store" } });
}
