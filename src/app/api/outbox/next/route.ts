import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureOutboxDirectories, pendingDirectory, servedDirectory } from "@/lib/outbox";
import { appendEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureOutboxDirectories();
  const entries = await fs.readdir(pendingDirectory, { withFileTypes: true });
  const wavFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".wav"));

  if (wavFiles.length === 0) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  const candidates = await Promise.all(wavFiles.map(async (entry) => {
    const filePath = path.join(pendingDirectory, entry.name);
    const stats = await fs.stat(filePath);
    return { entry, filePath, createdAt: stats.birthtimeMs };
  }));
  candidates.sort((a, b) => a.createdAt - b.createdAt);

  const next = candidates[0];
  const id = next.entry.name.slice(0, -4);
  // The ESP32 names the note it already holds in memory; skip the download.
  const held = request.headers.get("x-held-message") === id;
  const buffer = held ? null : await fs.readFile(next.filePath);
  try {
    await fs.writeFile(path.join(servedDirectory, id), "", { flag: "wx" });
    await appendEvent("device", held
      ? "ESP32 ya tenía el audio en memoria; reproduciendo al instante"
      : "ESP32 descargó el audio; preparando reproducción");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!buffer) {
    return new Response(null, { status: 204, headers: { "X-Message-ID": id, "Cache-Control": "no-store" } });
  }
  return new Response(buffer, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(buffer.length),
      "X-Message-ID": id,
      "Cache-Control": "no-store",
    },
  });
}
