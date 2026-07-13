import { open } from "@tauri-apps/plugin-dialog";

// Native OS folder picker — unlike the home-directory-rooted explorer tree,
// this surfaces every mounted volume (e.g. external drives under /Volumes
// on macOS), so it's the only way to open a space rooted outside the
// current filesystem neighborhood.
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, defaultPath });
  return typeof result === "string" ? result : null;
}
