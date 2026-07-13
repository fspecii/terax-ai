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

// Mic level bars while recording: center-weighted heights from the RMS level.
const bars = Array.from(
  document.querySelectorAll<HTMLElement>("#bars i"),
);
const BAR_WEIGHTS = [0.45, 0.75, 1, 0.75, 0.45];

void listen<number>("terax:dictation-level", (e) => {
  const level = Math.min(1, e.payload * 3.5);
  bars.forEach((bar, i) => {
    bar.style.height = `${3 + level * BAR_WEIGHTS[i] * 13}px`;
  });
});
