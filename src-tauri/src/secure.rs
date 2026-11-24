//! OS secure storage for secrets (session token, entitlement token, device registration).
//!
//! Desktop targets use the platform keystore through `keyring`. Android encrypts each value with
//! a key held in the Android Keystore (`crates/tauri-plugin-nexora-keystore`). Where neither
//! exists, secrets are refused rather than written somewhere weaker.

#[cfg(desktop)]
mod imp {
    use keyring::{Entry, Error};

    const SERVICE: &str = "ai.nexora.app";

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        Entry::new(SERVICE, name).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        match Entry::new(SERVICE, name).and_then(|e| e.get_password()) {
            Ok(v) => Ok(Some(v)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(name: &str) -> Result<(), String> {
        match Entry::new(SERVICE, name).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(target_os = "android")]
mod imp {
    pub use tauri_plugin_nexora_keystore::{delete, get, set};
}

#[cfg(all(mobile, not(target_os = "android")))]
mod imp {
    const UNAVAILABLE: &str = "Secure storage is not available on this platform yet.";
    pub fn set(_: &str, _: &str) -> Result<(), String> { Err(UNAVAILABLE.into()) }
    pub fn get(_: &str) -> Result<Option<String>, String> { Ok(None) }
    pub fn delete(_: &str) -> Result<(), String> { Ok(()) }
}

pub use imp::{delete, get, set};
