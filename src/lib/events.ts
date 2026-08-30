import { promises as fs } from "node:fs";
import path from "node:path";

export type MessageBoxEvent = {
  id: string;
  at: string;
  stage: "device" | "recording" | "conversion" | "whatsapp" | "error";
  message: string;
};

const eventLogPath = path.join(process.cwd(), "data", "events.jsonl");

export async function appendEvent(stage: MessageBoxEvent["stage"], message: string) {
  await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
  const event: MessageBoxEvent = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    stage,
    message,
  };
  await fs.appendFile(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function readEvents(limit = 40) {
  try {
    const content = await fs.readFile(eventLogPath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map((line) => JSON.parse(line) as MessageBoxEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function clearEvents() {
  await fs.rm(eventLogPath, { force: true });
}
