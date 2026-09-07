"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { EventLog } from "@/components/event-log";
import { NameRecorder } from "@/components/name-recorder";

type Recipient = { id: string; label: string; phone: string; color: string; nameSource?: "recorded" | "generated" };
type WhatsappGroup = { jid: string; name: string; joined: boolean };
const groupLabel = (group: WhatsappGroup) => group.name || `Grupo sin nombre · …${group.jid.replace(/@g\.us$/, "").slice(-4)}`;
const isGroupDestination = (value: string) => /^\d{5,}@g\.us$/.test(value);
type Settings = { recipients: Recipient[]; selectedRecipientId: string };
type ChapuMessage = { id: string; status: "queued" | "pending" | "played" };
type DeviceStatus = {
  espConnected: boolean;
  speaker: boolean;
  microphone: boolean;
  recording: boolean;
  functional: boolean;
  lastSeenAt: string | null;
};
type WhatsappStatus = {
  installed: boolean;
  authenticated: boolean;
  phone?: string;
  authRunning: boolean;
  qrDataUrl: string | null;
  error: string | null;
  syncRunning: boolean;
  syncError: string | null;
};
type LatestAudioResult = {
  id: string;
  discarded: boolean;
  reason: string;
  metrics: { rmsDbfs: number; peakDbfs: number; activeMs: number } | null;
};

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const HIDDEN_PHONE = "••• ••• •••…";

export function FamilyPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [whatsapp, setWhatsapp] = useState<WhatsappStatus | null>(null);
  const [showAddRecipient, setShowAddRecipient] = useState(false);
  const [editingRecipientId, setEditingRecipientId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [showPhone, setShowPhone] = useState(false);
  const [destinationKind, setDestinationKind] = useState<"phone" | "group">("phone");
  const [groups, setGroups] = useState<WhatsappGroup[]>([]);
  const [groupsError, setGroupsError] = useState("");
  const [panelError, setPanelError] = useState("");
  const [emeetState, setEmeetState] = useState<"idle" | "recording" | "sending" | "sent" | "discarded" | "error">("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [chapuMessages, setChapuMessages] = useState<ChapuMessage[]>([]);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [releasingMessage, setReleasingMessage] = useState(false);
  const previousRecordingId = useRef<string | null>(null);
  const previousAudioResultId = useRef<string | null>(null);

  const loadWhatsapp = useCallback(async () => {
    try {
      const response = await fetch("/api/whatsapp/status", { cache: "no-store" });
      setWhatsapp(await response.json() as WhatsappStatus);
    } catch {
      setWhatsapp((current) => current ? { ...current, error: "No se pudo consultar wacli" } : null);
    }
  }, []);

  const loadChapuQueue = useCallback(async () => {
    try {
      const response = await fetch("/api/outbox", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { messages: ChapuMessage[] };
      setChapuMessages(data.messages.filter((message) => message.id.startsWith("wa_")));
    } catch {
      // The next poll will update the indicator when the local server returns.
    }
  }, []);

  const loadDeviceStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/device/status", { cache: "no-store" });
      if (response.ok) setDeviceStatus(await response.json() as DeviceStatus);
    } catch {
      setDeviceStatus((current) => current ? { ...current, espConnected: false, functional: false } : null);
    }
  }, []);

  // Polled so that the agenda buttons on the physical box are reflected here.
  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (response.ok) setSettings(await response.json() as Settings);
    } catch {
      // The next poll will refresh the agenda when the local server returns.
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadSettings();
      void loadWhatsapp();
      void loadChapuQueue();
      void loadDeviceStatus();
    }, 0);
    const interval = window.setInterval(() => {
      void loadSettings();
      void loadWhatsapp();
      void loadChapuQueue();
      void loadDeviceStatus();
    }, 1000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadChapuQueue, loadDeviceStatus, loadSettings, loadWhatsapp]);

  useEffect(() => {
    if (emeetState !== "recording") return;
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(interval);
  }, [emeetState]);

  const [refreshingGroups, setRefreshingGroups] = useState(false);

  const loadGroups = async (refresh = false) => {
    setGroupsError("");
    if (refresh) setRefreshingGroups(true);
    try {
      const response = await fetch("/api/whatsapp/groups", { method: refresh ? "POST" : "GET", cache: "no-store" });
      const data = await response.json() as { groups: WhatsappGroup[]; error?: string };
      setGroups(data.groups);
      if (data.error) setGroupsError(data.error);
      else if (data.groups.length === 0) setGroupsError("Sin grupos: tocá Actualizar para pedirle la lista a WhatsApp");
    } catch {
      setGroupsError("No se pudieron listar los grupos");
    } finally {
      setRefreshingGroups(false);
    }
  };

  const chooseDestinationKind = (kind: "phone" | "group") => {
    setDestinationKind(kind);
    setPhone("");
    setShowPhone(false);
    if (kind === "group") void loadGroups();
  };

  const startWhatsappLogin = async () => {
    setPanelError("");
    const response = await fetch("/api/whatsapp/auth", { method: "POST" });
    if (!response.ok) {
      setPanelError("No se pudo iniciar el login de WhatsApp");
      return;
    }
    await loadWhatsapp();
  };

  const chooseRecipient = async (id: string) => {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedRecipientId: id }),
    });
    if (response.ok) setSettings(await response.json() as Settings);
  };

  const saveRecipient = async (event: React.FormEvent) => {
    event.preventDefault();
    setPanelError("");
    const response = await fetch("/api/settings", {
      method: editingRecipientId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editingRecipientId, label, phone }),
    });
    const data = await response.json();
    if (!response.ok) {
      setPanelError(data.error ?? "No se pudo guardar el contacto");
      return;
    }
    setSettings(data as Settings);
    setLabel("");
    setPhone("");
    setShowPhone(false);
    setShowAddRecipient(false);
    setEditingRecipientId(null);
  };

  const moveRecipientToSlot = async (id: string, toSlot: number) => {
    setPanelError("");
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, toSlot }),
    });
    const data = await response.json();
    if (!response.ok) {
      setPanelError(data.error ?? "No se pudo mover el contacto");
      return;
    }
    setSettings(data as Settings);
  };

  const openNewRecipient = () => {
    setEditingRecipientId(null);
    setLabel("");
    setPhone("");
    setShowPhone(false);
    setDestinationKind("phone");
    setShowAddRecipient(true);
  };

  const openRecipientEditor = (recipient: Recipient) => {
    setEditingRecipientId(recipient.id);
    setLabel(recipient.label);
    setPhone(recipient.phone);
    setShowPhone(false);
    const kind = isGroupDestination(recipient.phone) ? "group" : "phone";
    setDestinationKind(kind);
    if (kind === "group") void loadGroups();
    setShowAddRecipient(true);
  };

  const closeRecipientEditor = () => {
    setShowAddRecipient(false);
    setEditingRecipientId(null);
    setLabel("");
    setPhone("");
    setShowPhone(false);
  };

  const waitForEmeetDelivery = async () => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await wait(500);
      const response = await fetch("/api/recordings", { cache: "no-store" });
      const data = await response.json() as {
        recordings: Array<{ id: string; delivery?: { status?: string; error?: string } }>;
        latestAudioResult: LatestAudioResult | null;
      };
      if (data.latestAudioResult?.id !== previousAudioResultId.current && data.latestAudioResult?.discarded) {
        setEmeetState("discarded");
        window.setTimeout(() => setEmeetState("idle"), 5000);
        return;
      }
      const newest = data.recordings[0];
      if (!newest || newest.id === previousRecordingId.current) continue;
      if (newest.delivery?.status === "sent") {
        setEmeetState("sent");
        window.setTimeout(() => setEmeetState("idle"), 4000);
        return;
      }
      if (newest.delivery?.status === "error") {
        setPanelError(newest.delivery.error ?? "WhatsApp rechazó el envío");
        setEmeetState("error");
        return;
      }
    }
    setPanelError("El envío tardó más de lo esperado");
    setEmeetState("error");
  };

  const toggleEmeetRecording = async () => {
    setPanelError("");
    if (emeetState === "recording") {
      setEmeetState("sending");
      const command = await fetch("/api/device/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      if (!command.ok) {
        setEmeetState("error");
        setPanelError("No se pudo detener la grabación del EMEET");
        return;
      }
      await waitForEmeetDelivery();
      return;
    }

    const beforeResponse = await fetch("/api/recordings", { cache: "no-store" });
    const before = await beforeResponse.json() as { recordings: Array<{ id: string }>; latestAudioResult: LatestAudioResult | null };
    previousRecordingId.current = before.recordings[0]?.id ?? null;
    previousAudioResultId.current = before.latestAudioResult?.id ?? null;
    const command = await fetch("/api/device/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    if (!command.ok) {
      setEmeetState("error");
      setPanelError("No se pudo iniciar la grabación del EMEET");
      return;
    }
    setRecordingSeconds(0);
    setEmeetState("recording");
  };

  const listenToNextMessage = async () => {
    setPanelError("");
    setReleasingMessage(true);
    try {
      const response = await fetch("/api/outbox/release", { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "No se pudo liberar el mensaje");
      await loadChapuQueue();
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "No se pudo reproducir el mensaje");
    } finally {
      setReleasingMessage(false);
    }
  };

  const selectedRecipient = settings?.recipients.find((recipient) => recipient.id === settings.selectedRecipientId);
  const editingRecipient = settings?.recipients.find((recipient) => recipient.id === editingRecipientId) ?? null;
  const agendaSlots = Array.from({ length: 4 }, (_, index) => settings?.recipients[index] ?? null);
  const queuedMessages = chapuMessages.filter((message) => message.status === "queued").length;
  const messagePlaying = chapuMessages.some((message) => message.status === "pending");
  const hasPlayedMessage = chapuMessages.some((message) => message.status === "played");
  const unheardMessages = queuedMessages + (messagePlaying ? 1 : 0);
  const deviceHealth = deviceStatus?.functional ? "ready"
    : deviceStatus?.espConnected ? "partial"
      : "offline";
  const deviceHealthLabel = deviceStatus?.functional ? "EMEET conectado y funcional"
    : deviceStatus?.espConnected && deviceStatus.speaker ? "Parlante listo · micrófono no detectado"
      : deviceStatus?.espConnected && deviceStatus.microphone ? "Micrófono listo · parlante no detectado"
        : deviceStatus?.espConnected ? "ESP32 conectado · EMEET no detectado"
          : "ESP32 sin conexión";

  return (
    <section className="simulator-section" aria-labelledby="simulator-title">
      <div className="whatsapp-connect-card">
        <div className="wa-brand-mark" aria-hidden="true">WA</div>
        <div className="wa-copy">
          <span>Conexión de WhatsApp</span>
          <strong>{whatsapp?.authenticated
            ? `Vinculado como ${HIDDEN_PHONE}`
            : whatsapp?.authRunning ? "Esperando que escanees el QR"
              : "Todavía no está vinculado"}</strong>
          <p>El teléfono vinculado será el remitente de las notas de voz.</p>
        </div>
        {!whatsapp?.authenticated && !whatsapp?.authRunning && (
          <button type="button" onClick={() => void startWhatsappLogin()}>Vincular WhatsApp</button>
        )}
        {whatsapp?.authenticated && <div className="wa-ready"><span /> {whatsapp.syncRunning ? "Enviando y escuchando" : "Iniciando escucha…"}</div>}
      </div>

      {whatsapp?.qrDataUrl && !whatsapp.authenticated && (
        <div className="qr-card">
          <Image src={whatsapp.qrDataUrl} alt="Código QR para vincular WhatsApp" width={260} height={260} unoptimized />
          <div>
            <p className="eyebrow">Escaneá desde el teléfono remitente</p>
            <h2>WhatsApp → Dispositivos vinculados → Vincular dispositivo</h2>
            <p>Este QR se renueva automáticamente. La sesión queda guardada únicamente en esta Mac.</p>
          </div>
        </div>
      )}

      <div className="simulator-heading">
        <div>
          <p className="eyebrow">Panel de prueba</p>
          <h2 id="simulator-title">Así va a funcionar la caja</h2>
        </div>
        <p>Elegí una persona y presioná el botón grande. El EMEET graba, la Mac convierte el audio y wacli lo manda por WhatsApp.</p>
      </div>

      <div className="hardware-panel">
        <div className="panel-screws" aria-hidden="true"><i /><i /><i /><i /></div>

        <div className="main-controls">
          <div className="hardware-action talk-control">
            <span className="panel-label">Mandar</span>
            <button
              className={`hardware-talk-button is-${emeetState}`}
              type="button"
              disabled={!whatsapp?.authenticated || emeetState === "sending"}
              onClick={() => void toggleEmeetRecording()}
              aria-pressed={emeetState === "recording"}
            ><span /></button>
            <strong>{emeetState === "recording" ? `Grabando… ${recordingSeconds} s · tocar para enviar`
              : emeetState === "sending" ? "Enviando por WhatsApp…"
                : emeetState === "sent" ? "¡Mensaje enviado!"
                  : emeetState === "discarded" ? "No se escuchó voz · no se envió"
                  : emeetState === "error" ? "Revisar el error"
                    : whatsapp?.authenticated ? `Hablar con ${selectedRecipient?.label ?? "destinatario"}`
                      : "Vinculá WhatsApp primero"}</strong>
          </div>

          <div className="speaker-zone" aria-label="Parlante EMEET USB">
            <span className="panel-label">Parlante</span>
            <div className="speaker-grille" aria-hidden="true">{Array.from({ length: 21 }, (_, index) => <span key={index} />)}</div>
            <small>EMEET USB</small>
            <div className={`emeet-health is-${deviceHealth}`} role="status" title={deviceStatus?.lastSeenAt ? `Última señal: ${new Date(deviceStatus.lastSeenAt).toLocaleTimeString("es-UY")}` : "Todavía no llegó ninguna señal del ESP32"}>
              <i aria-hidden="true" />
              {deviceHealthLabel}
            </div>
          </div>

          <div className="hardware-action listen-control">
            <span className="panel-label">Recibir</span>
            <button
              className={`hardware-listen-button ${unheardMessages > 0 ? "has-unheard" : ""} ${messagePlaying ? "is-playing" : ""}`}
              type="button"
              disabled={(queuedMessages === 0 && !hasPlayedMessage) || messagePlaying || releasingMessage}
              onClick={() => void listenToNextMessage()}
              aria-label={queuedMessages > 0 ? `Escuchar próximo mensaje. ${queuedMessages} en cola`
                : hasPlayedMessage ? "Volver a escuchar el último mensaje" : "No hay mensajes por escuchar"}
            ><span aria-hidden="true" /></button>
            <strong>{messagePlaying ? "Chapu está reproduciendo…"
              : releasingMessage ? "Preparando audio…"
                : queuedMessages === 1 ? "1 mensaje por escuchar"
                  : queuedMessages > 1 ? `${queuedMessages} mensajes por escuchar`
                    : hasPlayedMessage ? "Sin mensajes nuevos · tocar para repetir el último"
                      : "Sin mensajes nuevos"}</strong>
          </div>
        </div>

        <div className="recipient-zone">
          <span className="panel-label agenda-title">Agenda</span>
          <div className="recipient-buttons">
            {agendaSlots.map((recipient, index) => recipient ? (
              <div className="recipient-slot" key={recipient.id}>
                <button
                  className={`recipient-arcade-button ${recipient.id === settings?.selectedRecipientId ? "is-selected" : ""}`}
                  type="button"
                  onClick={() => void chooseRecipient(recipient.id)}
                  aria-label={`Elegir a ${recipient.label} (botón ${index + 1} de la caja)`}
                  title={`Botón ${index + 1} de la caja`}
                >
                  <i style={{ background: recipient.color }}>{index + 1}</i>
                  <strong>{recipient.label}</strong>
                  <small>{isGroupDestination(recipient.phone) ? "grupo de WhatsApp" : HIDDEN_PHONE}</small>
                </button>
                <button className="edit-recipient-button" type="button" onClick={() => openRecipientEditor(recipient)}>
                  Editar
                </button>
              </div>
            ) : (
              <div className="recipient-slot" key={`empty-${index}`}>
                <button
                  className="add-person-button recipient-arcade-button"
                  type="button"
                  onClick={openNewRecipient}
                  aria-label={`Agregar contacto en posición ${index + 1}`}
                >
                  <i>{index + 1}</i><strong>Agregar</strong><small>{HIDDEN_PHONE}</small>
                </button>
              </div>
            ))}
          </div>
          {showAddRecipient && (
            <form className="recipient-form" onSubmit={(event) => void saveRecipient(event)}>
              <div className="recipient-form-title">{editingRecipientId ? "Editar contacto" : "Nuevo contacto"}</div>
              <input aria-label="Nombre" placeholder="Nombre o label" value={label} onChange={(event) => setLabel(event.target.value)} />
              <div className="destination-kind" role="radiogroup" aria-label="Tipo de destino">
                <button type="button" className={destinationKind === "phone" ? "is-active" : ""} onClick={() => chooseDestinationKind("phone")}>Número</button>
                <button type="button" className={destinationKind === "group" ? "is-active" : ""} onClick={() => chooseDestinationKind("group")}>Grupo</button>
              </div>
              {destinationKind === "phone" ? (
                <div className="phone-editor">
                  <input
                    aria-label="Número internacional"
                    type={showPhone ? "tel" : "password"}
                    autoComplete="off"
                    placeholder="+54911…"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                  <button type="button" onClick={() => setShowPhone((value) => !value)}>{showPhone ? "Ocultar" : "Ver"}</button>
                </div>
              ) : (
                <div className="phone-editor">
                  <select aria-label="Grupo de WhatsApp" value={phone} onChange={(event) => setPhone(event.target.value)}>
                    <option value="">Elegí un grupo…</option>
                    {groups.map((group) => <option key={group.jid} value={group.jid}>{groupLabel(group)}</option>)}
                    {phone && !groups.some((group) => group.jid === phone) && <option value={phone}>Grupo actual</option>}
                  </select>
                  <button type="button" disabled={refreshingGroups} onClick={() => void loadGroups(true)}>{refreshingGroups ? "Buscando…" : "Actualizar"}</button>
                </div>
              )}
              {groupsError && destinationKind === "group" && <p className="name-recorder-hint">{groupsError}</p>}
              <button type="submit">Guardar cambios</button>
              <button className="cancel-add-person" type="button" onClick={closeRecipientEditor}>Cancelar</button>
              {editingRecipient && (
                <div className="slot-mover">
                  <span>Botón de la caja</span>
                  <div className="slot-mover-buttons">
                    {Array.from({ length: 4 }, (_, slot) => {
                      const occupant = settings?.recipients[slot];
                      const isCurrent = occupant?.id === editingRecipient.id;
                      return (
                        <button
                          key={slot}
                          type="button"
                          className={isCurrent ? "is-current" : ""}
                          disabled={isCurrent}
                          title={isCurrent ? "Botón actual" : occupant ? `Intercambiar con ${occupant.label}` : "Mover a este botón"}
                          onClick={() => void moveRecipientToSlot(editingRecipient.id, slot)}
                        >
                          <i>{slot + 1}</i>
                          <small>{isCurrent ? "actual" : occupant ? `↔ ${occupant.label}` : "libre"}</small>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {editingRecipient ? (
                <NameRecorder
                  recipientId={editingRecipient.id}
                  label={editingRecipient.label}
                  nameSource={editingRecipient.nameSource ?? "generated"}
                  onChange={() => void loadSettings()}
                />
              ) : (
                <p className="name-recorder-hint">Guardá el contacto y después grabá cómo lo nombra Chapu.</p>
              )}
            </form>
          )}
        </div>
      </div>

      <EventLog />

      {(panelError || whatsapp?.error || whatsapp?.syncError) && <div className="panel-error">{panelError || whatsapp?.error || whatsapp?.syncError}</div>}
    </section>
  );
}
