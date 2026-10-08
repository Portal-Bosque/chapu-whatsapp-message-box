import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

// Client for `codex app-server`, the Codex CLI's JSON-RPC interface. Everything
// that goes through it runs on the ChatGPT subscription the CLI is logged in with.
type RpcMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
type RpcListener = (method: string, params: Record<string, unknown>) => void;

// One app-server for every conversation, started on first use and replaced if it dies.
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<RpcListener>();
  alive = true;
  ready: Promise<void>;

  constructor() {
    this.child = spawn(process.env.CODEX_BIN || "codex",
      ["app-server", "--listen", "stdio://", "-c", "features.realtime_conversation=true", "-c", "suppress_unstable_features_warning=true"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: SEARCH_PATH } });
    this.child.stderr.resume();
    this.child.on("error", () => this.died());
    this.child.on("exit", () => this.died());
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "error de Codex"));
        else waiter.resolve(message.result);
      } else if (message.method) {
        this.listeners.forEach((listener) => listener(message.method!, message.params ?? {}));
      }
    });
    this.ready = this.request("initialize", {
      clientInfo: { name: "chapu", title: "Chapu", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    });
    this.ready.catch(() => undefined);
  }

  private died() {
    if (!this.alive) return;
    this.alive = false;
    this.pending.forEach((waiter) => waiter.reject(new Error("Codex se cerró")));
    this.pending.clear();
    this.listeners.forEach((listener) => listener("exit", {}));
  }

  stop() {
    this.child.kill();
    this.died();
  }

  request(method: string, params: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.alive) {
        reject(new Error("Codex no está corriendo"));
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Codex no respondió a ${method}`));
      }, 30_000);
    });
  }

  on(listener: RpcListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const SEARCH_PATH = `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;

// Where the `codex` command points right now. An upgrade moves it, and an
// app-server left running from the old install loses its helpers: its web
// search stops working with nothing in the protocol saying so.
function installedCodex() {
  const command = process.env.CODEX_BIN || "codex";
  const candidates = command.includes("/") ? [command] : SEARCH_PATH.split(":").filter(Boolean).map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

const codexState = globalThis as typeof globalThis & { chapuCodex?: CodexAppServer; chapuCodexBinary?: string | null };

// `fresh` is for callers about to start something new: they get an app-server
// from the current install, even if that means replacing the running one.
export function codexAppServer(fresh = false) {
  const binary = installedCodex();
  if (fresh && codexState.chapuCodex?.alive && binary !== codexState.chapuCodexBinary) codexState.chapuCodex.stop();
  if (!codexState.chapuCodex?.alive) {
    codexState.chapuCodex = new CodexAppServer();
    codexState.chapuCodexBinary = binary;
  }
  return codexState.chapuCodex;
}
