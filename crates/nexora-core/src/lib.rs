//! Platform-independent core of the Nexora AI client.
//!
//! Nothing here touches the OS, the network or Tauri, so every rule that matters for
//! licensing and offline sync can be tested on any machine with `cargo test`.

pub mod entitlement;
pub mod store;

pub use entitlement::{verify, Entitlement, EntitlementError, GRACE_PERIOD_SECS};
pub use store::{Store, StoreError};
