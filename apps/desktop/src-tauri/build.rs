/// Fails the build early on a bad `BACKROOM_APP_URL` (it must parse and be http/https).
fn validate_app_url() {
    println!("cargo:rerun-if-env-changed=BACKROOM_APP_URL");
    if let Ok(raw) = std::env::var("BACKROOM_APP_URL") {
        match url::Url::parse(&raw) {
            Ok(u) if matches!(u.scheme(), "http" | "https") => {}
            _ => panic!("BACKROOM_APP_URL must be a valid http:// or https:// URL"),
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
