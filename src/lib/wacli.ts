import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { appendEvent } from "@/lib/events";

const execFileAsync = promisify(execFile);
export const wacliStoreDirectory = path.join(process.cwd(), "data", "wacli");
const temporaryAudioDirectory = path.join(process.cwd(), "data", "whatsapp-temp");

type AuthRuntime = {
  process: ChildProcess | null;
  syncProcess: ChildProcess | null;
  syncError: string | null;
  syncStderrBuffer: string;
  qr: string | null;
  error: string | null;
  stdoutBuffer: string;
  stderrBuffer: string;
};

const globalRuntime = globalThis as typeof globalThis & { __messageBoxWacli?: AuthRuntime };
const authRuntime = globalRuntime.__messageBoxWacli ?? {
  process: null,
  syncProcess: null,
  syncError: null,
  syncStderrBuffer: "",
  qr: null,
  error: null,
  stdoutBuffer: "",
  stderrBuffer: "",
};
authRuntime.syncProcess ??= null;
authRuntime.syncError ??= null;
authRuntime.syncStderrBuffer ??= "";
globalRuntime.__messageBoxWacli = authRuntime;

export type WacliAuthStatus = {
  installed: boolean;
  authenticated: boolean;
  phone?: string;
  linkedJid?: string;
  authRunning: boolean;
  qr: string | null;
  error: string | null;
  syncRunning: boolean;
  syncError: string | null;
};

async function stopAuthProcess() {
  const child = authRuntime.process;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (authRuntime.process === child) authRuntime.process = null;
    return;
  }

  authRuntime.process = null;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function getWacliAuthStatus(): Promise<WacliAuthStatus> {
  await fs.mkdir(wacliStoreDirectory, { recursive: true });
  try {
    const { stdout } = await execFileAsync("wacli", [
      "--store", wacliStoreDirectory,
      "--read-only",
      "--json",
      "auth", "status",
    ], { timeout: 5000 });
    const envelope = JSON.parse(stdout) as {
      data?: { authenticated?: boolean; phone?: string; linked_jid?: string };
    };
    const authenticated = Boolean(envelope.data?.authenticated);
    if (authenticated) {
      authRuntime.qr = null;
      await stopAuthProcess();
      authRuntime.error = null;
    }
    return {
      installed: true,
      authenticated,
      phone: envelope.data?.phone,
      linkedJid: envelope.data?.linked_jid,
      authRunning: authRuntime.process !== null,
      qr: authRuntime.qr,
      error: authRuntime.error,
      syncRunning: authRuntime.syncProcess !== null,
      syncError: authRuntime.syncError,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return {
      installed: nodeError.code !== "ENOENT",
      authenticated: false,
      authRunning: authRuntime.process !== null,
      qr: authRuntime.qr,
      error: authRuntime.error ?? (nodeError.code === "ENOENT" ? "wacli no está instalado" : nodeError.message),
      syncRunning: authRuntime.syncProcess !== null,
      syncError: authRuntime.syncError,
    };
  }
}

export async function ensureWacliSync(webhookOrigin: string) {
  if (authRuntime.syncProcess) return;
  const status = await getWacliAuthStatus();
  if (!status.authenticated) return;

  const localOrigin = new URL(webhookOrigin);
  localOrigin.hostname = "127.0.0.1";
  const webhookUrl = new URL("/api/whatsapp/incoming", localOrigin).toString();
  authRuntime.syncError = null;
  authRuntime.syncStderrBuffer = "";
  const child = spawn("wacli", [
    "--store", wacliStoreDirectory,
    "--events",
    "sync",
    "--follow",
    "--download-media",
    "--presence-mode", "quiet",
    "--max-db-size", "500MB",
    "--max-reconnect", "0",
    "--webhook", webhookUrl,
    "--webhook-allow-private",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  authRuntime.syncProcess = child;
  await appendEvent("whatsapp", "Escucha de mensajes entrantes iniciada");

  child.stderr?.on("data", (chunk: Buffer) => {
    authRuntime.syncStderrBuffer += chunk.toString("utf8");
    const lines = authRuntime.syncStderrBuffer.split(/\r?\n/);
    authRuntime.syncStderrBuffer = lines.pop() ?? "";
    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      try {
        const event = JSON.parse(line) as { event?: string; data?: { message?: string } };
        if (event.event === "connected") void appendEvent("whatsapp", "wacli conectado y escuchando mensajes nuevos");
        if (event.event === "logged_out") void appendEvent("error", "WhatsApp desvinculó la sesión de wacli");
        if (event.event === "error" && event.data?.message) void appendEvent("error", `Sync de WhatsApp: ${event.data.message}`);
      } catch {
        // Ignore human-readable diagnostics while NDJSON events are enabled.
      }
    }
  });
  child.on("error", (error) => {
    if (authRuntime.syncProcess === child) {
      authRuntime.syncError = error.message;
      authRuntime.syncProcess = null;
      void appendEvent("error", `No se pudo iniciar el sync de WhatsApp: ${error.message}`);
    }
  });
  child.on("exit", (code) => {
    if (authRuntime.syncProcess === child) {
      authRuntime.syncProcess = null;
      if (code) {
        authRuntime.syncError = `wacli sync terminó con código ${code}`;
        void appendEvent("error", authRuntime.syncError);
      }
    }
  });
}

function consumeLines(kind: "stdout" | "stderr", chunk: Buffer) {
  const key = kind === "stdout" ? "stdoutBuffer" : "stderrBuffer";
  authRuntime[key] += chunk.toString("utf8");
  const lines = authRuntime[key].split(/\r?\n/);
  authRuntime[key] = lines.pop() ?? "";
  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    if (kind === "stdout" && line.startsWith("2@")) {
      authRuntime.qr = line;
      authRuntime.error = null;
    } else if (kind === "stderr" && line.startsWith("{")) {
      try {
        const event = JSON.parse(line) as { event?: string; data?: { code?: string; message?: string } };
        if (event.event === "qr_code" && event.data?.code) authRuntime.qr = event.data.code;
        if (event.event === "error" && event.data?.message) authRuntime.error = event.data.message;
      } catch {
        // Ignore non-event diagnostic lines.
      }
    }
  }
}

export async function startWacliAuth() {
  const current = await getWacliAuthStatus();
  if (current.authenticated || authRuntime.process) return current;

  authRuntime.qr = null;
  authRuntime.error = null;
  authRuntime.stdoutBuffer = "";
  authRuntime.stderrBuffer = "";
  const child = spawn("wacli", [
    "--store", wacliStoreDirectory,
    "--events",
    "auth",
    "--qr-format", "text",
    "--idle-exit", "5s",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  authRuntime.process = child;
  child.stdout?.on("data", (chunk: Buffer) => consumeLines("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => consumeLines("stderr", chunk));
  child.on("error", (error) => {
    if (authRuntime.process === child) {
      authRuntime.error = error.message;
      authRuntime.process = null;
    }
  });
  child.on("exit", (code) => {
    if (authRuntime.process === child) {
      if (code && !authRuntime.error) authRuntime.error = `wacli terminó con código ${code}`;
      authRuntime.process = null;
    }
  });
  return getWacliAuthStatus();
}

export async function logoutWacli() {
  authRuntime.syncProcess?.kill("SIGTERM");
  authRuntime.syncProcess = null;
  authRuntime.process?.kill("SIGTERM");
  authRuntime.process = null;
  authRuntime.qr = null;
  await execFileAsync("wacli", ["--store", wacliStoreDirectory, "auth", "logout"], { timeout: 15000 });
}

export async function sendVoiceMessage(wavPath: string, recipient: string, id: string) {
  const deliveryStartedAt = performance.now();
  const authenticationStartedAt = performance.now();
  await appendEvent("whatsapp", "Verificando la sesión de wacli");
  const status = await getWacliAuthStatus();
  if (!status.authenticated) throw new Error("WhatsApp no está vinculado");
  await appendEvent("whatsapp", `Sesión de wacli lista (${Math.round(performance.now() - authenticationStartedAt)} ms)`);

  await fs.mkdir(temporaryAudioDirectory, { recursive: true });
  const opusPath = path.join(temporaryAudioDirectory, `${id}.ogg`);
  try {
    const conversionStartedAt = performance.now();
    await appendEvent("conversion", "Convirtiendo WAV a OGG/Opus para WhatsApp…");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", wavPath,
      "-vn", "-ar", "16000", "-ac", "1",
      "-c:a", "libopus", "-b:a", "24k", "-application", "voip",
      opusPath,
    ], { timeout: 15000 });
    await appendEvent("conversion", `Conversión a Opus terminada (${Math.round(performance.now() - conversionStartedAt)} ms)`);

    const delegateSocket = path.join(wacliStoreDirectory, ".send.sock");
    const delegated = await fs.stat(delegateSocket).then((stats) => stats.isSocket()).catch(() => false);
    await appendEvent("whatsapp", delegated
      ? "Canal rápido con wacli disponible; delegando el envío"
      : "Canal delegado no disponible; wacli abrirá una conexión directa");
    const sendStartedAt = performance.now();
    const { stdout } = await execFileAsync("wacli", [
      "--store", wacliStoreDirectory,
      "--json",
      // sync --follow owns the store lock. A zero wait makes the send command
      // delegate immediately through .send.sock instead of waiting 20 seconds.
      "--lock-wait", "0s",
      "send", "voice",
      "--to", recipient,
      "--file", opusPath,
      "--post-send-wait", "2s",
    ], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const sendElapsed = performance.now() - sendStartedAt;
    const totalElapsed = performance.now() - deliveryStartedAt;
    await appendEvent("whatsapp", `WhatsApp aceptó la nota (${(sendElapsed / 1000).toFixed(2)} s en wacli · ${(totalElapsed / 1000).toFixed(2)} s total)`);
    return JSON.parse(stdout) as unknown;
  } finally {
    await fs.rm(opusPath, { force: true });
  }
}
