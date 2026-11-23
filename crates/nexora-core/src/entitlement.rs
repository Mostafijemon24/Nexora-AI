//! Offline verification of the signed entitlement token issued by the license server.
//!
//! The client never decides whether a license key is valid. After a successful activation
//! or revalidation the server hands back a token it signed with its Ed25519 key:
//!
//! ```text
//! base64url(payload JSON) "." base64url(signature over the payload bytes)
//! ```
//!
//! The app embeds only the matching public key, so it can check a token but cannot mint one.
//! A token lets a native target start without the server for a limited grace period.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Native targets may run this long after the last successful server check.
pub const GRACE_PERIOD_SECS: i64 = 7 * 24 * 60 * 60;

/// Tolerated clock difference between server and device.
const CLOCK_SKEW_SECS: i64 = 5 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entitlement {
    pub license_id: String,
    /// The device registration this token was issued to.
    pub device_id: String,
    pub plan: String,
    /// When the server issued the token (Unix seconds). The grace period counts from here.
    pub issued_at: i64,
    /// When the license itself ends (Unix seconds).
    pub license_expires_at: i64,
}

impl Entitlement {
    /// Last moment this token permits offline use.
    pub fn grace_until(&self) -> i64 {
        (self.issued_at + GRACE_PERIOD_SECS).min(self.license_expires_at)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EntitlementError {
    #[error("The license token is malformed.")]
    Malformed,
    #[error("The license token signature is not valid.")]
    BadSignature,
    #[error("The license token belongs to a different device.")]
    WrongDevice,
    #[error("The license has expired.")]
    LicenseExpired,
    #[error("The offline grace period has ended.")]
    GraceExpired,
    #[error("The device clock is earlier than the last license check.")]
    ClockRolledBack,
}

/// Checks a token's signature, device binding, license expiry and grace period.
///
/// `now` is passed in (Unix seconds) so the rule set is deterministic under test.
pub fn verify(
    token: &str,
    public_key: &[u8; 32],
    device_id: &str,
    now: i64,
) -> Result<Entitlement, EntitlementError> {
    let (payload_b64, sig_b64) = token.trim().split_once('.').ok_or(EntitlementError::Malformed)?;
    let payload = URL_SAFE_NO_PAD.decode(payload_b64).map_err(|_| EntitlementError::Malformed)?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig_b64).map_err(|_| EntitlementError::Malformed)?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|_| EntitlementError::Malformed)?;
    let key = VerifyingKey::from_bytes(public_key).map_err(|_| EntitlementError::BadSignature)?;

    // Signature first: nothing in the payload is trusted before this passes.
    key.verify(&payload, &signature).map_err(|_| EntitlementError::BadSignature)?;

    let ent: Entitlement = serde_json::from_slice(&payload).map_err(|_| EntitlementError::Malformed)?;
    if ent.device_id != device_id {
        return Err(EntitlementError::WrongDevice);
    }
    if now >= ent.license_expires_at {
        return Err(EntitlementError::LicenseExpired);
    }
    if now + CLOCK_SKEW_SECS < ent.issued_at {
        return Err(EntitlementError::ClockRolledBack);
    }
    if now > ent.issued_at + GRACE_PERIOD_SECS {
        return Err(EntitlementError::GraceExpired);
    }
    Ok(ent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    const NOW: i64 = 1_795_000_000;
    const DAY: i64 = 86_400;

    fn ent() -> Entitlement {
        Entitlement {
            license_id: "lic_1".into(),
            device_id: "dev_a".into(),
            plan: "professional".into(),
            issued_at: NOW,
            license_expires_at: NOW + 30 * DAY,
        }
    }

    fn sign(key: &SigningKey, e: &Entitlement) -> String {
        let payload = serde_json::to_vec(e).unwrap();
        let sig = key.sign(&payload);
        format!("{}.{}", URL_SAFE_NO_PAD.encode(&payload), URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    fn keys() -> (SigningKey, [u8; 32]) {
        let k = SigningKey::generate(&mut OsRng);
        let p = k.verifying_key().to_bytes();
        (k, p)
    }

    #[test]
    fn accepts_a_fresh_token_for_this_device() {
        let (k, p) = keys();
        let got = verify(&sign(&k, &ent()), &p, "dev_a", NOW + DAY).unwrap();
        assert_eq!(got, ent());
        assert_eq!(got.grace_until(), NOW + 7 * DAY);
    }

    #[test]
    fn rejects_a_token_signed_by_another_key() {
        let (k, _) = keys();
        let (_, other_public) = keys();
        assert_eq!(verify(&sign(&k, &ent()), &other_public, "dev_a", NOW), Err(EntitlementError::BadSignature));
    }

    #[test]
    fn rejects_a_tampered_payload() {
        let (k, p) = keys();
        let token = sign(&k, &ent());
        let sig = token.split_once('.').unwrap().1;
        let forged = Entitlement { license_expires_at: NOW + 3650 * DAY, ..ent() };
        let forged = format!("{}.{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap()), sig);
        assert_eq!(verify(&forged, &p, "dev_a", NOW), Err(EntitlementError::BadSignature));
    }

    #[test]
    fn rejects_a_token_copied_to_a_second_device() {
        let (k, p) = keys();
        assert_eq!(verify(&sign(&k, &ent()), &p, "dev_b", NOW), Err(EntitlementError::WrongDevice));
    }

    #[test]
    fn grace_period_ends_after_seven_days() {
        let (k, p) = keys();
        let t = sign(&k, &ent());
        assert!(verify(&t, &p, "dev_a", NOW + 7 * DAY).is_ok());
        assert_eq!(verify(&t, &p, "dev_a", NOW + 7 * DAY + 1), Err(EntitlementError::GraceExpired));
    }

    #[test]
    fn offline_use_never_outlives_the_license() {
        let (k, p) = keys();
        let e = Entitlement { license_expires_at: NOW + 2 * DAY, ..ent() };
        let t = sign(&k, &e);
        assert_eq!(e.grace_until(), NOW + 2 * DAY);
        assert!(verify(&t, &p, "dev_a", NOW + DAY).is_ok());
        assert_eq!(verify(&t, &p, "dev_a", NOW + 2 * DAY), Err(EntitlementError::LicenseExpired));
    }

    #[test]
    fn rejects_a_clock_set_back_before_the_last_check() {
        let (k, p) = keys();
        let t = sign(&k, &ent());
        assert!(verify(&t, &p, "dev_a", NOW - 60).is_ok(), "small skew is tolerated");
        assert_eq!(verify(&t, &p, "dev_a", NOW - DAY), Err(EntitlementError::ClockRolledBack));
    }

    #[test]
    fn rejects_garbage() {
        let (_, p) = keys();
        for bad in ["", "abc", "a.b", "!!!.???"] {
            assert_eq!(verify(bad, &p, "dev_a", NOW), Err(EntitlementError::Malformed), "{bad:?}");
        }
    }
}
