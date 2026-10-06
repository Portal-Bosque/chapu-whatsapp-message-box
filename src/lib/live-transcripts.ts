import { promises as fs } from "node:fs";
import path from "node:path";
import { codexAppServer } from "@/lib/codex-app-server";

// Live-mode conversations as text: the bridge writes `<id>.txt` while people
// talk, and a title plus a one-paragraph summary land next to it in `<id>.json`.
export const transcriptsDirectory = path.join(process.cwd(), "data", "live-transcripts");

export type TranscriptLine = { time: string; speaker: string; text: string };
export type LiveConversation = {
  id: string;
  startedAt: string;
  title: string | null;
  summary: string | null;
  lines: TranscriptLine[];
};

const SUMMARY_INSTRUCTIONS = `Te paso la transcripción de una charla entre Chapu, una caja parlante, y uno o más chicos de la casa (Dan, Chloe, Chiara).
Escribí en español rioplatense, para que lo lean los padres:
- title: un título de hasta ocho palabras que diga de qué se habló, sin punto final.
- summary: un párrafo de dos a cuatro oraciones: quién habló si se sabe, qué hicieron o preguntaron y cómo siguió la charla.
Contá solo lo que está en la transcripción. Las líneas "(búsqueda)" son datos que Chapu buscó en internet.
No uses herramientas: ni terminal, ni archivos, ni internet.`;

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, summary: { type: "string" } },
  required: ["title", "summary"],
  additionalProperties: false,
};
const SUMMARY_TIMEOUT_MS = 90_000;

function parseTranscript(content: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\] ([^:]+): (.*)$/);
    if (match) lines.push({ time: match[1], speaker: match[2], text: match[3] });
  }
  return lines;
}

// File names are ISO timestamps with the punctuation swapped for dashes.
function startedAtFromId(id: string) {
  return id.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1T$2:$3:$4.$5Z");
}

const summarizing = new Set<string>();

// Asks Codex for the title and summary of one conversation and stores them.
export async function summarizeTranscript(id: string) {
  if (!/^[\w-]+$/.test(id) || summarizing.has(id)) return;
  summarizing.add(id);
  try {
    const content = await fs.readFile(path.join(transcriptsDirectory, `${id}.txt`), "utf8");
    if (parseTranscript(content).length === 0) return;
    const codex = codexAppServer();
    await codex.ready;
    const cwd = path.join(process.cwd(), "data", "live-codex");
    await fs.mkdir(cwd, { recursive: true });
    const thread = await codex.request("thread/start", {
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      cwd,
      developerInstructions: SUMMARY_INSTRUCTIONS,
      config: { web_search: "disabled" },
    }) as { thread: { id: string } };
    const threadId = thread.thread.id;
    let answer = "";
    const finished = new Promise<void>((resolve, reject) => {
      const off = codex.on((method, params) => {
        if (method === "exit") { off(); reject(new Error("Codex se cerró")); }
        if (params.threadId !== threadId) return;
        const item = params.item as { type?: string; text?: string } | undefined;
        if (method === "item/completed" && item?.type === "agentMessage" && item.text) answer = item.text;
        if (method === "turn/completed") { off(); resolve(); }
      });
      setTimeout(() => { off(); reject(new Error("el resumen tardó demasiado")); }, SUMMARY_TIMEOUT_MS);
    });
    await codex.request("turn/start", {
      threadId, effort: "low", outputSchema: SUMMARY_SCHEMA, input: [{ type: "text", text: content.slice(-20_000) }],
    });
    await finished;
    const parsed = JSON.parse(answer) as { title?: unknown; summary?: unknown };
    if (typeof parsed.title !== "string" || typeof parsed.summary !== "string") return;
    await fs.writeFile(path.join(transcriptsDirectory, `${id}.json`),
      JSON.stringify({ title: parsed.title.trim(), summary: parsed.summary.trim() }), "utf8");
  } catch {
    // Left without a summary; listing the conversations tries again.
  } finally {
    summarizing.delete(id);
  }
}

export async function listConversations(limit = 30): Promise<LiveConversation[]> {
  let names: string[];
  try {
    names = await fs.readdir(transcriptsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids = names.filter((name) => name.endsWith(".txt")).map((name) => name.slice(0, -4)).sort().reverse().slice(0, limit);
  const conversations = await Promise.all(ids.map(async (id) => {
    const lines = parseTranscript(await fs.readFile(path.join(transcriptsDirectory, `${id}.txt`), "utf8"));
    let title: string | null = null;
    let summary: string | null = null;
    try {
      const saved = JSON.parse(await fs.readFile(path.join(transcriptsDirectory, `${id}.json`), "utf8")) as { title?: string; summary?: string };
      title = saved.title ?? null;
      summary = saved.summary ?? null;
    } catch {
      // Not summarized yet. Skip the one being written right now: its file is younger than a minute.
      const { mtimeMs } = await fs.stat(path.join(transcriptsDirectory, `${id}.txt`));
      if (lines.length > 0 && Date.now() - mtimeMs > 60_000) void summarizeTranscript(id);
    }
    return { id, startedAt: startedAtFromId(id), title, summary, lines };
  }));
  return conversations.filter((conversation) => conversation.lines.length > 0);
}
