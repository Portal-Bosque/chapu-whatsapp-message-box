import { RecordingsPanel } from "@/components/recordings-panel";
import { FamilyPanel } from "@/components/family-panel";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Message Box, inicio">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>Chapu</span>
        </a>
        <div className="server-status">
          <span className="status-dot" aria-hidden="true" />
          Servidor local
        </div>
      </header>

      <section className="hero simulator-hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Chapu · laboratorio local</p>
          <h1>Una caja para mandar voces por WhatsApp.</h1>
          <p className="hero-description">
            Esta pantalla simula los botones físicos: elegís a quién, grabás con
            el EMEET y el mensaje sale desde el número vinculado.
          </p>
        </div>
      </section>

      <FamilyPanel />

      <RecordingsPanel />

      <footer>
        <span>Chapu</span>
        <span>Hecho en casa · ESP32-S3 + EMEET</span>
      </footer>
    </main>
  );
}
