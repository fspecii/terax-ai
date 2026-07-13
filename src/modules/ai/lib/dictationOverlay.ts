import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Floating always-on-top recording indicator, visible even when the main
 * window is hidden or unfocused. Created lazily on first use; the overlay
 * page (overlay.html) positions itself and renders the state it receives
 * via the `terax:dictation-state` event.
 */
const LABEL = "dictation-overlay";
const WIDTH = 210;
const HEIGHT = 52;

let creating: Promise<WebviewWindow> | null = null;

function getOrCreate(): Promise<WebviewWindow> {
  if (!creating) {
    creating = (async () => {
      const existing = await WebviewWindow.getByLabel(LABEL);
      if (existing) return existing;
      return new Promise<WebviewWindow>((resolve, reject) => {
        const w = new WebviewWindow(LABEL, {
          url: "overlay.html",
          width: WIDTH,
          height: HEIGHT,
          decorations: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          resizable: false,
          focus: false,
          // Never steal focus from the app the user is working in; clicks
          // still reach the page.
          focusable: false,
          shadow: false,
          visible: false,
          visibleOnAllWorkspaces: true,
          acceptFirstMouse: true,
        });
        w.once("tauri://created", () => resolve(w));
        w.once("tauri://error", (e) => {
          creating = null;
          reject(new Error(String(e.payload)));
        });
      });
    })();
    creating.catch(() => {
      creating = null;
    });
  }
  return creating;
}

export async function showDictationOverlay(
  state: "recording" | "transcribing" | "speaking",
): Promise<void> {
  const w = await getOrCreate();
  await emit("terax:dictation-state", { state });
  await w.show();
}

export async function hideDictationOverlay(): Promise<void> {
  const w = await WebviewWindow.getByLabel(LABEL);
  await w?.hide();
}
