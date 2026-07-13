import { describe, expect, it } from "vitest";
import { labelFor } from "./tabLabel";
import type { TerminalTab } from "./useTabs";

function terminalTab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "default",
    title: "shell",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...over,
  };
}

describe("labelFor (terminal tabs)", () => {
  it("derives the label from the last cwd segment", () => {
    expect(labelFor(terminalTab({ cwd: "/Users/me/projects/terax-ai" }))).toBe(
      "terax-ai",
    );
  });

  it("falls back to the title when there is no cwd", () => {
    expect(labelFor(terminalTab({ title: "private" }))).toBe("private");
  });

  it("prefers a custom title over the cwd-derived name", () => {
    expect(
      labelFor(terminalTab({ cwd: "/Users/me/projects/terax-ai", customTitle: "Server" })),
    ).toBe("Server");
  });

  it("keeps the custom title after the cwd changes (survives cd)", () => {
    const renamed = terminalTab({ cwd: "/Users/me/a", customTitle: "Server" });
    const afterCd = { ...renamed, cwd: "/Users/me/b/c" };
    expect(labelFor(afterCd)).toBe("Server");
  });

  it("handles Windows-style cwd separators", () => {
    expect(labelFor(terminalTab({ cwd: "C:\\Users\\me\\proj" }))).toBe("proj");
  });

  it("prefers the program's OSC title over the cwd-derived name", () => {
    expect(
      labelFor(
        terminalTab({ cwd: "/Users/me", oscTitle: "claude - terax-ai" }),
      ),
    ).toBe("claude - terax-ai");
  });

  it("keeps a user rename above the program's OSC title", () => {
    expect(
      labelFor(
        terminalTab({
          cwd: "/Users/me",
          oscTitle: "claude - terax-ai",
          customTitle: "Agent",
        }),
      ),
    ).toBe("Agent");
  });

  it("falls back to the cwd once the OSC title is cleared", () => {
    const during = terminalTab({ cwd: "/Users/me/proj", oscTitle: "vim" });
    const after = { ...during, oscTitle: undefined };
    expect(labelFor(during)).toBe("vim");
    expect(labelFor(after)).toBe("proj");
  });
});
