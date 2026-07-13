import { emit, listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
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

type Target = { tabId: number; label: string; agent: boolean };

const targetsEl = document.getElementById("targets") as HTMLDivElement;
const BASE_HEIGHT = 52;
const TARGET_ROW = 28;
const MAX_VISIBLE_TARGETS = 8;

let targets: Target[] = [];
let currentTabId = -1;

function resize(): void {
  const rows = targetsEl.classList.contains("visible")
    ? Math.min(targets.length, MAX_VISIBLE_TARGETS)
    : 0;
  const height = BASE_HEIGHT + (rows > 0 ? rows * TARGET_ROW + 6 : 0);
  void getCurrentWindow().setSize(new LogicalSize(OVERLAY_WIDTH, height));
}

function renderTargets(): void {
  const show = pill.dataset.state === "recording" && targets.length > 1;
  targetsEl.classList.toggle("visible", show);
  targetsEl.replaceChildren(
    ...targets.map((t, i) => {
      const row = document.createElement("div");
      row.className = `target${t.tabId === currentTabId ? " current" : ""}`;
      const idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = String(i + 1);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = t.label;
      row.append(idx, name);
      if (t.agent) {
        const dot = document.createElement("span");
        dot.className = "agent-dot";
        row.append(dot);
      }
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        void emit("terax:dictation-pick", { tabId: t.tabId });
      });
      return row;
    }),
  );
  resize();
  targetsEl
    .querySelector(".target.current")
    ?.scrollIntoView({ block: "nearest" });
}

void listen<{ state: string }>("terax:dictation-state", (e) => {
  const state = e.payload.state;
  pill.dataset.state = state;
  label.textContent = LABELS[state] ?? "Recording...";
  if (state !== "recording") targets = [];
  renderTargets();
});

void listen<{ targets: Target[]; activeTabId: number }>(
  "terax:dictation-targets",
  (e) => {
    targets = e.payload.targets;
    currentTabId = e.payload.activeTabId;
    renderTargets();
  },
);

// Scrolling anywhere over the overlay cycles the dictation target. Native
// list scrolling is suppressed; the selection scrolls itself into view.
let lastWheel = 0;
document.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (targets.length < 2) return;
    const now = Date.now();
    if (now - lastWheel < 150) return;
    lastWheel = now;
    const dir = e.deltaY > 0 ? 1 : -1;
    const idx = targets.findIndex((t) => t.tabId === currentTabId);
    const next = targets[(idx + dir + targets.length) % targets.length];
    void emit("terax:dictation-pick", { tabId: next.tabId });
  },
  { passive: false },
);

// First-show handshake: the main window emits state and targets again once
// this page is actually listening, so the first recording shows the list.
void emit("terax:overlay-ready");

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
