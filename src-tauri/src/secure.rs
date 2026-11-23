//! OS secure storage for secrets (session token, entitlement token, device registration).
//!
//! Desktop targets use the platform keystore through `keyring`. Android has no vetted
//! Tauri 2 secure-storage path yet (flagged in the design handoff as needing verification),
//! so secrets are refused there rather than written somewhere weaker.

const SERVICE: &str = "ai.nexora.app";

#[cfg(desktop)]
mod imp {
    use super::SERVICE;
    use keyring::{Entry, Error};

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

#[cfg(mobile)]
mod imp {
    const UNAVAILABLE: &str = "Secure storage is not available on this platform yet.";
    pub fn set(_: &str, _: &str) -> Result<(), String> { Err(UNAVAILABLE.into()) }
    pub fn get(_: &str) -> Result<Option<String>, String> { Ok(None) }
    pub fn delete(_: &str) -> Result<(), String> { Ok(()) }
    #[allow(dead_code)]
    const _: &str = super::SERVICE;
}

pub use imp::{delete, get, set};
