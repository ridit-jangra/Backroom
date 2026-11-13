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
        .manage(Mutex::new(ExternalOpenLimiter::default()))
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
        .state::<Mutex<ExternalOpenLimiter>>()
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
    match policy::parse_deep_link(raw) {
        Some(DeepLink::Auth { code }) => match app.state::<VerifierStore>().take_verifier() {
            Some(verifier) => {
                let target = policy::desktop_auth_url(origin, &code, &verifier);
                show_main(app);
                let navigated = app
                    .get_webview_window(MAIN_WINDOW)
                    .map(|window| window.navigate(target).is_ok());
                if navigated != Some(true) {
                    eprintln!("backroom: deep_link_navigate_failed");
                }
            }
            // A code with no pending login from this instance: ignore it.
            None => eprintln!("backroom: deep_link_no_verifier"),
        },
        Some(DeepLink::Channel { id }) => {
            show_main(app);
            emit_navigate(app, &id);
        }
        None => {}
    }
}
