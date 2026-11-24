//! Nexora AI native shell.
//!
//! The UI never talks to the OS directly: everything goes through the typed commands below.
//! Business rules live in `nexora-core`; this file only wires them to Tauri and the OS.

mod files;
mod secure;

use base64::{engine::general_purpose::STANDARD, Engine};
use nexora_core::{entitlement, Store};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Names the UI may read or write in the secure store. Anything else is refused.
const UI_SECRETS: &[&str] = &["session"];
const ENTITLEMENT: &str = "entitlement";
const DEVICE_ID: &str = "device-id";
/// Cache keys starting with `_` are device bookkeeping and are not reachable from the UI.
const DEVICE_ID_FALLBACK: &str = "_device_id";
const ENTITLEMENT_FALLBACK: &str = "_entitlement";

/// Set once the UI has loaded and made its first call into the shell.
static UI_READY: AtomicBool = AtomicBool::new(false);

struct Core {
    store: Mutex<Store>,
    device_id: String,
}

type CmdResult<T> = Result<T, String>;

fn with_store<T>(core: &Core, f: impl FnOnce(&mut Store) -> Result<T, nexora_core::StoreError>) -> CmdResult<T> {
    let mut store = core.store.lock().map_err(|_| "Local storage is unavailable.".to_string())?;
    f(&mut store).map_err(|e| e.to_string())
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Where the desktop apps look for a newer release: the manifest the release workflow attaches
/// to the latest GitHub release.
#[cfg(desktop)]
const UPDATE_MANIFEST: &str = "https://github.com/Mostafijemon24/Nexora-AI/releases/latest/download/latest.json";

/// The license server's public key, baked in at build time. Without it no token verifies.
fn license_public_key() -> Option<[u8; 32]> {
    let raw = option_env!("NEXORA_LICENSE_PUBLIC_KEY")?;
    STANDARD.decode(raw.trim()).ok()?.try_into().ok()
}

/// The key that update packages are verified against, baked in at build time. A build without
/// it never looks for updates.
fn updater_public_key() -> Option<&'static str> {
    option_env!("NEXORA_UPDATER_PUBKEY").map(str::trim).filter(|k| !k.is_empty())
}

/// A random registration id, created once per install. It identifies this install to the
/// license server without collecting hardware or personal data; the server decides what
/// it is entitled to.
fn load_device_id(store: &Store) -> String {
    if let Ok(Some(id)) = secure::get(DEVICE_ID) {
        return id;
    }
    if let Ok(Some(id)) = store.cache_get(DEVICE_ID_FALLBACK) {
        return id;
    }
    let id = uuid::Uuid::new_v4().to_string();
    // Prefer the secure store; fall back to the app-private database where there is none.
    if secure::set(DEVICE_ID, &id).is_err() {
        let _ = store.cache_put(DEVICE_ID_FALLBACK, &id);
    }
    id
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    id: String,
    name: String,
    os: String,
    platform: &'static str,
    app_version: String,
}

#[cfg(desktop)]
fn os_label() -> String {
    let info = os_info::get();
    let name = match info.os_type() {
        os_info::Type::Macos => "macOS".to_string(),
        other => other.to_string(),
    };
    match info.version() {
        os_info::Version::Unknown => name,
        v => format!("{name} {v}"),
    }
}

#[cfg(mobile)]
fn os_label() -> String {
    "Android".to_string()
}

#[tauri::command]
fn device_info(app: tauri::AppHandle, core: State<Core>) -> DeviceInfo {
    UI_READY.store(true, Ordering::Relaxed);
    let platform = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "android" => "android",
        _ => "linux",
    };
    let host = gethostname::gethostname().to_string_lossy().trim().to_string();
    DeviceInfo {
        id: core.device_id.clone(),
        name: if host.is_empty() || host == "localhost" { "This device".into() } else { host.to_uppercase() },
        os: os_label(),
        platform,
        app_version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn entitlement_save(core: State<Core>, token: String) -> CmdResult<()> {
    if secure::set(ENTITLEMENT, &token).is_ok() {
        return Ok(());
    }
    // The token is signed and bound to this device, so it stays tamper-evident outside the keystore.
    with_store(&core, |s| s.cache_put(ENTITLEMENT_FALLBACK, &token))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntitlementStatus {
    valid: bool,
    /// ISO-8601 instant until which offline use is allowed.
    grace_until: Option<String>,
    reason: Option<String>,
}

fn iso(secs: i64) -> String {
    // Minimal UTC formatter (civil-from-days), avoiding a date-time dependency.
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[tauri::command]
fn entitlement_status(core: State<Core>) -> CmdResult<EntitlementStatus> {
    let invalid = |reason: &str| EntitlementStatus { valid: false, grace_until: None, reason: Some(reason.to_string()) };
    let token = match secure::get(ENTITLEMENT).ok().flatten() {
        Some(t) => Some(t),
        None => with_store(&core, |s| s.cache_get(ENTITLEMENT_FALLBACK))?,
    };
    let Some(token) = token else {
        return Ok(invalid("This device has no license token."));
    };
    let Some(key) = license_public_key() else {
        return Ok(invalid("This build has no license public key."));
    };
    Ok(match entitlement::verify(&token, &key, &core.device_id, now()) {
        Ok(ent) => EntitlementStatus { valid: true, grace_until: Some(iso(ent.grace_until())), reason: None },
        Err(e) => invalid(&e.to_string()),
    })
}

#[tauri::command]
fn entitlement_clear(core: State<Core>) -> CmdResult<()> {
    secure::delete(ENTITLEMENT)?;
    with_store(&core, |s| s.cache_delete(ENTITLEMENT_FALLBACK))
}

#[tauri::command]
fn queue_push(core: State<Core>, change: serde_json::Value) -> CmdResult<()> {
    with_store(&core, |s| s.queue_push(&change).map(|_| ()))
}

#[tauri::command]
fn queue_all(core: State<Core>) -> CmdResult<Vec<serde_json::Value>> {
    with_store(&core, |s| s.queue_all())
}

#[tauri::command]
fn queue_remove(core: State<Core>, ids: Vec<String>) -> CmdResult<()> {
    with_store(&core, |s| s.queue_remove(&ids))
}

#[tauri::command]
fn queue_len(core: State<Core>) -> CmdResult<u32> {
    with_store(&core, |s| s.queue_len())
}

fn ui_cache_key(key: &str) -> CmdResult<()> {
    if key.is_empty() || key.starts_with('_') { Err("That cache key is reserved.".into()) } else { Ok(()) }
}

#[tauri::command]
fn cache_put(core: State<Core>, key: String, value: String) -> CmdResult<()> {
    ui_cache_key(&key)?;
    with_store(&core, |s| s.cache_put(&key, &value))
}

#[tauri::command]
fn cache_get(core: State<Core>, key: String) -> CmdResult<Option<String>> {
    ui_cache_key(&key)?;
    with_store(&core, |s| s.cache_get(&key))
}

#[tauri::command]
fn cache_clear(core: State<Core>) -> CmdResult<()> {
    with_store(&core, |s| s.cache_clear())
}

fn ui_secret(name: &str) -> CmdResult<()> {
    if UI_SECRETS.contains(&name) { Ok(()) } else { Err("That secret is not available to the app UI.".into()) }
}

#[tauri::command]
fn secret_set(name: String, value: String) -> CmdResult<()> {
    ui_secret(&name)?;
    secure::set(&name, &value)
}

#[tauri::command]
fn secret_get(name: String) -> CmdResult<Option<String>> {
    ui_secret(&name)?;
    secure::get(&name)
}

#[tauri::command]
fn secret_delete(name: String) -> CmdResult<()> {
    ui_secret(&name)?;
    secure::delete(&name)
}

/// Start-up check used by CI on every desktop platform: with `NEXORA_SMOKE_TEST=1` the app quits
/// by itself, with exit code 0 once the window's UI has loaded, called into the shell and stayed
/// up for 15 seconds, or with 1 if the UI never arrived.
#[cfg(desktop)]
fn smoke_test(app: tauri::AppHandle) {
    use std::time::{Duration, Instant};
    std::thread::spawn(move || {
        let started = Instant::now();
        while !UI_READY.load(Ordering::Relaxed) {
            if started.elapsed() > Duration::from_secs(90) {
                eprintln!("smoke test: the UI did not load within 90 seconds");
                std::process::exit(1);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        println!("smoke test: UI ready after {} ms", started.elapsed().as_millis());
        std::thread::sleep(Duration::from_secs(15));
        if app.webview_windows().is_empty() {
            eprintln!("smoke test: the window closed during the test");
            std::process::exit(1);
        }
        println!("smoke test: still running after 15 seconds");
        app.exit(0);
    });
}

/// Saves an export (CSV, backup) to the user's Downloads folder and returns where it went.
#[tauri::command]
fn save_file(app: tauri::AppHandle, name: String, contents: String) -> CmdResult<String> {
    let name = files::safe_file_name(&name);
    let downloads = app.path().download_dir().map_err(|e| e.to_string());
    let written = downloads.and_then(|dir| files::write_new(&dir, &name, &contents).map_err(|e| e.to_string()));
    let path = match written {
        Ok(path) => path,
        // No Downloads folder, or it is not writable (some phones): keep the file with the app's documents.
        Err(_) => {
            let dir = app.path().document_dir().or_else(|_| app.path().app_data_dir()).map_err(|e| e.to_string())?;
            files::write_new(&dir, &name, &contents).map_err(|e| format!("The file could not be saved: {e}"))?
        }
    };
    Ok(path.to_string_lossy().into_owned())
}

/// Only https, so the UI cannot be used to launch local files or other programs.
fn external_url(raw: &str) -> CmdResult<tauri::Url> {
    let url = tauri::Url::parse(raw.trim()).map_err(|_| "That is not a valid web address.".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("Only https:// addresses can be opened.".into());
    }
    Ok(url)
}

/// Opens a web address in the default browser.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> CmdResult<()> {
    let url = external_url(&url)?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[cfg(desktop)]
async fn find_update(app: &tauri::AppHandle) -> CmdResult<Option<tauri_plugin_updater::Update>> {
    use tauri_plugin_updater::UpdaterExt;
    let Some(key) = updater_public_key() else {
        return Ok(None);
    };
    let endpoint = tauri::Url::parse(UPDATE_MANIFEST).map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .pubkey(key)
        .endpoints(vec![endpoint])
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// The newer release, if there is one. Always `None` in a build without an updater key and on
/// Android, where the store delivers updates.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> CmdResult<Option<UpdateInfo>> {
    #[cfg(desktop)]
    {
        Ok(find_update(&app).await?.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() }))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(None)
    }
}

/// Downloads the newer release, checks its signature, installs it and restarts the app.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> CmdResult<()> {
    #[cfg(desktop)]
    {
        let Some(update) = find_update(&app).await? else {
            return Err("This is already the latest version.".into());
        };
        update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        app.restart();
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("Updates are delivered by the app store on this device.".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Registered on every desktop build; it only ever runs when an updater key was baked in.
            #[cfg(desktop)]
            {
                let mut updater = tauri_plugin_updater::Builder::new();
                if let Some(key) = updater_public_key() {
                    updater = updater.pubkey(key);
                }
                app.handle().plugin(updater.build())?;
            }
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("nexora.db"))?;
            let device_id = load_device_id(&store);
            app.manage(Core { store: Mutex::new(store), device_id });
            #[cfg(desktop)]
            if std::env::var_os("NEXORA_SMOKE_TEST").is_some_and(|v| v == "1") {
                smoke_test(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            device_info,
            entitlement_save,
            entitlement_status,
            entitlement_clear,
            queue_push,
            queue_all,
            queue_remove,
            queue_len,
            cache_put,
            cache_get,
            cache_clear,
            secret_set,
            secret_get,
            secret_delete,
            save_file,
            open_external,
            update_check,
            update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexora AI");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_unix_seconds_as_utc() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_795_392_000), "2026-11-23T00:00:00Z");
        assert_eq!(iso(951_782_399), "2000-02-28T23:59:59Z");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn only_https_addresses_are_opened() {
        assert!(external_url("https://www.linkedin.com/oauth/v2/authorization?x=1").is_ok());
        assert!(external_url("  https://example.com  ").is_ok());
        assert!(external_url("http://example.com").is_err());
        assert!(external_url("file:///etc/passwd").is_err());
        assert!(external_url("javascript:alert(1)").is_err());
        assert!(external_url("C:\\Windows\\notepad.exe").is_err());
        assert!(external_url("not a url").is_err());
    }

    #[test]
    fn ui_cannot_reach_reserved_keys_or_other_secrets() {
        assert!(ui_cache_key("workspace").is_ok());
        assert!(ui_cache_key("_device_id").is_err());
        assert!(ui_cache_key("").is_err());
        assert!(ui_secret("session").is_ok());
        assert!(ui_secret("entitlement").is_err());
        assert!(ui_secret("device-id").is_err());
    }
}
