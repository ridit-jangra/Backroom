fn main() {
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
