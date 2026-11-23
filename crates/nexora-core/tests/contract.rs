//! Contract test with the license server.
//!
//! `backend/test/fixtures/entitlement.json` holds a token signed by the server's real signing code
//! (with a test-only key). The backend asserts it still produces that exact token; this test asserts
//! the client's verifier accepts it. A format change on either side breaks one of the two.

use base64::{engine::general_purpose::STANDARD, Engine};
use nexora_core::{verify, EntitlementError};
use serde_json::Value;

fn fixture() -> (String, [u8; 32], Value) {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../backend/test/fixtures/entitlement.json");
    let f: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("fixture file")).expect("fixture JSON");
    let key: [u8; 32] = STANDARD.decode(f["public_key"].as_str().unwrap()).unwrap().try_into().unwrap();
    (f["token"].as_str().unwrap().to_owned(), key, f["payload"].clone())
}

#[test]
fn accepts_a_token_signed_by_the_server() {
    let (token, key, payload) = fixture();
    let device = payload["device_id"].as_str().unwrap();
    let issued = payload["issued_at"].as_i64().unwrap();

    let ent = verify(&token, &key, device, issued + 3600).expect("server token verifies on the client");
    assert_eq!(ent.license_id, payload["license_id"].as_str().unwrap());
    assert_eq!(ent.plan, "professional");
    assert_eq!(ent.license_expires_at, payload["license_expires_at"].as_i64().unwrap());
    assert_eq!(ent.grace_until(), issued + 7 * 86_400);
}

#[test]
fn applies_the_same_rules_to_a_server_token() {
    let (token, key, payload) = fixture();
    let device = payload["device_id"].as_str().unwrap();
    let issued = payload["issued_at"].as_i64().unwrap();

    assert_eq!(verify(&token, &key, "another-device", issued), Err(EntitlementError::WrongDevice));
    assert_eq!(verify(&token, &key, device, issued + 8 * 86_400), Err(EntitlementError::GraceExpired));
    assert_eq!(verify(&token, &[7u8; 32], device, issued), Err(EntitlementError::BadSignature));
}
