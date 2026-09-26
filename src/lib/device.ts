import { promises as fs } from "node:fs";
import path from "node:path";

export type DeviceHeartbeat = {
  speaker: boolean;
  microphone: boolean;
  recording: boolean;
  playing: boolean;
  // Firmware that spins the roulette itself says so; older firmware leaves it to the web.
  localRoulette?: boolean;
  lastSeenAt: string;
};

export const deviceStatusPath = path.join(process.cwd(), "data", "device", "status.json");
// The ESP32 posts every second; anything older than this means it is gone.
export const DEVICE_ONLINE_WINDOW_MS = 7000;

export async function readDeviceHeartbeat(): Promise<DeviceHeartbeat | null> {
  try {
    return JSON.parse(await fs.readFile(deviceStatusPath, "utf8")) as DeviceHeartbeat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A truncated or half-written file (power cut mid-write) must not take the
    // heartbeat down with it: treat it as "never seen" and let the next write heal it.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeDeviceHeartbeat(heartbeat: DeviceHeartbeat) {
  await fs.mkdir(path.dirname(deviceStatusPath), { recursive: true });
  // Written every second: rename so a crash never leaves an empty file behind.
  const temporaryPath = `${deviceStatusPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(heartbeat), "utf8");
  await fs.rename(temporaryPath, deviceStatusPath);
}

export function heartbeatAgeMs(heartbeat: DeviceHeartbeat | null) {
  if (!heartbeat) return Number.POSITIVE_INFINITY;
  const age = Date.now() - new Date(heartbeat.lastSeenAt).getTime();
  return Number.isFinite(age) ? Math.max(0, age) : Number.POSITIVE_INFINITY;
}

export async function isDeviceOnline() {
  return heartbeatAgeMs(await readDeviceHeartbeat()) <= DEVICE_ONLINE_WINDOW_MS;
}
