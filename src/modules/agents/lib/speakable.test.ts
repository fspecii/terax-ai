import { describe, expect, it } from "vitest";
import { extractSpeakableText, speakableFromMarkdown } from "./speakable";

describe("extractSpeakableText", () => {
  it("strips box-drawing borders and keeps the answer", () => {
    const buffer = [
      "╭──────────────────────────╮",
      "│ > fix the login bug      │",
      "╰──────────────────────────╯",
      "⏺ I fixed the null check in auth.ts and added a test.",
      "",
      "╭──────────────────────────╮",
      "│ >                        │",
      "╰──────────────────────────╯",
      "  ? for shortcuts",
    ].join("\n");
    const out = extractSpeakableText(buffer);
    expect(out).toContain("I fixed the null check in auth.ts");
    expect(out).not.toContain("╭");
    expect(out).not.toContain("? for shortcuts");
  });

  it("drops spinner and status chrome lines", () => {
    const buffer = [
      "✻ Baking… (esc to interrupt)",
      "auto-accept edits on (shift+tab to cycle)",
      "Done. The tests pass now.",
    ].join("\n");
    const out = extractSpeakableText(buffer);
    expect(out).toBe("Done. The tests pass now.");
  });

  it("returns empty string for chrome-only buffers", () => {
    const buffer = ["╭───╮", "│   │", "╰───╯", "❯"].join("\n");
    expect(extractSpeakableText(buffer)).toBe("");
  });

  it("caps long output to the tail on a word boundary", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
    const out = extractSpeakableText(words.join(" "));
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.startsWith("word")).toBe(true);
    expect(out.endsWith("word299")).toBe(true);
  });

  it("collapses whitespace across lines", () => {
    const out = extractSpeakableText("first   line\n\n\nsecond    line");
    expect(out).toBe("first line second line");
  });

  it("scopes to the last assistant message block, skipping banners", () => {
    const buffer = [
      "3 MCP servers need authentication - run /mcp",
      "Extended through July 19 promo banner text",
      "⏺ Read(src/app.ts)",
      "⎿ 120 lines",
      "⏺ The bug is a missing null check on line 42.",
      "  I added a guard and the tests pass.",
      "✻ Booping… (running stop hook · 7s · thought for 2s)",
    ].join("\n");
    const out = extractSpeakableText(buffer);
    expect(out).toBe(
      "The bug is a missing null check on line 42. I added a guard and the tests pass.",
    );
  });

  it("filters spinner status lines with ellipsis", () => {
    const out = extractSpeakableText(
      "⏺ Done.\n✻ Simmering… (running stop hook · 3s)",
    );
    expect(out).toBe("Done.");
  });
});

describe("speakableFromMarkdown", () => {
  it("collapses code blocks and strips formatting", () => {
    const md = [
      "I fixed the bug in **auth.ts**:",
      "",
      "```ts",
      "if (user == null) return;",
      "```",
      "",
      "The `null` check now runs first. See [the docs](https://example.com).",
    ].join("\n");
    expect(speakableFromMarkdown(md)).toBe(
      "I fixed the bug in auth.ts: code block The null check now runs first. See the docs.",
    );
  });

  it("strips headings and list bullets", () => {
    const md = "## Summary\n- first thing\n- second thing";
    expect(speakableFromMarkdown(md)).toBe("Summary first thing second thing");
  });

  it("caps long messages to the tail", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const out = speakableFromMarkdown(words);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith("word299")).toBe(true);
  });
});
