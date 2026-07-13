import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatStore } from "../store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { ensureParakeetServer } from "../lib/parakeetServer";
import { transcribeAudio, type SttOptions } from "../lib/stt";
import { PARAKEET_DEFAULT_BASE_URL, type SttProvider } from "../config";

const PARAKEET_START_TOAST_ID = "parakeet-server-start";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

function providerNeedsKey(provider: SttProvider): boolean {
  return provider !== "whispercpp" && provider !== "parakeet";
}

function getApiKeyForStt(
  apiKeys: import("../lib/keyring").ProviderKeys,
  provider: SttProvider,
): string | null {
  if (provider === "openai") return apiKeys.openai;
  if (provider === "groq") return apiKeys.groq;
  return null;
}

type State = "idle" | "recording" | "transcribing";

const LEVEL_INTERVAL_MS = 80;

export function useWhisperRecording({
  onResult,
  onLevel,
}: {
  onResult: (text: string) => void;
  /** Mic amplitude (RMS, 0..1) while recording, ~12 Hz. No React state. */
  onLevel?: (level: number) => void;
}) {
  const apiKeys = useChatStore((s) => s.apiKeys);
  const sttProvider = usePreferencesStore((s) => s.sttProvider);
  const groqSttModel = usePreferencesStore((s) => s.groqSttModel);
  const whispercppBaseURL = usePreferencesStore((s) => s.whispercppBaseURL);
  const parakeetBaseURL = usePreferencesStore((s) => s.parakeetBaseURL);
  const parakeetModel = usePreferencesStore((s) => s.parakeetModel);
  const parakeetAutoStart = usePreferencesStore((s) => s.parakeetAutoStart);
  const parakeetServerCommand = usePreferencesStore(
    (s) => s.parakeetServerCommand,
  );
  const [state, setState] = useState<State>("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const levelCtxRef = useRef<AudioContext | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;

  const needsKey = providerNeedsKey(sttProvider);
  const providerKey = needsKey ? getApiKeyForStt(apiKeys, sttProvider) : null;
  const hasKey = needsKey ? !!providerKey : true;

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const sttOptions: SttOptions = {
    groqSttModel,
    whispercppBaseURL,
    parakeetBaseURL,
    parakeetModel,
  };

  const teardownStream = () => {
    if (levelTimerRef.current !== null) {
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    void levelCtxRef.current?.close().catch(() => {});
    levelCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startLevelMeter = (stream: MediaStream) => {
    if (!onLevelRef.current) return;
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      levelCtxRef.current = ctx;
      levelTimerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const c = (v - 128) / 128;
          sum += c * c;
        }
        onLevelRef.current?.(Math.sqrt(sum / data.length));
      }, LEVEL_INTERVAL_MS);
    } catch {
      // Level metering is cosmetic; recording continues without it.
    }
  };

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const start = useCallback(async () => {
    if (!supported || !hasKey || state !== "idle") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || "audio/webm",
        });
        chunksRef.current = [];
        teardownStream();
        if (blob.size === 0) {
          setState("idle");
          return;
        }
        setState("transcribing");
        try {
          if (sttProvider === "parakeet" && parakeetAutoStart) {
            const base =
              parakeetBaseURL.trim().replace(/\/+$/, "") ||
              PARAKEET_DEFAULT_BASE_URL;
            try {
              await ensureParakeetServer(base, parakeetServerCommand, () =>
                toast.loading("Starting Parakeet server...", {
                  id: PARAKEET_START_TOAST_ID,
                  description:
                    "First run downloads the model, this can take a few minutes.",
                }),
              );
            } finally {
              toast.dismiss(PARAKEET_START_TOAST_ID);
            }
          }
          const text = await transcribeAudio(blob, sttProvider, apiKeys, sttOptions);
          if (text.trim()) onResult(text.trim());
        } catch (e) {
          console.error("stt.transcribe", e);
          toast.error(e instanceof Error ? e.message : "Transcription failed");
        } finally {
          setState("idle");
        }
      };
      recRef.current = rec;
      rec.start();
      startLevelMeter(stream);
      setState("recording");
    } catch (e) {
      console.error("stt.getUserMedia", e);
      toast.error("Microphone access failed");
      teardownStream();
      setState("idle");
    }
  }, [
    apiKeys,
    sttProvider,
    sttOptions,
    onResult,
    state,
    supported,
    hasKey,
    parakeetAutoStart,
    parakeetBaseURL,
    parakeetServerCommand,
  ]);

  useEffect(() => {
    return () => {
      recRef.current?.stop();
      teardownStream();
    };
  }, []);

  return {
    state,
    recording: state === "recording",
    transcribing: state === "transcribing",
    start,
    stop,
    supported,
    hasKey,
    sttProvider,
  };
}
