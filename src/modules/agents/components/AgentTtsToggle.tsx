import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentTtsEnabled } from "@/modules/settings/store";
import { VolumeHighIcon, VolumeMute02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { stopAgentSpeech } from "../lib/tts";

/**
 * Header toggle: when on, agent responses (Claude Code, Codex, Gemini, ...)
 * are read aloud with the OS text-to-speech engine as they arrive.
 */
export function AgentTtsToggle() {
  const enabled = usePreferencesStore((s) => s.agentTtsEnabled);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => {
        if (enabled) stopAgentSpeech();
        void setAgentTtsEnabled(!enabled);
      }}
      title={
        enabled
          ? "Voice for agent responses: on"
          : "Voice for agent responses: off"
      }
      aria-pressed={enabled}
      className={cn(
        "shrink-0 rounded-md hover:bg-accent",
        enabled
          ? "text-primary hover:text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <HugeiconsIcon
        icon={enabled ? VolumeHighIcon : VolumeMute02Icon}
        size={16}
        strokeWidth={1.75}
      />
    </Button>
  );
}
