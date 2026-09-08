import { promises as fs } from "node:fs";
import path from "node:path";

export const outboxDirectory = path.join(process.cwd(), "data", "outbox");
export const queuedDirectory = path.join(outboxDirectory, "queued");
export const pendingDirectory = path.join(outboxDirectory, "pending");
export const playedDirectory = path.join(outboxDirectory, "played");
export const servedDirectory = path.join(outboxDirectory, "served");

export async function ensureOutboxDirectories() {
  await Promise.all([
    fs.mkdir(queuedDirectory, { recursive: true }),
    fs.mkdir(pendingDirectory, { recursive: true }),
    fs.mkdir(playedDirectory, { recursive: true }),
    fs.mkdir(servedDirectory, { recursive: true }),
  ]);
}

export function safeOutboxId(id: string) {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function listOutboxMessages() {
  await ensureOutboxDirectories();

  const readDirectory = async (directory: string, status: "queued" | "pending" | "played") => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".wav"))
        .map(async (entry) => {
          const id = entry.name.slice(0, -4);
          const stats = await fs.stat(path.join(directory, entry.name));
          return {
            id,
            status,
            createdAt: stats.birthtime.toISOString(),
            updatedAt: stats.mtime.toISOString(),
            size: stats.size,
          };
        }),
    );
  };

  const [queued, pending, played] = await Promise.all([
    readDirectory(queuedDirectory, "queued"),
    readDirectory(pendingDirectory, "pending"),
    readDirectory(playedDirectory, "played"),
  ]);

  return [...queued, ...pending, ...played].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The WhatsApp note the listen button would play next: the oldest queued one,
 * or the last one heard when nothing new is waiting (the button replays it).
 * The ESP32 downloads it ahead of time so a press starts playing at once.
 */
export async function nextMessageForDevice() {
  const notes = (await listOutboxMessages())
    .filter((message) => message.id.startsWith("wa_"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const queued = notes.find((message) => message.status === "queued");
  if (queued) return queued.id;
  // The note on the speaker becomes the replay target the moment it ends, so
  // naming it now lets the ESP32 keep it instead of re-downloading it.
  const pending = notes.find((message) => message.status === "pending");
  if (pending) return pending.id;
  const played = notes.filter((message) => message.status === "played");
  return played.length > 0 ? played[played.length - 1].id : null;
}

export async function findOutboxWave(id: string) {
  for (const directory of [queuedDirectory, pendingDirectory, playedDirectory]) {
    const filePath = path.join(directory, `${id}.wav`);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Not here; try the next stage.
    }
  }
  return null;
}
