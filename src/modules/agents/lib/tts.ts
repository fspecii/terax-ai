import { usePreferencesStore } from "@/modules/settings/preferences";
import { readLeafBuffer } from "@/modules/terminal";
import { invoke } from "@tauri-apps/api/core";
import { extractSpeakableText, speakableFromMarkdown } from "./speakable";

const BUFFER_LINES = 60;

/** Speaks the tail of an agent's terminal output via the OS TTS engine. */
export function maybeSpeakAgentResponse(leafId: number): void {
  if (!usePreferencesStore.getState().agentTtsEnabled) return;
  const buffer = readLeafBuffer(leafId, BUFFER_LINES);
  if (!buffer) return;
  const text = extractSpeakableText(buffer);
  if (!text) return;
  void invoke("tts_speak", { text }).catch(() => {});
}

/** Speaks an assistant chat message (markdown) via the OS TTS engine. */
export function maybeSpeakChatMessage(markdown: string): void {
  if (!usePreferencesStore.getState().agentTtsEnabled) return;
  const text = speakableFromMarkdown(markdown);
  if (!text) return;
  void invoke("tts_speak", { text }).catch(() => {});
}

export function stopAgentSpeech(): void {
  void invoke("tts_stop").catch(() => {});
}
