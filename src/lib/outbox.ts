import { promises as fs } from "node:fs";
import path from "node:path";
import { availableJokes, isJokeId, jokePath } from "@/lib/jokes";

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

// With nothing new waiting, the listen button replays a random note from
// yesterday or today, padded with invented funny messages when those days were
// quiet. The pick is made ahead of the press and kept on disk so the ESP32
// prefetches the same note the release then hands out.
const REPLAY_MIN_POOL = 5;
const replayStatePath = path.join(outboxDirectory, "replay.json");

// `playlist` is the rewind the held listen button starts: the notes of
// yesterday and today, newest first, handed out one per press.
type ReplayState = { pick?: string; lastReleased?: string; playlist?: string[]; playlistAt?: number };
// A rewind nobody continues is forgotten, so a press hours later starts fresh.
const PLAYLIST_IDLE_MS = 15 * 60 * 1000;

/** Notes and invented messages both go through the listen button. */
export function isListenable(id: string) {
  return id.startsWith("wa_") || isJokeId(id);
}

function startOfYesterday() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1);
  return day.getTime();
}

async function replayPool() {
  const since = startOfYesterday();
  const pool = (await listOutboxMessages())
    .filter((message) => message.status === "played" && message.id.startsWith("wa_")
      && Date.parse(message.createdAt) >= since)
    .map((message) => message.id);
  if (pool.length >= REPLAY_MIN_POOL) return pool;
  // Rotate which invented messages fill the gap so each day sounds different.
  const jokes = await availableJokes();
  const offset = jokes.length > 0 ? Math.floor(Date.now() / 86400000) % jokes.length : 0;
  const rotated = [...jokes.slice(offset), ...jokes.slice(0, offset)];
  return [...pool, ...rotated.slice(0, REPLAY_MIN_POOL - pool.length)];
}

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
 * The note a press replays when the queue is empty, never the one that just
 * played unless it is the only one.
 */
export async function replayPick() {
  const pool = await replayPool();
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
  const { playlist, playlistAt } = await readReplayState();
  await writeReplayState({ lastReleased: id, ...(playlist?.length ? { playlist, playlistAt } : {}) });
}

/** Starts over from the newest note of yesterday and today, heard or not. */
export async function startRewind() {
  const since = startOfYesterday();
  const playlist = (await listOutboxMessages())
    .filter((message) => message.id.startsWith("wa_") && message.status !== "pending"
      && Date.parse(message.createdAt) >= since)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((message) => message.id);
  await writeReplayState({ ...(await readReplayState()), playlist, playlistAt: Date.now() });
  return playlist.length;
}

/** The next note of a rewind in progress and the folder it waits in, or null. */
export async function rewindHead() {
  const state = await readReplayState();
  if (!state.playlist?.length || Date.now() - (state.playlistAt ?? 0) > PLAYLIST_IDLE_MS) return null;
  for (const id of state.playlist) {
    for (const directory of [queuedDirectory, playedDirectory]) {
      try {
        await fs.access(path.join(directory, `${id}.wav`));
        return { id, directory };
      } catch {
        // Not in this folder.
      }
    }
  }
  return null;
}

/** Drops a note (and any that vanished before it) from the rewind once it is handed out. */
export async function advanceRewind(id: string) {
  const state = await readReplayState();
  const index = state.playlist?.indexOf(id) ?? -1;
  if (index < 0) return;
  await writeReplayState({ ...state, playlist: state.playlist!.slice(index + 1), playlistAt: Date.now() });
}

/**
 * The WhatsApp note the listen button would play next: the oldest queued one,
 * or the random replay pick when nothing new is waiting. The ESP32 downloads
 * it ahead of time so a press starts playing at once.
 */
export async function nextMessageForDevice() {
  const rewinding = await rewindHead();
  if (rewinding) return rewinding.id;
  const notes = (await listOutboxMessages())
    .filter((message) => isListenable(message.id))
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
  const candidates = isJokeId(id)
    ? [path.join(pendingDirectory, `${id}.wav`), jokePath(id)]
    : [queuedDirectory, pendingDirectory, playedDirectory].map((directory) => path.join(directory, `${id}.wav`));
  for (const filePath of candidates) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Not here; try the next stage.
    }
  }
  return null;
}
