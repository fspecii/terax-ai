import type { ProviderKeys } from "./keyring";
import { createProxyFetch } from "./proxyFetch";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const STT_TIMEOUT_GROQ_MS = 30_000;
const STT_TIMEOUT_WHISPERCPP_MS = 180_000;
const STT_TIMEOUT_PARAKEET_MS = 180_000;

// Local servers rarely send CORS headers, so webview fetch fails with an
// opaque "Load failed". Route those through the Rust HTTP proxy instead.
const localProxyFetch = createProxyFetch({ allowPrivateNetwork: true });

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; bytes: Uint8Array };

// The Rust proxy takes raw bytes, so multipart bodies are assembled by hand;
// letting the webview serialize FormData would round-trip the WAV through a
// lossy UTF-8 decode.
export function buildMultipartBody(
  parts: MultipartPart[],
  boundary: string,
): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    if ("bytes" in part) {
      chunks.push(
        enc.encode(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(part.bytes);
    } else {
      chunks.push(
        enc.encode(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`,
        ),
      );
    }
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function transcribeOpenAI(blob: Blob, apiKey: string): Promise<string> {
  const [{ createOpenAI }, { experimental_transcribe: transcribe }] =
    await Promise.all([import("@ai-sdk/openai"), import("ai")]);
  const openai = createOpenAI({ apiKey });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const { text } = await transcribe({
    model: openai.transcription("whisper-1"),
    audio: buf,
  });
  return text;
}

async function transcribeViaRest(
  baseURL: string,
  blob: Blob,
  apiKey: string | null,
  model: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", blob, "audio.webm");
  form.append("model", model);
  form.append("response_format", "text");

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetchWithTimeout(`${baseURL}/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  }, STT_TIMEOUT_GROQ_MS);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `STT request failed (${res.status}): ${body || res.statusText}`,
    );
  }
  return res.text();
}

// STT models run at 16 kHz mono; resampling here also keeps the IPC payload
// to the Rust proxy several times smaller than the mic's native rate.
const WAV_SAMPLE_RATE = 16_000;

async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE)),
      WAV_SAMPLE_RATE,
    );
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const buf = await offline.startRendering();
    const length = buf.length;
    const sampleRate = buf.sampleRate;
    const channel = buf.getChannelData(0);
    const dataLen = length * 2;
    const buffer = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buffer);

    const writeStr = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataLen, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataLen, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    return new Blob([buffer], { type: "audio/wav" });
  } finally {
    ctx.close();
  }
}

async function transcribeWhisperCpp(
  baseURL: string,
  blob: Blob,
): Promise<string> {
  const wav = await toWav(blob);
  const wavBytes = new Uint8Array(await wav.arrayBuffer());
  const boundary = `----terax-${Math.random().toString(36).slice(2)}`;
  const reqBody = buildMultipartBody(
    [
      {
        name: "file",
        filename: "audio.wav",
        contentType: "audio/wav",
        bytes: wavBytes,
      },
      { name: "response_format", value: "text" },
    ],
    boundary,
  );
  const res = await fetchWithTimeout(
    `${baseURL}/inference`,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: reqBody,
    },
    STT_TIMEOUT_WHISPERCPP_MS,
    localProxyFetch,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `STT request failed (${res.status}): ${body || res.statusText}`,
    );
  }
  return res.text();
}

// Offline providers: never POST recorded audio to a non-loopback host.
export function assertLoopbackUrl(baseURL: string, providerName: string): void {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(`Invalid ${providerName} URL: ${baseURL}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  if (!loopback) {
    throw new Error(
      `${providerName} must run on a loopback address (localhost or 127.x.x.x) to keep transcription local.`,
    );
  }
}

// OpenAI-compatible local Parakeet servers (parakeet-mlx-server, mlx-audio,
// parakeet-mlx-fastapi) all expose this path; shared with parakeetServer.ts
// so it can probe the exact endpoint instead of just the base URL.
export function resolveParakeetTranscriptionEndpoint(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, "");
  return base.endsWith("/v1")
    ? `${base}/audio/transcriptions`
    : `${base}/v1/audio/transcriptions`;
}

// OpenAI-compatible local Parakeet servers (parakeet-mlx-server, mlx-audio,
// parakeet-mlx-fastapi). They differ in response_format support, so parse
// both plain text and {"text": ...} JSON bodies.
async function transcribeParakeet(
  baseURL: string,
  blob: Blob,
  model: string,
): Promise<string> {
  const endpoint = resolveParakeetTranscriptionEndpoint(baseURL);

  const wav = await toWav(blob);
  const wavBytes = new Uint8Array(await wav.arrayBuffer());
  const boundary = `----terax-${Math.random().toString(36).slice(2)}`;
  const parts: MultipartPart[] = [
    {
      name: "file",
      filename: "audio.wav",
      contentType: "audio/wav",
      bytes: wavBytes,
    },
    { name: "response_format", value: "text" },
  ];
  if (model) parts.push({ name: "model", value: model });
  const reqBody = buildMultipartBody(parts, boundary);
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: reqBody,
    },
    STT_TIMEOUT_PARAKEET_MS,
    localProxyFetch,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `STT request failed (${res.status}): ${body || res.statusText}`,
    );
  }
  const body = await res.text();
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { text?: unknown }).text === "string"
    ) {
      return (parsed as { text: string }).text;
    }
  } catch {
    // plain text response
  }
  return body;
}

export type SttOptions = {
  groqSttModel?: string;
  whispercppBaseURL?: string;
  parakeetBaseURL?: string;
  parakeetModel?: string;
};

export async function transcribeAudio(
  blob: Blob,
  provider: import("../config").SttProvider,
  apiKeys: ProviderKeys,
  options: SttOptions = {},
): Promise<string> {
  switch (provider) {
    case "openai": {
      const key = apiKeys.openai;
      if (!key) throw new Error("OpenAI API key is not configured");
      return transcribeOpenAI(blob, key);
    }
    case "groq": {
      const key = apiKeys.groq;
      if (!key) throw new Error("Groq API key is not configured");
      const model = options.groqSttModel || "whisper-large-v3-turbo";
      return transcribeViaRest(GROQ_BASE_URL, blob, key, model);
    }
    case "whispercpp": {
      const baseURL =
        options.whispercppBaseURL?.replace(/\/+$/, "") || "http://127.0.0.1:8080";
      assertLoopbackUrl(baseURL, "Whisper.cpp");
      return transcribeWhisperCpp(baseURL, blob);
    }
    case "parakeet": {
      const baseURL =
        options.parakeetBaseURL?.replace(/\/+$/, "") || "http://127.0.0.1:8000";
      assertLoopbackUrl(baseURL, "Parakeet");
      return transcribeParakeet(baseURL, blob, options.parakeetModel ?? "");
    }
  }
}
