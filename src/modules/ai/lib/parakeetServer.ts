import { invoke } from "@tauri-apps/api/core";
import { native } from "./native";
import { assertLoopbackUrl } from "./stt";

// First start may download the model from HuggingFace (~600 MB).
const START_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_500;

let startPromise: Promise<void> | null = null;
let bgHandle: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// lm_ping probes from the Rust side, so a local server that sends no CORS
// headers still answers. Any HTTP status means a server is listening.
async function ping(baseURL: string): Promise<boolean> {
  try {
    await invoke<number>("lm_ping", { baseUrl: baseURL });
    return true;
  } catch {
    return false;
  }
}

function logTail(bytes: string, max = 400): string {
  const t = bytes.trim();
  return t.length > max ? t.slice(-max) : t;
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
    if (await ping(baseURL)) return;
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
 */
export async function ensureParakeetServer(
  baseURL: string,
  command: string,
  onStarting?: () => void,
): Promise<void> {
  assertLoopbackUrl(baseURL, "Parakeet");
  if (await ping(baseURL)) return;
  const cmd = command.trim();
  if (!cmd) {
    throw new Error(
      "Parakeet server is not running and no start command is configured in Settings.",
    );
  }
  if (startPromise) {
    await startPromise.catch(() => {});
    if (await ping(baseURL)) return;
    startPromise = null;
  }
  onStarting?.();
  startPromise = startServer(baseURL, cmd);
  try {
    await startPromise;
  } catch (e) {
    startPromise = null;
    throw e;
  }
}
