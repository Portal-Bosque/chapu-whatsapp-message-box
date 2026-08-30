"use client";

import { useCallback, useEffect, useState } from "react";

type MessageBoxEvent = {
  id: string;
  at: string;
  stage: "device" | "recording" | "conversion" | "whatsapp" | "error";
  message: string;
};

const stageLabels: Record<MessageBoxEvent["stage"], string> = {
  device: "ESP32",
  recording: "AUDIO",
  conversion: "FFMPEG",
  whatsapp: "WHATSAPP",
  error: "ERROR",
};

function formatEventTime(value: string) {
  const date = new Date(value);
  const time = date.toLocaleTimeString("es-UY", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${time}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatDelta(milliseconds: number) {
  if (milliseconds < 1000) return `+${milliseconds} ms`;
  return `+${(milliseconds / 1000).toFixed(2)} s`;
}

function hidePhoneNumbers(message: string) {
  return message.replace(/\+?\d[\d\s().-]{7,}\d/g, "••• ••• •••…");
}

export function EventLog() {
  const [events, setEvents] = useState<MessageBoxEvent[]>([]);

  const loadEvents = useCallback(async () => {
    const response = await fetch("/api/events", { cache: "no-store" });
    if (response.ok) setEvents(((await response.json()) as { events: MessageBoxEvent[] }).events);
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadEvents(), 0);
    const interval = window.setInterval(() => void loadEvents(), 750);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadEvents]);

  const clear = async () => {
    await fetch("/api/events", { method: "DELETE" });
    setEvents([]);
  };

  return (
    <section className="event-log" aria-labelledby="event-log-title">
      <div className="event-log-heading">
        <div>
          <p className="eyebrow">Diagnóstico en vivo</p>
          <h3 id="event-log-title">Qué está pasando</h3>
        </div>
        <button type="button" onClick={() => void clear()}>Limpiar</button>
      </div>
      <div className="event-log-list" aria-live="polite">
        {events.length === 0 ? <p className="event-log-empty">Esperando una acción…</p> : events.map((event, index) => {
          const previous = events[index + 1];
          const delta = previous ? new Date(event.at).getTime() - new Date(previous.at).getTime() : null;
          return (
          <div className={`event-row is-${event.stage}`} key={event.id}>
            <time>{formatEventTime(event.at)}</time>
            <span>{stageLabels[event.stage]}</span>
            <small>{delta === null ? "—" : formatDelta(delta)}</small>
            <p>{hidePhoneNumbers(event.message)}</p>
          </div>
          );
        })}
      </div>
    </section>
  );
}
