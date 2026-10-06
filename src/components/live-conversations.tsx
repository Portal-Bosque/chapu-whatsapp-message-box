"use client";

import { useCallback, useEffect, useState } from "react";

type TranscriptLine = { time: string; speaker: string; text: string };
type LiveConversation = {
  id: string;
  startedAt: string;
  title: string | null;
  summary: string | null;
  lines: TranscriptLine[];
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-AR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function LiveConversations() {
  const [conversations, setConversations] = useState<LiveConversation[]>([]);
  const [loading, setLoading] = useState(true);

  const loadConversations = useCallback(async () => {
    try {
      const response = await fetch("/api/live/conversations", { cache: "no-store" });
      if (response.ok) setConversations(((await response.json()) as { conversations: LiveConversation[] }).conversations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadConversations(), 0);
    const interval = window.setInterval(() => void loadConversations(), 10_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadConversations]);

  return (
    <section className="conversations-section" aria-labelledby="conversations-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Modo charla</p>
          <h2 id="conversations-title">Charlas con Chapu</h2>
        </div>
      </div>

      <div className="conversation-list" aria-live="polite">
        {loading ? (
          <p className="conversation-empty">Buscando charlas…</p>
        ) : conversations.length === 0 ? (
          <p className="conversation-empty">Todavía no hay charlas. Empiezan al mantener apretado el botón rojo de mandar.</p>
        ) : conversations.map((conversation) => (
          <article className="conversation-card" key={conversation.id}>
            <p className="conversation-date">{formatDate(conversation.startedAt)}</p>
            <h3>{conversation.title ?? "Charla sin resumir todavía"}</h3>
            <p className="conversation-summary">{conversation.summary ?? "El resumen aparece un ratito después de que termina la charla."}</p>
            <details>
              <summary>Ver la charla completa ({conversation.lines.length} {conversation.lines.length === 1 ? "línea" : "líneas"})</summary>
              <ol className="conversation-lines">
                {conversation.lines.map((line, index) => (
                  <li className={line.speaker === "Chapu" ? "is-chapu" : line.speaker === "Chico" ? "is-child" : "is-lookup"} key={index}>
                    <time>{line.time}</time>
                    <strong>{line.speaker}</strong>
                    <span>{line.text}</span>
                  </li>
                ))}
              </ol>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}
