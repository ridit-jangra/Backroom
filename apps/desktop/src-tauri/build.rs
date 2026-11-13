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
    // permissions for our own commands, which the runtime `remote-app`
    // capability grants to the main window. Without a permission an app command
    // is not callable at all.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "notify",
            "set_badge",
            "platform",
            "login_challenge",
        ]),
    ))
    .expect("failed to run tauri-build");
}
