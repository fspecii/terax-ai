use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

/// Built-in OS text-to-speech for agent responses. One utterance at a time:
/// a new speak request replaces the running one. `terax:tts-state` (bool)
/// tracks playback so the UI can show a stop control while speaking.
static SPEAKING: Mutex<Option<Child>> = Mutex::new(None);
static WATCHER: OnceLock<()> = OnceLock::new();

const MAX_TTS_CHARS: usize = 1_500;

fn emit_state(app: &tauri::AppHandle, speaking: bool) {
    let _ = app.emit("terax:tts-state", speaking);
}

/// Emits `false` when the current utterance finishes on its own.
fn ensure_watcher(app: tauri::AppHandle) {
    WATCHER.get_or_init(move || {
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let finished = {
                let mut slot = SPEAKING.lock().unwrap();
                match slot.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(_)) | Err(_) => {
                            *slot = None;
                            true
                        }
                        Ok(None) => false,
                    },
                    None => false,
                }
            };
            if finished {
                emit_state(&app, false);
            }
        });
    });
}

fn kill_current(slot: &mut Option<Child>) {
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn spawn_speaker(text: &str) -> Result<Child, String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("say")
            .arg("--")
            .arg(text)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        let mut child = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Speech; \
                 $t = [Console]::In.ReadToEnd(); \
                 (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($t)",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        Ok(child)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("spd-say")
            .arg("--wait")
            .arg("--")
            .arg(text)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn tts_speak(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let mut capped = trimmed.to_string();
    if capped.chars().count() > MAX_TTS_CHARS {
        capped = capped.chars().take(MAX_TTS_CHARS).collect();
    }
    {
        let mut slot = SPEAKING.lock().unwrap();
        kill_current(&mut slot);
        *slot = Some(spawn_speaker(&capped)?);
    }
    emit_state(&app, true);
    ensure_watcher(app);
    Ok(())
}

#[tauri::command]
pub fn tts_stop(app: tauri::AppHandle) {
    {
        let mut slot = SPEAKING.lock().unwrap();
        kill_current(&mut slot);
    }
    emit_state(&app, false);
}
