fn main() {
    // The license server's Ed25519 public key (base64, 32 bytes) is baked in at build time.
    println!("cargo:rerun-if-env-changed=NEXORA_LICENSE_PUBLIC_KEY");
    // The public key update packages are signed against. Without it the app never looks for updates.
    println!("cargo:rerun-if-env-changed=NEXORA_UPDATER_PUBKEY");
    tauri_build::build()
}
