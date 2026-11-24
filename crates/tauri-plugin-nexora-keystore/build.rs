fn main() {
    // No commands are exposed to the web UI: the plugin is only called from the app's Rust code.
    tauri_plugin::Builder::new(&[]).android_path("android").build();
}
