"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Recording = {
  id: string;
  createdAt: string;
  size: number;
  durationMs: number | null;
  url: string;
  recipient: { label: string; phone: string } | null;
  delivery: { status: "sending" | "sent" | "error"; error?: string } | null;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-UY", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null) return "—";
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
}

function formatDeliveryError(message?: string) {
  if (!message) return "";
  if (message.includes("store lock") || message.includes("store is locked")) return "WhatsApp estaba ocupado";
  return message.length > 140 ? "No se pudo completar el envío" : message;
}

export function RecordingsPanel() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [endpoint, setEndpoint] = useState("/api/recordings");
  const [deleting, setDeleting] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadRecordings = useCallback(async () => {
    try {
      const response = await fetch("/api/recordings", { cache: "no-store" });
      if (!response.ok) throw new Error("API unavailable");
      const data = (await response.json()) as { recordings: Recording[] };
      setRecordings(data.recordings);
      setOnline(true);
      return data.recordings;
    } catch {
      setOnline(false);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteAllMessages = async () => {
    if (!window.confirm("¿Borrar todos los mensajes recibidos y enviados?")) return;
    setDeleting(true);
    try {
      const responses = await Promise.all([
        fetch("/api/recordings", { method: "DELETE" }),
        fetch("/api/outbox", { method: "DELETE" }),
      ]);
      if (responses.some((response) => !response.ok)) throw new Error("No se pudieron borrar");
      setRecordings([]);
    } finally {
      setDeleting(false);
    }
  };

  const retrySend = async (id: string) => {
    setRetryingId(id);
    try {
      const response = await fetch(`/api/recordings/${id}`, { method: "POST" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "No se pudo reenviar");
      await loadRecordings();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "No se pudo reenviar");
      await loadRecordings();
    } finally {
      setRetryingId(null);
    }
  };

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      setEndpoint(`${window.location.origin}/api/recordings`);
      void loadRecordings();
    }, 0);
    const interval = window.setInterval(() => void loadRecordings(), 1500);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadRecordings]);

  const totalDuration = useMemo(
    () => recordings.reduce((total, recording) => total + (recording.durationMs ?? 0), 0),
    [recordings],
  );

  return (
    <section className="recordings-section" aria-labelledby="recordings-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Mensajes recibidos</p>
          <h2 id="recordings-title">Grabaciones</h2>
        </div>
        <div className={`receiver-pill ${online ? "is-online" : ""}`}>
          <span aria-hidden="true" />
          {online ? "Receptor listo" : "Reconectando"}
        </div>
      </div>

      <div className="endpoint-card">
        <div className="endpoint-icon" aria-hidden="true">↙</div>
        <div>
          <span>Endpoint del ESP32</span>
          <code>{endpoint}</code>
        </div>
      </div>

      <div className="summary-row">
        <div><strong>{recordings.length}</strong><span>mensajes</span></div>
        <div><strong>{formatDuration(totalDuration)}</strong><span>de voces</span></div>
        <div className="latency-summary" title="Incluye subida y espera del próximo refresco">
          <strong>~1,2 s</strong><span>latencia media después de hablar · rango 0,35–2,15 s</span>
        </div>
        <div className="summary-actions">
          <button type="button" onClick={() => void loadRecordings()}>Actualizar</button>
          <button className="delete-all" type="button" disabled={deleting} onClick={() => void deleteAllMessages()}>
            {deleting ? "Borrando…" : "Borrar todos"}
          </button>
        </div>
      </div>

      <div className="recording-list" aria-live="polite">
        {loading ? (
          <div className="empty-state">Buscando mensajes…</div>
        ) : recordings.length === 0 ? (
          <div className="empty-state">
            <div className="empty-orbit"><span /></div>
            <h3>Todavía no llegó ningún mensaje</h3>
            <p>Cuando el ESP32 envíe su primer WAV, va a aparecer acá.</p>
          </div>
        ) : (
          recordings.map((recording, index) => (
            <article className="recording-card" key={recording.id}>
              <div className="recording-number">{String(index + 1).padStart(2, "0")}</div>
              <div className="recording-info">
                <h3>Mensaje de voz</h3>
                <p>{formatDate(recording.createdAt)} · {formatDuration(recording.durationMs)} · {Math.ceil(recording.size / 1024)} KB</p>
                {recording.recipient && (
                  <p className={`delivery-line is-${recording.delivery?.status ?? "saved"}`}>
                    {recording.delivery?.status === "sent" ? "✓ Enviado"
                      : recording.delivery?.status === "sending" ? "↗ Enviando"
                        : recording.delivery?.status === "error" ? "! Error al enviar"
                          : "Guardado"}
                    {` por WhatsApp a ${recording.recipient.label}`}
                    {recording.delivery?.error ? ` · ${formatDeliveryError(recording.delivery.error)}` : ""}
                  </p>
                )}
              </div>
              <div className="recording-actions">
                <audio controls preload="metadata" src={recording.url}>
                  Tu navegador no puede reproducir este audio.
                </audio>
                {recording.delivery?.status === "error" && (
                  <button
                    className="retry-send"
                    type="button"
                    disabled={retryingId === recording.id}
                    onClick={() => void retrySend(recording.id)}
                  >
                    {retryingId === recording.id ? "Reintentando…" : "Reintentar envío"}
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
