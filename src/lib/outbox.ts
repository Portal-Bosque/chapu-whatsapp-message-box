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
