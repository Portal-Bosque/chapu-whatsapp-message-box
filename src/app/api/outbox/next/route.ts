import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureOutboxDirectories, pendingDirectory, servedDirectory } from "@/lib/outbox";
import { appendEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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
  const buffer = await fs.readFile(next.filePath);
  try {
    await fs.writeFile(path.join(servedDirectory, id), "", { flag: "wx" });
    await appendEvent("device", "ESP32 descargó el audio; preparando reproducción");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
