import { emit, listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
} from "@tauri-apps/api/window";

const OVERLAY_WIDTH = 210;
// Top-center, just below the menu bar; the bottom of the screen hides the
// pill behind the Dock.
const TOP_MARGIN = 44;

const pill = document.getElementById("pill") as HTMLDivElement;
const label = document.getElementById("label") as HTMLSpanElement;

async function place(): Promise<void> {
  const monitor = await currentMonitor();
  if (!monitor) return;
  const scale = monitor.scaleFactor;
  const x =
    monitor.position.x / scale +
    (monitor.size.width / scale - OVERLAY_WIDTH) / 2;
  const y = monitor.position.y / scale + TOP_MARGIN;
  await getCurrentWindow().setPosition(new LogicalPosition(x, y));
}

void place();

const LABELS: Record<string, string> = {
  recording: "Recording...",
  transcribing: "Transcribing...",
  speaking: "Speaking...",
};

void listen<{ state: string }>("terax:dictation-state", (e) => {
  const state = e.payload.state;
  pill.dataset.state = state;
  label.textContent = LABELS[state] ?? "Recording...";
});

pill.addEventListener("click", () => {
  void emit("terax:overlay-click", { state: pill.dataset.state ?? "" });
});
