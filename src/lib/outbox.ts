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

// With nothing new waiting, the listen button replays one of the last few
// notes heard, picked at random. The pick is made ahead of the press and kept
// on disk so the ESP32 prefetches the same note the release then hands out.
const REPLAY_POOL_SIZE = 5;
const replayStatePath = path.join(outboxDirectory, "replay.json");

type ReplayState = { pick?: string; lastReleased?: string };

async function readReplayState(): Promise<ReplayState> {
  return fs.readFile(replayStatePath, "utf8")
    .then((value) => JSON.parse(value) as ReplayState)
    .catch(() => ({}));
}

async function writeReplayState(state: ReplayState) {
  const temporaryPath = `${replayStatePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(state));
  await fs.rename(temporaryPath, replayStatePath);
}

/**
 * The note a press replays when the queue is empty: a random one of the last
 * five heard, never the one that just played unless it is the only one.
 */
export async function replayPick() {
  const pool = (await listOutboxMessages())
    .filter((message) => message.status === "played" && message.id.startsWith("wa_"))
    .slice(0, REPLAY_POOL_SIZE) // newest first
    .map((message) => message.id);
  if (pool.length === 0) return null;
  const state = await readReplayState();
  if (state.pick && pool.includes(state.pick)) return state.pick;
  const fresh = pool.filter((id) => id !== state.lastReleased);
  const candidates = fresh.length > 0 ? fresh : pool;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  await writeReplayState({ ...state, pick });
  return pick;
}

/** Records the note handed to Chapu so the next random pick is a different one. */
export async function noteReleased(id: string) {
  await writeReplayState({ lastReleased: id });
}

/**
 * The WhatsApp note the listen button would play next: the oldest queued one,
 * or the random replay pick when nothing new is waiting. The ESP32 downloads
 * it ahead of time so a press starts playing at once.
 */
export async function nextMessageForDevice() {
  const notes = (await listOutboxMessages())
    .filter((message) => message.id.startsWith("wa_"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const queued = notes.find((message) => message.status === "queued");
  if (queued) return queued.id;
  // While a note is on the speaker keep naming it, so the ESP32 does not start
  // another download mid-playback; the next pick is named once it ends.
  const pending = notes.find((message) => message.status === "pending");
  if (pending) return pending.id;
  return replayPick();
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
