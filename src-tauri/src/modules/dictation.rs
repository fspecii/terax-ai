/// Global single-key dictation hotkeys (e.g. right Option / right Command).
/// A short press-and-release of the toggle key emits `terax:dictation-tap`;
/// the cycle key emits `terax:dictation-cycle`. Implemented by polling key
/// state: CGEventSourceFlagsState on macOS (Input Monitoring required to see
/// keys typed into other apps), GetAsyncKeyState on Windows (no permission
/// needed). Linux has no portable global key API (Wayland forbids it), so it
/// falls back to the in-window DOM listener.
#[cfg(any(target_os = "macos", windows))]
mod hotkey {
    use std::sync::atomic::{AtomicU16, Ordering};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};
    use tauri::Emitter;

    pub static TARGET_KEYCODE: AtomicU16 = AtomicU16::new(0);
    pub static CYCLE_KEYCODE: AtomicU16 = AtomicU16::new(0);
    pub static LISTENER: OnceLock<()> = OnceLock::new();

    const POLL: Duration = Duration::from_millis(25);
    const MAX_TAP_MS: u128 = 500;

    #[cfg(target_os = "macos")]
    mod key_state {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceKeyState(state_id: i32, keycode: u16) -> bool;
            fn CGEventSourceFlagsState(state_id: i32) -> u64;
        }

        /// state ids: 0 = combined session, 1 = HID system
        fn is_down_state(state_id: i32, keycode: u16) -> bool {
            unsafe { CGEventSourceKeyState(state_id, keycode) }
        }

        fn flags(state_id: i32) -> u64 {
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

    #[cfg(windows)]
    mod key_state {
        #[link(name = "user32")]
        extern "system" {
            fn GetAsyncKeyState(v_key: i32) -> i16;
        }

        /// The frontend speaks macOS virtual keycodes; map them to Win32 VKs.
        fn vk_for(keycode: u16) -> i32 {
            match keycode {
                54 => 0x5C, // right command -> right Windows key
                55 => 0x5B, // left command -> left Windows key
                58 => 0xA4, // left option -> left Alt
                61 => 0xA5, // right option -> right Alt
                _ => 0,
            }
        }

        pub fn is_down(keycode: u16) -> bool {
            let vk = vk_for(keycode);
            vk != 0 && unsafe { (GetAsyncKeyState(vk) as u16) & 0x8000 != 0 }
        }
    }

    struct Tap {
        watched: u16,
        down_at: Option<Instant>,
    }

    impl Tap {
        const fn new() -> Self {
            Tap { watched: 0, down_at: None }
        }

        fn poll(&mut self, key: u16) -> bool {
            if key == 0 {
                self.down_at = None;
                return false;
            }
            if self.watched != key {
                self.watched = key;
                self.down_at = None;
            }
            match (key_state::is_down(key), self.down_at) {
                (true, None) => {
                    self.down_at = Some(Instant::now());
                    false
                }
                (false, Some(t)) => {
                    self.down_at = None;
                    t.elapsed().as_millis() <= MAX_TAP_MS
                }
                _ => false,
            }
        }
    }

    pub fn listen_loop(app: tauri::AppHandle) {
        let mut toggle = Tap::new();
        let mut cycle = Tap::new();
        loop {
            std::thread::sleep(POLL);
            if toggle.poll(TARGET_KEYCODE.load(Ordering::Relaxed)) {
                let _ = app.emit("terax:dictation-tap", ());
            }
            if cycle.poll(CYCLE_KEYCODE.load(Ordering::Relaxed)) {
                let _ = app.emit("terax:dictation-cycle", ());
            }
        }
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

/// Sets (or clears, with None) the dictation toggle and cycle keycodes.
/// Returns the listener status: "ok", "needs-permission" (macOS Input
/// Monitoring not granted, hotkeys only see keys while Terax is focused),
/// or "unsupported".
#[tauri::command]
pub fn dictation_hotkey_set(
    app: tauri::AppHandle,
    keycode: Option<u16>,
    cycle_keycode: Option<u16>,
) -> &'static str {
    #[cfg(any(target_os = "macos", windows))]
    {
        use std::sync::atomic::Ordering;

        let key = keycode.unwrap_or(0);
        hotkey::TARGET_KEYCODE.store(key, Ordering::Relaxed);
        hotkey::CYCLE_KEYCODE.store(cycle_keycode.unwrap_or(0), Ordering::Relaxed);
        if key == 0 {
            return "ok";
        }
        hotkey::LISTENER.get_or_init(move || {
            std::thread::spawn(move || hotkey::listen_loop(app));
        });
        #[cfg(target_os = "macos")]
        {
            if input_monitoring::granted() || input_monitoring::request() {
                "ok"
            } else {
                "needs-permission"
            }
        }
        #[cfg(windows)]
        {
            "ok"
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, keycode, cycle_keycode);
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
