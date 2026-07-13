use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;

/// Global single-key dictation hotkey (e.g. right Option / right Command).
/// Polls modifier key state system-wide via CGEventSourceKeyState. Since
/// macOS 10.15 that API only reports keys typed into OTHER apps when the app
/// holds the Input Monitoring permission, so enabling the hotkey requests it
/// via IOHIDRequestAccess. A short press-and-release of the configured key
/// emits `terax:dictation-tap` to the frontend.
static TARGET_KEYCODE: AtomicU16 = AtomicU16::new(0);
static LISTENER: OnceLock<()> = OnceLock::new();

#[cfg(target_os = "macos")]
mod key_state {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: i32, keycode: u16) -> bool;
        fn CGEventSourceFlagsState(state_id: i32) -> u64;
    }

    /// state ids: 0 = combined session, 1 = HID system
    pub fn is_down_state(state_id: i32, keycode: u16) -> bool {
        unsafe { CGEventSourceKeyState(state_id, keycode) }
    }

    pub fn flags(state_id: i32) -> u64 {
        unsafe { CGEventSourceFlagsState(state_id) }
    }

    /// Device-dependent modifier bit for a modifier keycode (NX_DEVICE*),
    /// present in the low bits of CGEventSourceFlagsState.
    fn device_flag_for(keycode: u16) -> u64 {
        match keycode {
            54 => 0x0010, // right command
            55 => 0x0008, // left command
            58 => 0x0020, // left option
            61 => 0x0040, // right option
            _ => 0,
        }
    }

    /// CGEventSourceKeyState never reports modifier keys, so modifiers are
    /// read from the flags state instead (verified on macOS 15).
    pub fn is_down(keycode: u16) -> bool {
        let bit = device_flag_for(keycode);
        if bit != 0 {
            return flags(0) & bit != 0 || flags(1) & bit != 0;
        }
        is_down_state(0, keycode) || is_down_state(1, keycode)
    }
}

#[cfg(target_os = "macos")]
mod input_monitoring {
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request_type: u32) -> u32;
        fn IOHIDRequestAccess(request_type: u32) -> bool;
    }

    const LISTEN_EVENT: u32 = 1;
    const GRANTED: u32 = 0;

    pub fn granted() -> bool {
        unsafe { IOHIDCheckAccess(LISTEN_EVENT) == GRANTED }
    }

    /// Shows the system prompt on first call; afterwards the user must
    /// enable it manually in System Settings > Privacy > Input Monitoring.
    pub fn request() -> bool {
        unsafe { IOHIDRequestAccess(LISTEN_EVENT) }
    }
}

#[cfg(target_os = "macos")]
fn listen_loop(app: tauri::AppHandle) {
    use std::time::{Duration, Instant};
    use tauri::Emitter;

    const POLL: Duration = Duration::from_millis(25);
    const MAX_TAP_MS: u128 = 500;

    let mut down_at: Option<Instant> = None;
    let mut watched: u16 = 0;
    loop {
        std::thread::sleep(POLL);
        let key = TARGET_KEYCODE.load(Ordering::Relaxed);
        if key == 0 {
            down_at = None;
            continue;
        }
        if watched != key {
            watched = key;
            down_at = None;
        }
        match (key_state::is_down(key), down_at) {
            (true, None) => down_at = Some(Instant::now()),
            (false, Some(t)) => {
                if t.elapsed().as_millis() <= MAX_TAP_MS {
                    let _ = app.emit("terax:dictation-tap", ());
                }
                down_at = None;
            }
            _ => {}
        }
    }
}

/// Sets (or clears, with None) the dictation hotkey keycode. Returns the
/// listener status: "ok", "needs-permission" (macOS Input Monitoring not
/// granted, hotkey only sees keys while Terax is focused), or "unsupported".
#[tauri::command]
pub fn dictation_hotkey_set(app: tauri::AppHandle, keycode: Option<u16>) -> &'static str {
    #[cfg(target_os = "macos")]
    {
        let key = keycode.unwrap_or(0);
        TARGET_KEYCODE.store(key, Ordering::Relaxed);
        if key == 0 {
            return "ok";
        }
        LISTENER.get_or_init(move || {
            std::thread::spawn(move || listen_loop(app));
        });
        if input_monitoring::granted() || input_monitoring::request() {
            "ok"
        } else {
            "needs-permission"
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, keycode);
        "unsupported"
    }
}

/// Opens the Input Monitoring pane of System Settings.
#[tauri::command]
pub fn dictation_open_privacy_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .spawn();
    }
}
