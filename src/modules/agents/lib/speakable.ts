/** Spoken responses stay short; the tail of the buffer holds the answer. */
const MAX_SPOKEN_CHARS = 600;

const BOX_CHARS = /[─-╿▀-▟]/g;
const MARKER_CHARS = /[⏺●○◆✦✻✱•✽✳⎿]/g;

/** Lines that open an assistant message block in agent TUIs
 *  (Claude Code uses ⏺, Gemini uses ✦). */
const MESSAGE_MARKER = /^\s*[⏺✦]/;

// TUI chrome that is never part of an agent's answer.
const CHROME_PATTERNS: RegExp[] = [
  /\(esc to interrupt\)/i,
  /\? for shortcuts/i,
  /esc to undo/i,
  /ctrl\+[a-z] to/i,
  /^\s*[>$❯%#]\s*$/,
  /tokens? used/i,
  /auto-accept/i,
  /bypass permissions/i,
  /shift\+tab to cycle/i,
  // Spinner/status lines: "Booping… (running stop hook · 7s · thought for 2s)"
  /(…|\.\.\.)\s*\(/,
  /\(running [^)]*\)/i,
  /thought for \d/i,
];

function isChrome(line: string): boolean {
  return CHROME_PATTERNS.some((p) => p.test(line));
}

/**
 * Reduces a terminal buffer tail to text worth speaking. Scopes to the last
 * assistant message block when the TUI marks one (so banners and earlier
 * turns are not read), strips box-drawing borders, spinner glyphs, prompts,
 * and status-bar chrome, then returns the last MAX_SPOKEN_CHARS.
 */
export function extractSpeakableText(buffer: string): string {
  const rawLines = buffer.split(/\r?\n/);
  let start = 0;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (MESSAGE_MARKER.test(rawLines[i])) {
      start = i;
      break;
    }
  }
  const lines = rawLines
    .slice(start)
    .map((l) => l.replace(BOX_CHARS, " ").replace(MARKER_CHARS, " ").trim())
    .filter((l) => l.length > 0)
    .filter((l) => /[a-zA-Z0-9]/.test(l))
    .filter((l) => !isChrome(l));

  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= MAX_SPOKEN_CHARS) return text;
  // Resume from a word boundary so speech does not start mid-word.
  const tail = text.slice(-MAX_SPOKEN_CHARS);
  const firstSpace = tail.indexOf(" ");
  return firstSpace >= 0 ? tail.slice(firstSpace + 1).trimStart() : tail;
}
