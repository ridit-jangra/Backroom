//! Commands the remote app page may call (through `apps/web/src/desktop/bridge.ts`),
//! and the runtime capability that grants exactly them to the main window on
//! the app origin. Arguments are validated by `policy`; nothing here logs
//! titles, bodies or secrets.

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Runtime, State, Url, Webview};
use tauri_plugin_notification::NotificationExt;

use crate::auth::VerifierStore;
use crate::{policy, tray, MAIN_WINDOW};

/// Identifier of the runtime capability for the remote app page.
pub const CAPABILITY_ID: &str = "remote-app";

/// Key in the notification's extra payload that carries the channel id.
pub const NOTIFY_CHANNEL_KEY: &str = "channelId";

/// Permissions the remote page gets: event listening plus our four commands
/// (the `allow-*` permissions are generated from the app manifest in build.rs).
pub const REMOTE_PERMISSIONS: [&str; 6] = [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "allow-notify",
    "allow-set-badge",
    "allow-platform",
    "allow-login-challenge",
];

/// `remote-app`: window "main" only, remote URLs `<origin>/*` only, never local.
/// Viewer windows match no capability, so they have no IPC at all.
pub fn remote_capability(origin: &Url) -> CapabilityBuilder {
    let pattern = format!("{}/*", origin.as_str().trim_end_matches('/'));
    REMOTE_PERMISSIONS.iter().fold(
        CapabilityBuilder::new(CAPABILITY_ID)
            .remote(pattern)
            .local(false)
            .windows([MAIN_WINDOW]),
        |cap, permission| cap.permission(*permission),
    )
}

/// Defense in depth on top of the capability: only the main webview may call.
pub(crate) fn require_main<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() == MAIN_WINDOW {
        Ok(())
    } else {
        Err("forbidden".into())
    }
}

#[tauri::command]
pub fn notify<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    title: String,
    body: String,
    channel_id: String,
) -> Result<(), String> {
    require_main(&webview)?;
    let (title, body, channel_id) = policy::validate_notify(&title, &body, &channel_id)
        .map_err(|_| "invalid_arguments".to_string())?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .extra(NOTIFY_CHANNEL_KEY, channel_id)
        .show()
        .map_err(|_| "notification_failed".to_string())
}

#[tauri::command]
pub fn set_badge<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    count: i64,
) -> Result<(), String> {
    require_main(&webview)?;
    let count = policy::clamp_badge(count);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        // Unsupported on some desktops (and on Windows): ignore.
        let _ = window.set_badge_count((count > 0).then_some(count));
    }
    tray::set_unread(&app, count);
    Ok(())
}

#[tauri::command]
pub fn platform<R: Runtime>(webview: Webview<R>) -> Result<String, String> {
    require_main(&webview)?;
    Ok(std::env::consts::OS.to_string())
}

#[tauri::command]
pub fn login_challenge<R: Runtime>(
    webview: Webview<R>,
    store: State<'_, VerifierStore>,
) -> Result<String, String> {
    require_main(&webview)?;
    Ok(store.login_challenge())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::RuntimeCapability;
    use tauri::utils::acl::capability::CapabilityFile;

    fn origin() -> Url {
        policy::app_origin("http://localhost:8787").unwrap()
    }

    #[test]
    fn capability_is_main_window_on_the_app_origin_only() {
        let CapabilityFile::Capability(cap) = remote_capability(&origin()).build() else {
            panic!("expected a single capability");
        };
        assert_eq!(cap.identifier, "remote-app");
        assert_eq!(cap.windows, vec!["main".to_string()]);
        assert!(cap.webviews.is_empty());
        assert!(!cap.local);
        let urls: Vec<&str> = cap
            .remote
            .as_ref()
            .expect("remote")
            .urls
            .iter()
            .map(|u| u.as_str())
            .collect();
        assert_eq!(urls, vec!["http://localhost:8787/*"]);
        let perms: Vec<String> = cap
            .permissions
            .iter()
            .map(|p| p.identifier().get().to_string())
            .collect();
        assert_eq!(perms, REMOTE_PERMISSIONS.map(String::from).to_vec());
    }

    #[test]
    fn capability_url_pattern_matches_only_the_app_origin() {
        let CapabilityFile::Capability(cap) = remote_capability(&origin()).build() else {
            panic!("expected a single capability");
        };
        let pattern: tauri::utils::acl::RemoteUrlPattern =
            cap.remote.unwrap().urls[0].parse().unwrap();
        for ok in [
            "http://localhost:8787/",
            "http://localhost:8787/client/abc?x=1#m",
            "http://localhost:8787/desktop-auth",
        ] {
            assert!(pattern.test(&Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in [
            "http://localhost:8788/",
            "https://localhost:8787/",
            "http://127.0.0.1:8787/",
            "http://localhost.evil.com:8787/",
            "http://evil.com/http://localhost:8787/",
        ] {
            assert!(!pattern.test(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn capability_resolves_against_the_generated_acl() {
        // Real context (our build.rs app manifest + plugin manifests) on the mock
        // runtime: add_capability fails if any permission id is unknown.
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_notification::init())
            .build(tauri::generate_context!())
            .expect("mock app");
        app.add_capability(remote_capability(&origin()))
            .expect("every permission resolves");
        let https = policy::app_origin("https://chat.example.com").unwrap();
        let CapabilityFile::Capability(cap) = remote_capability(&https).build() else {
            panic!("expected a single capability");
        };
        assert_eq!(
            cap.remote.unwrap().urls[0].as_str(),
            "https://chat.example.com/*"
        );
    }
}
