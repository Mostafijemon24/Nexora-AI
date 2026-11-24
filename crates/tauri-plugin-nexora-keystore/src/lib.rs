//! Secure storage for the Android app.
//!
//! The work is done in Kotlin (`android/src/main/java/KeystorePlugin.kt`): values are encrypted
//! with a key that lives in the Android Keystore. This crate registers that plugin and gives the
//! app's Rust code `set` / `get` / `delete`. Nothing here is callable from the web UI.
//!
//! On every other platform the plugin is empty and the functions report that the store is
//! unavailable; desktop builds use the OS keychain instead and do not depend on this crate.

use tauri::plugin::{Builder, TauriPlugin};

#[cfg(target_os = "android")]
mod android {
    use serde::Deserialize;
    use std::sync::OnceLock;
    use tauri::plugin::PluginHandle;
    use tauri::Wry;

    pub const PLUGIN_IDENTIFIER: &str = "ai.nexora.keystore";
    pub static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

    #[derive(Deserialize)]
    struct Secret {
        value: Option<String>,
    }

    #[derive(Deserialize)]
    pub struct Device {
        pub name: String,
        pub os: String,
    }

    fn handle() -> Result<&'static PluginHandle<Wry>, String> {
        HANDLE.get().ok_or_else(|| "Secure storage has not started yet.".to_string())
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        handle()?
            .run_mobile_plugin::<()>("set", serde_json::json!({ "name": name, "value": value }))
            .map_err(|e| e.to_string())
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        handle()?
            .run_mobile_plugin::<Secret>("get", serde_json::json!({ "name": name }))
            .map(|s| s.value)
            .map_err(|e| e.to_string())
    }

    pub fn delete(name: &str) -> Result<(), String> {
        handle()?
            .run_mobile_plugin::<()>("delete", serde_json::json!({ "name": name }))
            .map_err(|e| e.to_string())
    }

    pub fn device() -> Result<Device, String> {
        handle()?.run_mobile_plugin::<Device>("device", serde_json::json!({})).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "android")]
pub use android::{delete, device, get, set, Device};

#[cfg(not(target_os = "android"))]
mod other {
    const UNAVAILABLE: &str = "The Android Keystore is only available on Android.";
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Err(UNAVAILABLE.into())
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
}

#[cfg(not(target_os = "android"))]
pub use other::{delete, get, set};

/// Registers the Kotlin plugin. Add it to the app before anything reads a secret.
#[cfg(target_os = "android")]
pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("nexora-keystore")
        .setup(|_app, api| {
            let handle = api.register_android_plugin(android::PLUGIN_IDENTIFIER, "KeystorePlugin")?;
            let _ = android::HANDLE.set(handle);
            Ok(())
        })
        .build()
}

/// Registers nothing: there is no Android Keystore here.
#[cfg(not(target_os = "android"))]
pub fn init<R: tauri::Runtime>() -> TauriPlugin<R> {
    Builder::new("nexora-keystore").build()
}
