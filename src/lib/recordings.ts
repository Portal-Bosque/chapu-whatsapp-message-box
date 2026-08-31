import { promises as fs } from "node:fs";
import path from "node:path";

export const recordingsDirectory = path.join(process.cwd(), "data", "recordings");
const latestAudioResultPath = path.join(process.cwd(), "data", "device", "latest-audio-result.json");

export type LatestAudioResult = {
  id: string;
  processedAt: string;
  discarded: boolean;
  reason: string;
  metrics: {
    durationMs: number;
    rmsDbfs: number;
    peakDbfs: number;
    activeMs: number;
    activeRatio: number;
  } | null;
};

export async function ensureRecordingsDirectory() {
  await fs.mkdir(recordingsDirectory, { recursive: true });
}

export async function writeLatestAudioResult(result: LatestAudioResult) {
  await fs.mkdir(path.dirname(latestAudioResultPath), { recursive: true });
  await fs.writeFile(latestAudioResultPath, JSON.stringify(result, null, 2));
}

export async function readLatestAudioResult(): Promise<LatestAudioResult | null> {
  try {
    return JSON.parse(await fs.readFile(latestAudioResultPath, "utf8")) as LatestAudioResult;
  } catch {
    return null;
  }
}

export function isWave(buffer: Buffer) {
  return buffer.length >= 44
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WAVE";
}

export function wavDurationMs(buffer: Buffer): number | null {
  if (!isWave(buffer)) return null;

  let offset = 12;
  let bytesPerSecond: number | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkName = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > buffer.length) break;

    if (chunkName === "fmt " && chunkSize >= 16) {
      bytesPerSecond = buffer.readUInt32LE(chunkStart + 8);
    } else if (chunkName === "data") {
      dataBytes = chunkSize;
    }

    if (bytesPerSecond !== null && dataBytes !== null) break;
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!bytesPerSecond || dataBytes === null) return null;
  return Math.round((dataBytes / bytesPerSecond) * 1000);
}

export function safeRecordingId(id: string) {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
