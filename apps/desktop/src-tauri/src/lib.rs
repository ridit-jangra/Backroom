pub mod auth;
pub mod commands;
pub mod policy;
pub mod tray;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use auth::VerifierStore;
use policy::{DeepLink, ExternalOpenLimiter, Nav};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, Url, Webview, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// Build-time app URL (`BACKROOM_APP_URL`), default for local development.
const APP_URL: &str = match option_env!("BACKROOM_APP_URL") {
    Some(url) => url,
    None => "http://localhost:8787",
};

pub const MAIN_WINDOW: &str = "main";
/// Event the web app listens to (bridge.ts `NAVIGATE_EVENT`), payload `{ channelId }`.
pub const NAVIGATE_EVENT: &str = "backroom://navigate";
/// Label prefix of the in-app file viewer windows (`viewer-<n>`).
pub const VIEWER_PREFIX: &str = "viewer-";

static VIEWER_SEQ: AtomicU32 = AtomicU32::new(1);

/// Managed state: limits how often a page can open viewer windows (1/sec).
#[derive(Default)]
struct ViewerOpenLimiter(Mutex<ExternalOpenLimiter>);

/// Managed state: limits how often links go to the default browser (1/sec).
#[derive(Default)]
struct ExternalLimiter(Mutex<ExternalOpenLimiter>);

/// What an incoming `backroom://` link should do.
#[derive(Debug, PartialEq, Eq)]
enum DeepLinkAction {
    /// Auth link with a pending verifier: load this URL in the main window.
    NavigateMain(Url),
    /// Auth link but no pending verifier (or it expired): ignore.
    NoVerifier,
    /// Channel link: ask the page to open this channel.
    EmitNavigate(String),
    /// Anything else: ignore.
    Ignore,
}

/// Pure routing decision; the verifier is taken only for a valid auth link.
fn deep_link_action(
    raw: &str,
    origin: &Url,
    take_verifier: impl FnOnce() -> Option<String>,
) -> DeepLinkAction {
    match policy::parse_deep_link(raw) {
        Some(DeepLink::Auth { code }) => match take_verifier() {
            Some(verifier) => {
                DeepLinkAction::NavigateMain(policy::desktop_auth_url(origin, &code, &verifier))
            }
            None => DeepLinkAction::NoVerifier,
        },
        Some(DeepLink::Channel { id }) => DeepLinkAction::EmitNavigate(id),
        None => DeepLinkAction::Ignore,
    }
}

pub fn run() {
    tauri::Builder::default()
        // Registered first: a second launch hands its argv to this instance and
        // exits before anything else starts. With the `deep-link` feature the
        // plugin forwards argv to the deep-link plugin before this callback, and
        // its `deep-link://new-url` event reaches `handle_deep_link`.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(VerifierStore::default())
        .manage(ExternalLimiter::default())
        .manage(ViewerOpenLimiter::default())
        .invoke_handler(tauri::generate_handler![
            commands::notify,
            commands::set_badge,
            commands::platform,
            commands::login_challenge
        ])
        .setup(|app| {
            let origin = policy::app_origin(APP_URL)?;
            app.add_capability(commands::remote_capability(&origin))?;
            let handle = app.handle().clone();
            build_main_window(&handle, &origin)?;
            tray::build(&handle)?;
            setup_notification_clicks(&handle);
            setup_deep_links(&handle, origin);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Backroom");
}

/// Shows, restores and focuses the main window.
pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_main_window<R: Runtime>(app: &AppHandle<R>, origin: &Url) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(origin.clone()))
        .title("Backroom")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 560.0)
        // On WebKitGTK the download handler lives on the shared web context, so
        // this one also covers downloads started in viewer windows.
        .on_download(download_handler(app.clone()));
    let window = lock_down(builder, app, origin).build()?;

    // Closing hides to the tray; the tray's Quit exits.
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hide.hide();
        }
    });
    Ok(())
}

/// Navigation lockdown shared by the main and viewer windows: only the app
/// origin loads in-app; other http(s) goes to the default browser; everything
/// else is dropped. Same-origin new-window requests open an in-app viewer.
///
/// Tauri's `on_navigation` hook receives only the URL (no frame information),
/// so cross-origin subframe navigations cannot be told apart from top-level
/// ones; the rate limit in `open_external` bounds what a frame can trigger.
fn lock_down<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    app: &AppHandle<R>,
    origin: &Url,
) -> WebviewWindowBuilder<'a, R, M> {
    let nav_app = app.clone();
    let nav_origin = origin.clone();
    let new_window_app = app.clone();
    let new_window_origin = origin.clone();
    builder
        .on_navigation(move |url| match policy::nav_decision(url, &nav_origin) {
            Nav::Allow => true,
            Nav::OpenExternal => {
                open_external(&nav_app, url);
                false
            }
            Nav::Drop => false,
        })
        .on_new_window(move |url, _features| {
            match policy::nav_decision(&url, &new_window_origin) {
                Nav::Allow => open_viewer(&new_window_app, &new_window_origin, url),
                Nav::OpenExternal => open_external(&new_window_app, &url),
                Nav::Drop => {}
            }
            // Never the webview's own popup: viewers are built by us, without
            // an opener link to the page that asked.
            NewWindowResponse::Deny
        })
}

/// Opens a same-origin URL (e.g. a file link with target=_blank) in a new
/// `viewer-<n>` window. It shares the webview session (cookies) but matches no
/// capability, so it has no IPC.
fn open_viewer<R: Runtime>(app: &AppHandle<R>, origin: &Url, url: Url) {
    let allowed = app
        .state::<ViewerOpenLimiter>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .allow(Instant::now());
    if !allowed {
        eprintln!("backroom: viewer_open_rate_limited");
        return;
    }
    let handle = app.clone();
    let origin = origin.clone();
    // Built after the new-window callback returns, not inside it.
    let queued = app.run_on_main_thread(move || {
        let label = format!(
            "{VIEWER_PREFIX}{}",
            VIEWER_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let builder = WebviewWindowBuilder::new(&handle, label, WebviewUrl::External(url))
            .title("Backroom")
            .inner_size(1000.0, 750.0);
        // WebKitGTK: the main window's handler already covers this webview
        // (shared web context); registering again would double-handle downloads.
        #[cfg(not(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        )))]
        let builder = builder.on_download(download_handler(handle.clone()));
        if lock_down(builder, &handle, &origin).build().is_err() {
            eprintln!("backroom: viewer_window_failed");
        }
    });
    if queued.is_err() {
        eprintln!("backroom: viewer_window_failed");
    }
}

fn open_external<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    let allowed = app
        .state::<ExternalLimiter>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .allow(Instant::now());
    if !allowed {
        eprintln!("backroom: external_open_rate_limited");
        return;
    }
    // Never log the URL itself: it may carry tokens.
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        eprintln!("backroom: failed to open link in the default browser");
    }
}

/// Saves downloads into the user's Download dir under a sanitized basename,
/// never overwriting an existing file, then shows "Downloaded <name>".
fn download_handler<R: Runtime>(
    app: AppHandle<R>,
) -> impl Fn(Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    move |_webview: Webview<R>, event: DownloadEvent<'_>| match event {
        DownloadEvent::Requested { destination, .. } => {
            let Ok(dir) = app.path().download_dir() else {
                eprintln!("backroom: download_dir_unavailable");
                return false;
            };
            // The runtime pre-fills the suggested file name; keep only a safe basename.
            let suggested = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = policy::sanitize_download_name(&suggested);
            // Any existing entry (dangling symlinks included) counts as taken.
            *destination = policy::unique_download_path(&dir, &name, |p: &Path| {
                std::fs::symlink_metadata(p).is_ok()
            });
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            if success {
                let name = path
                    .as_deref()
                    .and_then(Path::file_name)
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "file".to_string());
                let shown = app
                    .notification()
                    .builder()
                    .title(format!("Downloaded {name}"))
                    .show();
                if shown.is_err() {
                    eprintln!("backroom: notification_failed");
                }
            } else {
                eprintln!("backroom: download_failed");
            }
            true
        }
        _ => true,
    }
}

/// A click on a message notification shows the main window and asks the page
/// to open the channel. Other notifications (downloads) just show the window.
fn setup_notification_clicks<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let registered = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        show_main(&handle);
        let channel_id = performed
            .notification()
            .and_then(|n| n.extra().get(commands::NOTIFY_CHANNEL_KEY))
            .and_then(|v| v.as_str())
            .filter(|id| policy::is_ulid(id));
        if let Some(id) = channel_id {
            emit_navigate(&handle, id);
        }
    });
    if registered.is_err() {
        eprintln!("backroom: notification_actions_unavailable");
    }
}

fn emit_navigate<R: Runtime>(app: &AppHandle<R>, channel_id: &str) {
    let payload = HashMap::from([("channelId", channel_id.to_string())]);
    if app.emit_to(MAIN_WINDOW, NAVIGATE_EVENT, payload).is_err() {
        eprintln!("backroom: navigate_emit_failed");
    }
}

fn setup_deep_links<R: Runtime>(app: &AppHandle<R>, origin: Url) {
    // Dev builds are not installed, so register the scheme for this binary.
    #[cfg(debug_assertions)]
    if app.deep_link().register_all().is_err() {
        eprintln!("backroom: deep_link_register_failed");
    }

    let handle = app.clone();
    let listen_origin = origin.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle_deep_link(&handle, &listen_origin, url.as_str());
        }
    });

    // A link that started this (first) instance.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            handle_deep_link(app, &origin, url.as_str());
        }
    }
}

/// Routes an accepted `backroom://` link. Never logs the link, code or verifier.
fn handle_deep_link<R: Runtime>(app: &AppHandle<R>, origin: &Url, raw: &str) {
    let action = deep_link_action(raw, origin, || app.state::<VerifierStore>().take_verifier());
    match action {
        DeepLinkAction::NavigateMain(target) => {
            show_main(app);
            let navigated = app
                .get_webview_window(MAIN_WINDOW)
                .map(|window| window.navigate(target).is_ok());
            if navigated != Some(true) {
                eprintln!("backroom: deep_link_navigate_failed");
            }
        }
        // A code with no pending login from this instance: ignore it.
        DeepLinkAction::NoVerifier => eprintln!("backroom: deep_link_no_verifier"),
        DeepLinkAction::EmitNavigate(id) => {
            show_main(app);
            emit_navigate(app, &id);
        }
        DeepLinkAction::Ignore => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::{App, Listener};

    const ULID: &str = "01HZX3K7Q9M2N4P6R8T0V2W4Y6";
    const CODE: &str = "abcDEF0123_-xyz";

    fn origin() -> Url {
        policy::app_origin("http://localhost:8787").unwrap()
    }

    /// Mock app with the verifier store and a plain "main" window on the origin.
    fn mock_app() -> App<MockRuntime> {
        let app = mock_builder()
            .manage(VerifierStore::default())
            .build(tauri::generate_context!())
            .expect("mock app");
        WebviewWindowBuilder::new(&app, MAIN_WINDOW, WebviewUrl::External(origin()))
            .build()
            .expect("main window");
        app
    }

    // ---- pure decision ----

    #[test]
    fn auth_link_with_verifier_navigates_to_desktop_auth() {
        let action = deep_link_action(&format!("backroom://auth?code={CODE}"), &origin(), || {
            Some("ver".to_string())
        });
        assert_eq!(
            action,
            DeepLinkAction::NavigateMain(
                Url::parse(&format!("http://localhost:8787/desktop-auth#code={CODE}&verifier=ver"))
                    .unwrap()
            )
        );
    }

    #[test]
    fn auth_link_without_verifier_is_ignored() {
        let action = deep_link_action(&format!("backroom://auth?code={CODE}"), &origin(), || None);
        assert_eq!(action, DeepLinkAction::NoVerifier);
    }

    #[test]
    fn invalid_links_never_take_the_verifier() {
        for raw in ["backroom://auth?code=short", "garbage", "backroom://channel/x"] {
            let action = deep_link_action(raw, &origin(), || panic!("verifier taken for {raw}"));
            assert_eq!(action, DeepLinkAction::Ignore, "{raw}");
        }
        let action = deep_link_action(&format!("backroom://channel/{ULID}"), &origin(), || {
            panic!("verifier taken for a channel link")
        });
        assert_eq!(action, DeepLinkAction::EmitNavigate(ULID.to_string()));
    }

    // ---- glue on the mock runtime ----

    #[test]
    fn auth_deep_link_navigates_main_and_consumes_the_verifier() {
        let app = mock_app();
        let handle = app.handle();
        let challenge = app.state::<VerifierStore>().login_challenge();
        assert_eq!(challenge.len(), 43);

        handle_deep_link(handle, &origin(), &format!("backroom://auth?code={CODE}"));
        let main = app.get_webview_window(MAIN_WINDOW).unwrap();
        let url = main.url().unwrap();
        assert_eq!(url.path(), "/desktop-auth");
        let fragment = url.fragment().unwrap().to_string();
        let verifier = fragment
            .strip_prefix(&format!("code={CODE}&verifier="))
            .expect("code then verifier in the fragment");
        assert_eq!(auth::challenge_for(verifier), challenge);
        assert_eq!(app.state::<VerifierStore>().take_verifier(), None, "consumed");

        // A second (replayed) auth link finds no verifier and leaves main alone.
        main.navigate(origin()).unwrap();
        handle_deep_link(handle, &origin(), &format!("backroom://auth?code={CODE}"));
        assert_eq!(main.url().unwrap(), origin());
    }

    #[test]
    fn channel_deep_link_emits_navigate_to_main() {
        let app = mock_app();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let record = Arc::clone(&seen);
        app.listen_any(NAVIGATE_EVENT, move |event| {
            record.lock().unwrap().push(event.payload().to_string());
        });
        handle_deep_link(app.handle(), &origin(), &format!("backroom://channel/{ULID}"));
        handle_deep_link(app.handle(), &origin(), "backroom://channel/nope");
        assert_eq!(
            *seen.lock().unwrap(),
            vec![format!(r#"{{"channelId":"{ULID}"}}"#)]
        );
    }

    #[test]
    fn require_main_rejects_other_windows() {
        let app = mock_app();
        let viewer = WebviewWindowBuilder::new(
            &app,
            format!("{VIEWER_PREFIX}1"),
            WebviewUrl::External(origin()),
        )
        .build()
        .unwrap();
        let main = app.get_webview_window(MAIN_WINDOW).unwrap();
        assert_eq!(commands::require_main(main.as_ref()), Ok(()));
        assert_eq!(
            commands::require_main(viewer.as_ref()),
            Err("forbidden".to_string())
        );
    }
}
