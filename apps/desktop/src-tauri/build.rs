// The runtime's own address rules (url + std only), so a build-time default
// the app would refuse fails the build instead of being silently ignored.
#[allow(dead_code)]
#[path = "src/origin.rs"]
mod origin;

/// Fails the build early on a `BACKROOM_APP_URL` that the app's address rules
/// refuse (the runtime would ignore it and show the setup page).
fn validate_app_url() {
    println!("cargo:rerun-if-env-changed=BACKROOM_APP_URL");
    println!("cargo:rerun-if-changed=src/origin.rs");
    if let Ok(raw) = std::env::var("BACKROOM_APP_URL") {
        if let Err(e) = origin::check_origin(&raw) {
            panic!("BACKROOM_APP_URL is refused by the app's address rules: {e}");
        }
    }
}

fn main() {
    validate_app_url();
    // The app manifest makes Tauri generate `allow-<command>` / `deny-<command>`
    // permissions for our own commands. The runtime `remote-app` capability
    // grants the first five to the main window on the server origin; the static
    // `capabilities/setup-page.json` grants `check_server` / `save_server` to
    // the bundled setup page only. Without a permission a command is not
    // callable at all.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "notify",
            "set_badge",
            "platform",
            "login_challenge",
            "take_pending_navigation",
            "check_server",
            "save_server",
        ]),
    ))
    .expect("failed to run tauri-build");
}
