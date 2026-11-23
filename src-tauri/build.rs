fn main() {
    // The license server's Ed25519 public key (base64, 32 bytes) is baked in at build time.
    println!("cargo:rerun-if-env-changed=NEXORA_LICENSE_PUBLIC_KEY");
    tauri_build::build()
}
