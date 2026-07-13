import { invoke } from "@tauri-apps/api/core";
import { native } from "./native";
import { assertLoopbackUrl, resolveParakeetTranscriptionEndpoint } from "./stt";
import { createProxyFetch } from "./proxyFetch";

// First start may download the model from HuggingFace (~600 MB).
const START_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_500;
const PROBE_TIMEOUT_MS = 5_000;

export type ResolvedParakeetServer = { baseURL: string; command: string };

let startPromise: Promise<ResolvedParakeetServer> | null = null;
let bgHandle: number | null = null;

const probeFetch = createProxyFetch({ allowPrivateNetwork: true });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ProbeResult = "ready" | "occupied" | "down";

// GET on a POST-only route: an actual Parakeet-compatible server answers
// with something other than 404 (typically 405 Method Not Allowed), while an
// unrelated local server squatting on the same port 404s a path it has never
// heard of. Routed through the Rust proxy since local servers rarely send
// CORS headers.
async function probe(baseURL: string): Promise<ProbeResult> {
  const endpoint = resolveParakeetTranscriptionEndpoint(baseURL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await probeFetch(endpoint, {
      method: "GET",
      signal: controller.signal,
    });
    return res.status === 404 ? "occupied" : "ready";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

function logTail(bytes: string, max = 400): string {
  const t = bytes.trim();
  return t.length > max ? t.slice(-max) : t;
}

function rewriteCommandPort(command: string, port: number): string | null {
  if (!/--port[=\s]+\d+/.test(command)) return null;
  return command.replace(/(--port[=\s]+)\d+/, `$1${port}`);
}

async function startServer(baseURL: string, command: string): Promise<void> {
  if (bgHandle !== null) {
    await native.shellBgKill(bgHandle).catch(() => {});
    bgHandle = null;
  }
  const handle = await native.shellBgSpawn(command, null);
  bgHandle = handle;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if ((await probe(baseURL)) === "ready") return;
    const logs = await native.shellBgLogs(handle, 0).catch(() => null);
    if (logs?.exited) {
      bgHandle = null;
      throw new Error(
        `Parakeet server exited (code ${logs.exit_code ?? "?"}): ${
          logTail(logs.bytes) || "no output"
        }`,
      );
    }
  }
  throw new Error(
    "Parakeet server did not become ready in time. Check the server command in Settings.",
  );
}

/**
 * Make sure a Parakeet server answers at baseURL, spawning the configured
 * command as a managed background process if needed. Concurrent callers share
 * one startup; a server that died since the last call is restarted.
 *
 * If baseURL's port is already held by an unrelated local server (common —
 * people run all sorts of things on 127.0.0.1), picks a free port instead and
 * starts the managed server there. Callers must use the returned baseURL for
 * the actual transcription request and should persist it back to settings.
 */
export async function ensureParakeetServer(
  baseURL: string,
  command: string,
  onStarting?: () => void,
): Promise<ResolvedParakeetServer> {
  assertLoopbackUrl(baseURL, "Parakeet");
  const status = await probe(baseURL);
  if (status === "ready") return { baseURL, command };

  if (startPromise) {
    const prev = await startPromise.catch(() => null);
    if (prev && (await probe(prev.baseURL)) === "ready") return prev;
    startPromise = null;
  }

  let targetURL = baseURL;
  let targetCommand = command;
  if (status === "occupied") {
    const url = new URL(baseURL);
    const currentPort = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    const freePort = await invoke<number>("find_free_port", {
      preferred: currentPort,
    });
    const rewritten = rewriteCommandPort(command, freePort);
    if (!rewritten) {
      throw new Error(
        `Port ${currentPort} is already in use by another application, and the Parakeet server command has no --port flag Terax can adjust. Add "--port ${freePort}" to the command in Settings, or free up port ${currentPort}.`,
      );
    }
    url.port = String(freePort);
    targetURL = url.toString().replace(/\/+$/, "");
    targetCommand = rewritten;
  }

  const cmd = targetCommand.trim();
  if (!cmd) {
    throw new Error(
      "Parakeet server is not running and no start command is configured in Settings.",
    );
  }
  onStarting?.();
  startPromise = startServer(targetURL, cmd).then(() => ({
    baseURL: targetURL,
    command: targetCommand,
  }));
  try {
    return await startPromise;
  } catch (e) {
    startPromise = null;
    throw e;
  }
}
