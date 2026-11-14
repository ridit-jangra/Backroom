//! Commands the remote app page may call (through `apps/web/src/desktop/bridge.ts`),
//! and the runtime capability that grants exactly them to the main window on
//! the app origin. Arguments are validated by `policy`; nothing here logs
//! titles, bodies or secrets.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Runtime, State, Url, Webview};
use tauri_plugin_notification::NotificationExt;

use crate::auth::VerifierStore;
use crate::{policy, tray, MAIN_WINDOW};

/// Identifier of the runtime capability for the remote app page.
pub const CAPABILITY_ID: &str = "remote-app";

/// Key in the notification's extra payload that carries the channel id.
pub const NOTIFY_CHANNEL_KEY: &str = "channelId";

/// Permissions the remote page gets: event listening plus our five commands
/// (the `allow-*` permissions are generated from the app manifest in build.rs).
pub const REMOTE_PERMISSIONS: [&str; 7] = [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "allow-notify",
    "allow-set-badge",
    "allow-platform",
    "allow-login-challenge",
    "allow-take-pending-navigation",
];

/// How long a channel link waits for the page to pull it.
pub const PENDING_NAV_TTL: Duration = Duration::from_secs(60);

/// Managed state: the last `backroom://channel/<id>` link (P5-R9). One slot;
/// a newer link replaces an older one; it expires after [`PENDING_NAV_TTL`].
///
/// Delivery rule: every channel link is stored here *and* emitted live as
/// `backroom://navigate`. The page pulls once right after subscribing (this
/// covers a cold start, when nobody listened to the emit) and drains the slot
/// whenever a live event arrives (so a later remount does not replay it). A
/// link seen on both paths only opens the same channel twice, which is
/// idempotent.
#[derive(Default)]
pub struct PendingNavigation(Mutex<Option<(String, Instant)>>);

impl PendingNavigation {
    pub fn store(&self, channel_id: &str) {
        self.store_at(channel_id, Instant::now());
    }

    /// Stores a valid channel id (a ULID); anything else is ignored.
    pub fn store_at(&self, channel_id: &str, now: Instant) {
        if policy::is_ulid(channel_id) {
            *self.slot() = Some((channel_id.to_string(), now));
        }
    }

    pub fn take(&self) -> Option<String> {
        self.take_at(Instant::now())
    }

    /// Empties the slot; returns the id only if it is still fresh.
    pub fn take_at(&self, now: Instant) -> Option<String> {
        self.slot()
            .take()
            .filter(|(_, at)| now.saturating_duration_since(*at) < PENDING_NAV_TTL)
            .map(|(id, _)| id)
            .filter(|id| policy::is_ulid(id))
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<(String, Instant)>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

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

/// The pending channel id, at most once (see [`PendingNavigation`]).
#[tauri::command]
pub fn take_pending_navigation<R: Runtime>(
    webview: Webview<R>,
    pending: State<'_, PendingNavigation>,
) -> Result<Option<String>, String> {
    require_main(&webview)?;
    Ok(pending.take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::RuntimeCapability;
    use tauri::utils::acl::capability::CapabilityFile;

    fn origin() -> Url {
        policy::app_origin("http://localhost:8787").unwrap()
    }

    // ---- pending navigation (P5-R9) ----

    const ULID: &str = "01HZX3K7Q9M2N4P6R8T0V2W4Y6";
    const ULID2: &str = "01HZX3K7Q9M2N4P6R8T0V2W4Y7";

    #[test]
    fn pending_navigation_is_taken_at_most_once() {
        let pending = PendingNavigation::default();
        let t0 = Instant::now();
        assert_eq!(pending.take_at(t0), None, "empty at start");
        pending.store_at(ULID, t0);
        assert_eq!(pending.take_at(t0), Some(ULID.to_string()));
        assert_eq!(pending.take_at(t0), None, "second take finds nothing");
    }

    #[test]
    fn pending_navigation_expires_after_the_ttl() {
        assert_eq!(PENDING_NAV_TTL, Duration::from_secs(60));
        let pending = PendingNavigation::default();
        let t0 = Instant::now();
        pending.store_at(ULID, t0);
        assert_eq!(
            pending.take_at(t0 + Duration::from_secs(59)),
            Some(ULID.to_string())
        );
        pending.store_at(ULID, t0);
        assert_eq!(pending.take_at(t0 + PENDING_NAV_TTL), None, "expired");
        assert_eq!(
            pending.take_at(t0),
            None,
            "an expired take still clears the slot"
        );
    }

    #[test]
    fn newer_pending_link_replaces_the_older_one() {
        let pending = PendingNavigation::default();
        let t0 = Instant::now();
        pending.store_at(ULID, t0);
        pending.store_at(ULID2, t0 + Duration::from_secs(1));
        assert_eq!(
            pending.take_at(t0 + Duration::from_secs(1)),
            Some(ULID2.to_string())
        );
        assert_eq!(pending.take_at(t0 + Duration::from_secs(1)), None);
    }

    #[test]
    fn pending_navigation_stores_only_ulids() {
        let pending = PendingNavigation::default();
        let t0 = Instant::now();
        pending.store_at(ULID, t0);
        for bad in [
            "",
            "nope",
            "../../x",
            "01HZX3K7Q9M2N4P6R8T0V2W4Y",
            &ULID.to_lowercase(),
        ] {
            pending.store_at(bad, t0);
        }
        assert_eq!(
            pending.take_at(t0),
            Some(ULID.to_string()),
            "invalid ids never replace a valid one"
        );
    }

    #[test]
    fn generated_permissions_match_the_granted_app_commands() {
        // Drift guard: tauri-build never prunes stale files, so the committed
        // autogenerated set must equal exactly the app commands we grant.
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("permissions/autogenerated");
        let mut generated: Vec<String> = std::fs::read_dir(&dir)
            .expect("autogenerated permissions dir")
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "toml"))
            .map(|p| {
                let stem = p.file_stem().unwrap().to_string_lossy().replace('_', "-");
                format!("allow-{stem}")
            })
            .collect();
        generated.sort();
        let mut granted: Vec<String> = REMOTE_PERMISSIONS
            .iter()
            .filter(|p| !p.starts_with("core:"))
            .map(|p| p.to_string())
            .collect();
        granted.sort();
        assert_eq!(generated, granted);
    }

    #[test]
    fn remote_permissions_grant_take_pending_navigation() {
        assert!(REMOTE_PERMISSIONS.contains(&"allow-take-pending-navigation"));
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
