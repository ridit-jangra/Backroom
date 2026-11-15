pub mod auth;
pub mod commands;
pub mod config;
pub mod origin;
pub mod policy;
pub mod tray;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use auth::VerifierStore;
use commands::PendingNavigation;
use config::{ServerState, Start, Stored};
use policy::{DeepLink, ExternalOpenLimiter, Nav};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, Url, Webview, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// Optional build-time default server (`BACKROOM_APP_URL`), used only when
/// there is no `server.json` at all (smoke tests, distro builds). Released
/// builds have none and ask on first launch (P8-R1).
const BUILD_DEFAULT_URL: Option<&str> = option_env!("BACKROOM_APP_URL");

/// The bundled setup page (`apps/desktop/dist/index.html`).
const SETUP_PAGE: &str = "index.html";

/// Set while "Change server…" clears the config and restarts, so a second
/// click cannot race it.
static CHANGING_SERVER: AtomicBool = AtomicBool::new(false);

pub const MAIN_WINDOW: &str = "main";
/// Event the web app listens to (bridge.ts `NAVIGATE_EVENT`), payload `{ channelId }`.
pub const NAVIGATE_EVENT: &str = "backroom://navigate";
/// Label prefix of the in-app file viewer windows (`viewer-<n>`).
pub const VIEWER_PREFIX: &str = "viewer-";

static VIEWER_SEQ: AtomicU32 = AtomicU32::new(1);
/// Nonce for `/desktop-auth?n=<seq>` so each auth hand-off is a fresh document
/// load, even when main already shows `/desktop-auth` (a fragment-only change
/// would not re-run the page's exchange).
static AUTH_NAV_SEQ: AtomicU32 = AtomicU32::new(1);

/// Native notification shown when an auth link arrives with no pending login
/// (an app restart, or the 20-minute verifier expired) (P5-R11).
pub const LINK_EXPIRED_NOTICE: &str = "Sign-in link expired. Request a new one from Backroom.";

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
    /// Auth link but no pending verifier (or it expired): tell the user.
    NoVerifier,
    /// Channel link: ask the page to open this channel.
    EmitNavigate(String),
    /// No server yet (the setup page is showing): ignore, keep any verifier.
    NoServer,
    /// Anything else: ignore.
    Ignore,
}

/// Pure routing decision; the verifier is taken only for a valid auth link
/// while a server origin is set.
fn deep_link_action(
    raw: &str,
    origin: Option<&Url>,
    take_verifier: impl FnOnce() -> Option<String>,
) -> DeepLinkAction {
    let Some(origin) = origin else {
        return DeepLinkAction::NoServer;
    };
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

/// True when the app was started in smoke mode (`BACKROOM_SMOKE=1`).
fn smoke_enabled() -> bool {
    std::env::var("BACKROOM_SMOKE").is_ok_and(|v| v == "1")
}

/// Single-instance D-Bus id: a smoke run gets its own per-process id, so it can
/// never hand off to (and show) a Backroom the user already has running.
/// `None` keeps the plugin default (the bundle identifier).
fn single_instance_dbus_id(smoke: bool, pid: u32) -> Option<String> {
    smoke.then(|| format!("app.backroom.desktop.Smoke_{pid}"))
}

/// A finished page load counts for the smoke check only on the app origin.
fn smoke_load_matches(loaded: &Url, origin: &Url) -> bool {
    loaded.origin() == origin.origin()
}

/// Smoke mode: print `smoke ok <origin>` and exit 0 once the main webview
/// finishes loading the app origin; exit 1 with `smoke timeout` after 30 s.
fn smoke_builder<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    app: &AppHandle<R>,
    origin: &Url,
) -> WebviewWindowBuilder<'a, R, M> {
    let timeout_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        println!("smoke timeout");
        timeout_app.exit(1);
    });
    let exit_app = app.clone();
    let origin = origin.clone();
    builder.on_page_load(move |_webview, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished
            && smoke_load_matches(payload.url(), &origin)
        {
            println!("smoke ok {}", origin.origin().ascii_serialization());
            exit_app.exit(0);
        }
    })
}

pub fn run() {
    let mut single_instance =
        tauri_plugin_single_instance::Builder::new().callback(|app: &AppHandle, _argv, _cwd| {
            show_main(app);
        });
    if let Some(id) = single_instance_dbus_id(smoke_enabled(), std::process::id()) {
        single_instance = single_instance.dbus_id(id);
    }
    tauri::Builder::default()
        // Registered first: a second launch hands its argv to this instance and
        // exits before anything else starts. With the `deep-link` feature the
        // plugin forwards argv to the deep-link plugin before this callback, and
        // its `deep-link://new-url` event reaches `handle_deep_link`.
        .plugin(single_instance.build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(VerifierStore::default())
        .manage(PendingNavigation::default())
        .manage(ExternalLimiter::default())
        .manage(ViewerOpenLimiter::default())
        // Every menu (tray, macOS app menu, the no-tray window menu bar) goes
        // through this one global handler; the tray registers none of its own.
        .on_menu_event(tray::on_menu_event)
        .invoke_handler(tauri::generate_handler![
            commands::notify,
            commands::set_badge,
            commands::platform,
            commands::login_challenge,
            commands::take_pending_navigation,
            commands::check_server,
            commands::save_server
        ])
        .setup(|app| {
            let dir = app.path().app_config_dir().ok();
            if dir.is_none() {
                eprintln!("backroom: config_dir_unavailable");
            }
            let origin = boot(app.handle(), dir, BUILD_DEFAULT_URL)?;
            let handle = app.handle().clone();
            restrict_data_dir(&handle);
            let close = tray::close_policy(tray::host_available());
            if let Some(token) = close.log {
                eprintln!("backroom: {token}");
            }
            #[cfg(target_os = "macos")]
            tray::install_app_menu(&handle)?;
            build_main_window(&handle, origin.as_ref(), close.on_close)?;
            tray::build(&handle)?;
            setup_notification_clicks(&handle);
            setup_deep_links(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Backroom");
}

/// The remote capability a start needs: one for a remote start, none for the
/// setup page. The only path from `server.json` to a capability.
fn start_capability(start: &Start) -> Option<CapabilityBuilder> {
    match start {
        Start::Remote(origin) => Some(commands::remote_capability(origin.url())),
        Start::Setup => None,
    }
}

/// Startup decision: reads `server.json` from `dir`, applies the precedence
/// (stored config, build-time default, setup page), adds the remote capability
/// only for a remote start and manages [`ServerState`]. Returns the origin, or
/// `None` for the setup page.
fn boot<R: Runtime>(
    app: &AppHandle<R>,
    dir: Option<PathBuf>,
    build_default: Option<&str>,
) -> tauri::Result<Option<Url>> {
    let stored = dir.as_deref().map_or(Stored::Missing, config::load_config);
    if stored == Stored::Invalid {
        eprintln!("backroom: server_config_invalid");
    }
    if config::build_default_refused(&stored, build_default) {
        // build.rs refuses such a default; this catches the pattern check only
        // the runtime can make.
        eprintln!("backroom: build_default_refused");
    }
    let mut start = config::resolve_start(&stored, build_default);
    if let Some(capability) = start_capability(&start) {
        // Never trust the file: if the capability cannot be added, ask again.
        if app.add_capability(capability).is_err() {
            eprintln!("backroom: server_capability_failed");
            start = Start::Setup;
        }
    }
    let origin = match start {
        Start::Remote(origin) => Some(origin.url().clone()),
        Start::Setup => {
            eprintln!("backroom: setup_page");
            None
        }
    };
    app.manage(ServerState::new(origin.clone(), dir));
    Ok(origin)
}

/// The origin this process serves right now (`None` on the setup page).
fn current_origin<R: Runtime>(app: &AppHandle<R>) -> Option<Url> {
    app.try_state::<ServerState>().and_then(|s| s.current())
}

/// "Change server…": writes the cleared config and restarts the app.
///
/// Tauri can add runtime capabilities but not remove them, and the old page,
/// its cookies-in-memory, pending verifier and pending navigation all live in
/// this process. Restarting is what revokes the old origin: the new process
/// reads `{"serverUrl": null}`, adds no remote capability and shows the setup
/// page (even when a build-time default exists). Reachable from the tray, the
/// macOS app menu and the no-tray window menu, so it works when the page does
/// not. On the setup page already it only shows the window.
pub(crate) fn change_server<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<ServerState>() else {
        return;
    };
    if state.current().is_none() {
        show_main(app);
        return;
    }
    if CHANGING_SERVER.swap(true, Ordering::SeqCst) {
        return;
    }
    if !clear_server_config(&state) {
        // Restarting now would reconnect to the old server: stay put.
        eprintln!("backroom: server_config_clear_failed");
        CHANGING_SERVER.store(false, Ordering::SeqCst);
        return;
    }
    eprintln!("backroom: server_cleared");
    app.restart();
}

/// Writes `{"serverUrl": null}` so the next start shows the setup page.
fn clear_server_config(state: &ServerState) -> bool {
    state
        .config_dir()
        .is_some_and(|dir| config::save_config(dir, None).is_ok())
}

/// Shows, restores and focuses the main window.
pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// What the main window loads: the server origin, or the bundled setup page.
fn main_url(origin: Option<&Url>) -> WebviewUrl {
    match origin {
        Some(origin) => WebviewUrl::External(origin.clone()),
        None => WebviewUrl::App(SETUP_PAGE.into()),
    }
}

fn build_main_window<R: Runtime>(
    app: &AppHandle<R>,
    origin: Option<&Url>,
    on_close: tray::CloseAction,
) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, main_url(origin))
        .title("Backroom")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 560.0)
        // On WebKitGTK the download handler lives on the shared web context, so
        // this one also covers downloads started in viewer windows.
        .on_download(download_handler(app.clone()));
    // Without a tray host "Change server…" would be unreachable when the page
    // is broken: give the main window a small menu bar instead (macOS has its
    // app menu).
    #[cfg(not(target_os = "macos"))]
    let builder = if on_close == tray::CloseAction::Quit {
        builder.menu(tray::window_menu(app)?)
    } else {
        builder
    };
    let builder = match (smoke_enabled(), origin) {
        (true, Some(origin)) => smoke_builder(builder, app, origin),
        (true, None) => {
            println!("smoke no server");
            std::process::exit(1);
        }
        (false, _) => builder,
    };
    let window = lock_down(builder, app).build()?;

    // With a tray host, closing hides to the tray (its Quit exits); without
    // one the window could never come back, so closing quits (viewers too).
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            match on_close {
                tray::CloseAction::HideToTray => {
                    api.prevent_close();
                    let _ = hide.hide();
                }
                tray::CloseAction::Quit => hide.app_handle().exit(0),
            }
        }
    });
    Ok(())
}

/// Navigation lockdown shared by the main and viewer windows: only the app
/// origin loads in-app; other http(s) goes to the default browser; everything
/// else is dropped. Same-origin new-window requests open an in-app viewer.
/// The origin is read from [`ServerState`] on every request; while the setup
/// page shows (no origin) only the app's own origin loads, nothing opens in
/// the browser and no viewer opens (see [`policy::window_nav`]).
///
/// Tauri's `on_navigation` hook receives only the URL (no frame information),
/// so cross-origin subframe navigations cannot be told apart from top-level
/// ones; the rate limit in `open_external` bounds what a frame can trigger.
fn lock_down<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    app: &AppHandle<R>,
) -> WebviewWindowBuilder<'a, R, M> {
    let nav_app = app.clone();
    let new_window_app = app.clone();
    builder
        .on_navigation(move |url| {
            match policy::window_nav(url, current_origin(&nav_app).as_ref()) {
                Nav::Allow => true,
                Nav::OpenExternal => {
                    open_external(&nav_app, url);
                    false
                }
                Nav::Drop => false,
            }
        })
        .on_new_window(move |url, _features| {
            if let Some(origin) = current_origin(&new_window_app) {
                match policy::nav_decision(&url, &origin) {
                    Nav::Allow => open_viewer(&new_window_app, url),
                    Nav::OpenExternal => open_external(&new_window_app, &url),
                    Nav::Drop => {}
                }
            }
            // Never the webview's own popup: viewers are built by us, without
            // an opener link to the page that asked.
            NewWindowResponse::Deny
        })
}

/// Opens a same-origin URL (e.g. a file link with target=_blank) in a new
/// `viewer-<n>` window. It shares the webview session (cookies) but matches no
/// capability, so it has no IPC.
fn open_viewer<R: Runtime>(app: &AppHandle<R>, url: Url) {
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
        if lock_down(builder, &handle).build().is_err() {
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

/// Whether this run registers itself as the per-user `backroom://` handler.
/// Installed packages (.deb) declare the scheme in their .desktop file; dev
/// builds and AppImages are not installed, so they register at runtime
/// (P5-R12). For an AppImage the plugin writes the AppImage path with `%u`.
/// Smoke runs never touch the user's handler registration.
fn should_register_scheme(debug_build: bool, appimage: bool, smoke: bool) -> bool {
    (debug_build || appimage) && !smoke
}

/// The webview's data dir (cookie jar with the session cookie) is owner-only.
#[cfg(unix)]
fn restrict_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Locks down the app local data dir (where the webview keeps cookies) to 0700.
fn restrict_data_dir<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(unix)]
    {
        let restricted = app
            .path()
            .app_local_data_dir()
            .map_err(|_| ())
            .and_then(|dir| restrict_dir(&dir).map_err(|_| ()));
        if restricted.is_err() {
            eprintln!("backroom: data_dir_permissions_failed");
        }
    }
    #[cfg(not(unix))]
    let _ = app;
}

fn setup_deep_links<R: Runtime>(app: &AppHandle<R>) {
    let appimage = app.env().appimage.is_some();
    if should_register_scheme(cfg!(debug_assertions), appimage, smoke_enabled())
        && app.deep_link().register_all().is_err()
    {
        eprintln!("backroom: deep_link_register_failed");
    }

    // The origin is read per link: it is `None` while the setup page shows.
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let origin = current_origin(&handle);
            handle_deep_link(&handle, origin.as_ref(), url.as_str(), &show_notice);
        }
    });

    // A link that started this (first) instance.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        let origin = current_origin(app);
        for url in urls {
            handle_deep_link(app, origin.as_ref(), url.as_str(), &show_notice);
        }
    }
}

/// A title-only native notification; clicking it shows the main window.
fn show_notice<R: Runtime>(app: &AppHandle<R>, text: &str) {
    if app.notification().builder().title(text).show().is_err() {
        eprintln!("backroom: notification_failed");
    }
}

/// Routes an accepted `backroom://` link. Never logs the link, code or verifier.
/// `notice` shows a native notification (injected so tests stay headless).
fn handle_deep_link<R: Runtime>(
    app: &AppHandle<R>,
    origin: Option<&Url>,
    raw: &str,
    notice: &dyn Fn(&AppHandle<R>, &str),
) {
    let action = deep_link_action(raw, origin, || app.state::<VerifierStore>().take_verifier());
    match action {
        DeepLinkAction::NavigateMain(mut target) => {
            let seq = AUTH_NAV_SEQ.fetch_add(1, Ordering::Relaxed);
            target.set_query(Some(&format!("n={seq}")));
            show_main(app);
            let navigated = app
                .get_webview_window(MAIN_WINDOW)
                .map(|window| window.navigate(target).is_ok());
            if navigated != Some(true) {
                eprintln!("backroom: deep_link_navigate_failed");
            }
        }
        // A code with no pending login in this instance (restart, expiry, or
        // already used): the link cannot work, so say so instead of staying silent.
        DeepLinkAction::NoVerifier => {
            eprintln!("backroom: deep_link_no_verifier");
            show_main(app);
            notice(app, LINK_EXPIRED_NOTICE);
        }
        // Stored as well as emitted: on a cold start the page is not listening
        // yet and pulls the id with `take_pending_navigation` (P5-R9).
        DeepLinkAction::EmitNavigate(id) => {
            app.state::<PendingNavigation>().store(&id);
            show_main(app);
            emit_navigate(app, &id);
        }
        // The setup page has no use for a link; an auth link keeps its
        // verifier (the page that asked for it may come back after setup).
        DeepLinkAction::NoServer => {
            eprintln!("backroom: deep_link_ignored_no_server");
            show_main(app);
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

    /// Notice sink for tests: records texts instead of showing notifications.
    type Seen = Arc<Mutex<Vec<String>>>;

    fn recorder() -> (Seen, impl Fn(&AppHandle<MockRuntime>, &str)) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        (seen, move |_: &AppHandle<MockRuntime>, text: &str| {
            sink.lock().unwrap().push(text.to_string())
        })
    }

    fn no_notice(_: &AppHandle<MockRuntime>, text: &str) {
        panic!("unexpected notice: {text}");
    }

    /// Mock app with the verifier store and a plain "main" window on the origin.
    fn mock_app() -> App<MockRuntime> {
        let app = mock_builder()
            .manage(VerifierStore::default())
            .manage(PendingNavigation::default())
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
        let action = deep_link_action(
            &format!("backroom://auth?code={CODE}"),
            Some(&origin()),
            || Some("ver".to_string()),
        );
        assert_eq!(
            action,
            DeepLinkAction::NavigateMain(
                Url::parse(&format!(
                    "http://localhost:8787/desktop-auth#code={CODE}&verifier=ver"
                ))
                .unwrap()
            )
        );
    }

    #[test]
    fn auth_link_without_verifier_is_no_verifier() {
        let action = deep_link_action(
            &format!("backroom://auth?code={CODE}"),
            Some(&origin()),
            || None,
        );
        assert_eq!(action, DeepLinkAction::NoVerifier);
    }

    #[test]
    fn invalid_links_never_take_the_verifier() {
        for raw in [
            "backroom://auth?code=short",
            "garbage",
            "backroom://channel/x",
        ] {
            let action =
                deep_link_action(raw, Some(&origin()), || panic!("verifier taken for {raw}"));
            assert_eq!(action, DeepLinkAction::Ignore, "{raw}");
        }
        let action = deep_link_action(
            &format!("backroom://channel/{ULID}"),
            Some(&origin()),
            || panic!("verifier taken for a channel link"),
        );
        assert_eq!(action, DeepLinkAction::EmitNavigate(ULID.to_string()));
    }

    #[test]
    fn smoke_matches_only_the_app_origin() {
        let o = origin();
        assert!(smoke_load_matches(
            &Url::parse("http://localhost:8787/x?y#z").unwrap(),
            &o
        ));
        assert!(!smoke_load_matches(
            &Url::parse("http://localhost:8788/").unwrap(),
            &o
        ));
        assert!(!smoke_load_matches(
            &Url::parse("https://localhost:8787/").unwrap(),
            &o
        ));
        assert!(!smoke_load_matches(&Url::parse("about:blank").unwrap(), &o));
    }

    // ---- glue on the mock runtime ----

    #[test]
    fn auth_deep_link_navigates_main_and_consumes_the_verifier() {
        let app = mock_app();
        let handle = app.handle();
        let challenge = app.state::<VerifierStore>().login_challenge();
        assert_eq!(challenge.len(), 43);

        handle_deep_link(
            handle,
            Some(&origin()),
            &format!("backroom://auth?code={CODE}"),
            &no_notice,
        );
        let main = app.get_webview_window(MAIN_WINDOW).unwrap();
        let url = main.url().unwrap();
        assert_eq!(url.path(), "/desktop-auth");
        assert!(
            url.query().is_some_and(|q| q.starts_with("n=")),
            "nonce query forces a fresh document load"
        );
        let fragment = url.fragment().unwrap().to_string();
        let verifier = fragment
            .strip_prefix(&format!("code={CODE}&verifier="))
            .expect("code then verifier in the fragment");
        assert_eq!(auth::challenge_for(verifier), challenge);
        assert_eq!(
            app.state::<VerifierStore>().take_verifier(),
            None,
            "consumed"
        );

        // A second (replayed) auth link finds no verifier, leaves main alone and
        // tells the user the link expired.
        main.navigate(origin()).unwrap();
        let (seen, notice) = recorder();
        handle_deep_link(
            handle,
            Some(&origin()),
            &format!("backroom://auth?code={CODE}"),
            &notice,
        );
        assert_eq!(main.url().unwrap(), origin());
        assert_eq!(*seen.lock().unwrap(), vec![LINK_EXPIRED_NOTICE.to_string()]);
    }

    #[test]
    fn auth_link_after_restart_shows_the_expired_notice() {
        // Cold start: nothing pending in this instance.
        let app = mock_app();
        let (seen, notice) = recorder();
        handle_deep_link(
            app.handle(),
            Some(&origin()),
            &format!("backroom://auth?code={CODE}"),
            &notice,
        );
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["Sign-in link expired. Request a new one from Backroom.".to_string()]
        );
        let main = app.get_webview_window(MAIN_WINDOW).unwrap();
        assert_eq!(main.url().unwrap(), origin(), "main not navigated");
    }

    #[test]
    fn two_login_requests_then_either_link_signs_in() {
        // Two emails requested before either is clicked share one verifier.
        let app = mock_app();
        let store = app.state::<VerifierStore>();
        let first = store.login_challenge();
        let second = store.login_challenge();
        assert_eq!(first, second);
        handle_deep_link(
            app.handle(),
            Some(&origin()),
            &format!("backroom://auth?code={CODE}"),
            &no_notice,
        );
        let url = app.get_webview_window(MAIN_WINDOW).unwrap().url().unwrap();
        let verifier = url
            .fragment()
            .unwrap()
            .strip_prefix(&format!("code={CODE}&verifier="))
            .unwrap()
            .to_string();
        assert_eq!(auth::challenge_for(&verifier), second);
    }

    #[test]
    fn each_auth_hand_off_gets_a_new_nonce() {
        let app = mock_app();
        let main = app.get_webview_window(MAIN_WINDOW).unwrap();
        let mut queries = Vec::new();
        for _ in 0..2 {
            app.state::<VerifierStore>().login_challenge();
            handle_deep_link(
                app.handle(),
                Some(&origin()),
                &format!("backroom://auth?code={CODE}"),
                &no_notice,
            );
            queries.push(main.url().unwrap().query().unwrap().to_string());
        }
        assert_ne!(queries[0], queries[1]);
    }

    #[test]
    fn smoke_runs_get_their_own_single_instance_id() {
        // A smoke run must never hand off to (and show) a running Backroom.
        assert_eq!(single_instance_dbus_id(false, 42), None, "normal: app id");
        assert_eq!(
            single_instance_dbus_id(true, 42),
            Some("app.backroom.desktop.Smoke_42".to_string())
        );
        assert_ne!(
            single_instance_dbus_id(true, 1),
            single_instance_dbus_id(true, 2)
        );
    }

    #[test]
    fn scheme_registers_at_runtime_only_for_dev_and_appimage() {
        assert!(should_register_scheme(true, false, false), "dev build");
        assert!(
            should_register_scheme(false, true, false),
            "release AppImage"
        );
        assert!(should_register_scheme(true, true, false));
        assert!(
            !should_register_scheme(false, false, false),
            "installed .deb"
        );
        assert!(!should_register_scheme(true, false, true), "smoke: dev");
        assert!(
            !should_register_scheme(false, true, true),
            "smoke: AppImage"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restrict_dir_creates_an_owner_only_dir() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir()
            .join(format!("backroom-perm-test-{}", std::process::id()))
            .join("data");
        restrict_dir(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        // Existing dirs are tightened too.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        restrict_dir(&dir).unwrap();
        let again = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
        assert_eq!(mode, 0o700);
        assert_eq!(again, 0o700);
    }

    #[test]
    fn packaged_desktop_entry_passes_the_url_and_claims_the_scheme() {
        // Without a field code GIO/KIO launch the app with no URL (C1).
        let template = include_str!("../linux/backroom.desktop.hbs");
        let lines: Vec<&str> = template.lines().collect();
        assert!(lines.contains(&"Exec={{exec}} %u"), "{template}");
        assert!(lines.contains(&"MimeType=x-scheme-handler/backroom;"));
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        // The AppImage reuses the deb's data dir, so this covers both bundles.
        assert_eq!(
            conf["bundle"]["linux"]["deb"]["desktopTemplate"],
            "linux/backroom.desktop.hbs"
        );
    }

    #[test]
    fn channel_deep_link_emits_navigate_to_main() {
        let app = mock_app();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let record = Arc::clone(&seen);
        app.listen_any(NAVIGATE_EVENT, move |event| {
            record.lock().unwrap().push(event.payload().to_string());
        });
        handle_deep_link(
            app.handle(),
            Some(&origin()),
            &format!("backroom://channel/{ULID}"),
            &no_notice,
        );
        handle_deep_link(
            app.handle(),
            Some(&origin()),
            "backroom://channel/nope",
            &no_notice,
        );
        assert_eq!(
            *seen.lock().unwrap(),
            vec![format!(r#"{{"channelId":"{ULID}"}}"#)]
        );
    }

    #[test]
    fn channel_deep_link_is_also_kept_for_a_later_pull() {
        // Cold start: the page is not listening yet, so the live event is lost;
        // the id waits in the slot for take_pending_navigation (P5-R9).
        let app = mock_app();
        handle_deep_link(
            app.handle(),
            Some(&origin()),
            &format!("backroom://channel/{ULID}"),
            &no_notice,
        );
        let pending = app.state::<PendingNavigation>();
        assert_eq!(pending.take(), Some(ULID.to_string()));
        assert_eq!(pending.take(), None, "at most once");

        // Invalid channel links and auth links never fill the slot.
        handle_deep_link(
            app.handle(),
            Some(&origin()),
            "backroom://channel/nope",
            &no_notice,
        );
        let (_seen, notice) = recorder();
        handle_deep_link(
            app.handle(),
            Some(&origin()),
            &format!("backroom://auth?code={CODE}"),
            &notice,
        );
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn take_pending_navigation_command_requires_main() {
        let app = mock_app();
        let viewer = WebviewWindowBuilder::new(
            &app,
            format!("{VIEWER_PREFIX}1"),
            WebviewUrl::External(origin()),
        )
        .build()
        .unwrap();
        app.state::<PendingNavigation>().store(ULID);
        assert_eq!(
            commands::take_pending_navigation(viewer.as_ref().clone(), app.state()),
            Err("forbidden".to_string())
        );
        let main = app.get_webview_window(MAIN_WINDOW).unwrap();
        assert_eq!(
            commands::take_pending_navigation(main.as_ref().clone(), app.state()),
            Ok(Some(ULID.to_string())),
            "a viewer's denied call leaves the id for main"
        );
        assert_eq!(
            commands::take_pending_navigation(main.as_ref().clone(), app.state()),
            Ok(None)
        );
    }

    fn invoke_request(cmd: &str, url: Url) -> tauri::webview::InvokeRequest {
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url,
            body: tauri::ipc::InvokeBody::default(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        }
    }

    #[test]
    fn take_pending_navigation_is_callable_through_the_acl() {
        // Real context + the runtime capability: the call from the main window
        // on the app origin passes the ACL; a viewer or another origin does not.
        let app = mock_builder()
            .manage(PendingNavigation::default())
            .invoke_handler(tauri::generate_handler![commands::take_pending_navigation])
            .build(tauri::generate_context!())
            .expect("mock app");
        app.add_capability(commands::remote_capability(&origin()))
            .expect("capability resolves");
        let main = WebviewWindowBuilder::new(&app, MAIN_WINDOW, WebviewUrl::External(origin()))
            .build()
            .unwrap();
        let viewer = WebviewWindowBuilder::new(
            &app,
            format!("{VIEWER_PREFIX}1"),
            WebviewUrl::External(origin()),
        )
        .build()
        .unwrap();
        let take = |w: &tauri::WebviewWindow<MockRuntime>, url: &str| {
            tauri::test::get_ipc_response(
                w,
                invoke_request("take_pending_navigation", Url::parse(url).unwrap()),
            )
            .map(|body| body.deserialize::<Option<String>>().unwrap())
        };

        app.state::<PendingNavigation>().store(ULID);
        assert!(take(&viewer, "http://localhost:8787/").is_err(), "viewer");
        assert!(
            take(&main, "http://localhost:8788/").is_err(),
            "other origin"
        );
        assert_eq!(
            take(&main, "http://localhost:8787/client/x").unwrap(),
            Some(ULID.to_string())
        );
        assert_eq!(take(&main, "http://localhost:8787/").unwrap(), None);
    }

    // ---- runtime server address (Phase 8) ----

    static SCRATCH_SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh, empty scratch dir standing in for the app config dir.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "backroom-lib-test-{}-{}-{name}",
            std::process::id(),
            SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn server(input: &str) -> config::ServerOrigin {
        config::normalize_server_url(input).unwrap()
    }

    /// Booted like `run()`: real context (with the static setup capability),
    /// the real commands, `boot` reading `dir`, and the main window on
    /// whatever boot chose. Each call is a fresh process, as after a restart.
    fn booted_app(
        dir: &Path,
        build_default: Option<&str>,
    ) -> (App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
        let app = mock_builder()
            .manage(VerifierStore::default())
            .manage(PendingNavigation::default())
            .invoke_handler(tauri::generate_handler![
                commands::platform,
                commands::take_pending_navigation,
                commands::check_server,
                commands::save_server
            ])
            .build(tauri::generate_context!())
            .expect("mock app");
        let origin = boot(app.handle(), Some(dir.to_path_buf()), build_default).expect("boot");
        let main = WebviewWindowBuilder::new(&app, MAIN_WINDOW, main_url(origin.as_ref()))
            .build()
            .unwrap();
        (app, main)
    }

    /// One IPC call through the real ACL; errors come back as plain text.
    fn call(
        w: &tauri::WebviewWindow<MockRuntime>,
        cmd: &str,
        url: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let mut request = invoke_request(cmd, Url::parse(url).unwrap());
        request.body = tauri::ipc::InvokeBody::Json(args);
        tauri::test::get_ipc_response(w, request)
            .map(|body| body.deserialize::<serde_json::Value>().unwrap())
            .map_err(|e| {
                e.as_str()
                    .map(String::from)
                    .unwrap_or_else(|| e.to_string())
            })
    }

    /// The ACL's refusal (our own command errors never say "not allowed").
    fn denied(result: Result<serde_json::Value, String>) -> bool {
        matches!(result, Err(e) if e.contains("not allowed"))
    }

    fn no_args() -> serde_json::Value {
        serde_json::json!({})
    }

    #[test]
    fn without_a_server_the_setup_page_loads_with_no_remote_capability() {
        let dir = scratch_dir("setup");
        let (app, main) = booted_app(&dir, None);
        let local = main.url().unwrap();
        assert!(policy::is_app_local(&local), "{local}");
        // (The mock runtime reports the bare app origin; the page is index.html.)
        assert!(matches!(main_url(None), WebviewUrl::App(p) if p.as_os_str() == SETUP_PAGE));
        assert_eq!(app.state::<ServerState>().current(), None);
        let local = local.as_str();

        // The setup commands pass the ACL: their own validation answers.
        assert_eq!(
            call(
                &main,
                "check_server",
                local,
                serde_json::json!({ "url": "ftp://x.example" })
            ),
            Err(config::ConfigError::UnsupportedScheme.to_string())
        );
        assert_eq!(
            call(
                &main,
                "save_server",
                local,
                serde_json::json!({ "url": "javascript:alert(1)" })
            ),
            Err(config::ConfigError::UnsupportedScheme.to_string())
        );
        assert_eq!(config::load_config(&dir), Stored::Missing, "nothing saved");

        // The remote commands are not granted to the setup page.
        assert!(denied(call(
            &main,
            "take_pending_navigation",
            local,
            no_args()
        )));
        assert!(denied(call(&main, "platform", local, no_args())));

        // No remote origin gets anything, the setup commands least of all.
        for remote in [
            "http://localhost:8787/",
            "https://chat.example.com/",
            "http://tauri.localhost.evil.example/",
        ] {
            for cmd in ["check_server", "save_server", "take_pending_navigation"] {
                let args = serde_json::json!({ "url": "https://chat.example.com" });
                assert!(
                    denied(call(&main, cmd, remote, args)),
                    "{cmd} from {remote}"
                );
            }
        }

        // A viewer window on the app origin gets nothing either.
        let viewer = WebviewWindowBuilder::new(
            &app,
            format!("{VIEWER_PREFIX}1"),
            WebviewUrl::App(SETUP_PAGE.into()),
        )
        .build()
        .unwrap();
        let args = serde_json::json!({ "url": "https://chat.example.com" });
        assert!(denied(call(&viewer, "check_server", local, args)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_server_connects_once_and_only_the_saved_origin_gets_remote_commands() {
        let dir = scratch_dir("save");
        let (app, main) = booted_app(&dir, None);
        let local = main.url().unwrap().to_string();

        let saved = call(
            &main,
            "save_server",
            &local,
            serde_json::json!({ "url": "  http://LOCALHOST:8787/ " }),
        );
        assert_eq!(saved, Ok(serde_json::json!("http://localhost:8787")));
        assert_eq!(
            config::load_config(&dir),
            Stored::Server(server("http://localhost:8787"))
        );
        assert_eq!(app.state::<ServerState>().current(), Some(origin()));
        assert_eq!(main.url().unwrap(), origin(), "navigated by Rust");

        // Remote commands: the saved origin only.
        assert_eq!(
            call(
                &main,
                "take_pending_navigation",
                "http://localhost:8787/c/x",
                no_args()
            ),
            Ok(serde_json::Value::Null)
        );
        for other in [
            "http://localhost:8788/",
            "https://localhost:8787/",
            "http://127.0.0.1:8787/",
        ] {
            assert!(
                denied(call(&main, "take_pending_navigation", other, no_args())),
                "{other}"
            );
        }
        assert!(denied(call(
            &main,
            "take_pending_navigation",
            &local,
            no_args()
        )));
        // The saved origin never gets the setup commands.
        let args = serde_json::json!({ "url": "https://evil.example" });
        assert!(denied(call(
            &main,
            "save_server",
            "http://localhost:8787/",
            args
        )));

        // A second save is refused: the window no longer shows the setup page.
        let args = serde_json::json!({ "url": "https://evil.example" });
        assert_eq!(
            call(&main, "save_server", &local, args),
            Err("forbidden".to_string())
        );
        assert_eq!(app.state::<ServerState>().current(), Some(origin()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_commands_refuse_a_remote_webview_even_with_a_local_ipc_origin() {
        // The capability looks at the IPC request's origin; require_setup_page
        // also looks at what the window actually shows.
        #[cfg(not(windows))]
        const LOCAL: &str = "tauri://localhost/";
        #[cfg(windows)]
        const LOCAL: &str = "http://tauri.localhost/";
        let dir = scratch_dir("remote-webview");
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                commands::check_server,
                commands::save_server
            ])
            .build(tauri::generate_context!())
            .expect("mock app");
        boot(app.handle(), Some(dir.clone()), None).unwrap();
        let main = WebviewWindowBuilder::new(&app, MAIN_WINDOW, WebviewUrl::External(origin()))
            .build()
            .unwrap();
        for cmd in ["check_server", "save_server"] {
            let args = serde_json::json!({ "url": "https://chat.example.com" });
            assert_eq!(
                call(&main, cmd, LOCAL, args),
                Err("forbidden".to_string()),
                "{cmd}"
            );
        }
        assert_eq!(config::load_config(&dir), Stored::Missing);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_server_refuses_to_replace_a_connected_origin() {
        // Even if the setup page were somehow back in a connected process,
        // the origin stays: changing it takes a restart.
        let dir = scratch_dir("already");
        config::save_config(&dir, Some(&server("http://localhost:8787"))).unwrap();
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![commands::save_server])
            .build(tauri::generate_context!())
            .expect("mock app");
        boot(app.handle(), Some(dir.clone()), None).unwrap();
        let main = WebviewWindowBuilder::new(&app, MAIN_WINDOW, WebviewUrl::App(SETUP_PAGE.into()))
            .build()
            .unwrap();
        let local = main.url().unwrap().to_string();
        let args = serde_json::json!({ "url": "https://evil.example" });
        assert_eq!(
            call(&main, "save_server", &local, args),
            Err("Backroom is already connected to a server.".to_string())
        );
        assert_eq!(
            config::load_config(&dir),
            Stored::Server(server("http://localhost:8787"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn after_changing_the_server_the_previous_origin_is_denied() {
        let dir = scratch_dir("change");
        config::save_config(&dir, Some(&server("http://localhost:8787"))).unwrap();
        {
            let (app, main) = booted_app(&dir, None);
            assert_eq!(app.state::<ServerState>().current(), Some(origin()));
            assert!(call(
                &main,
                "take_pending_navigation",
                "http://localhost:8787/",
                no_args()
            )
            .is_ok());
            // "Change server…" clears the config, then restarts.
            assert!(clear_server_config(&app.state::<ServerState>()));
        }
        assert_eq!(config::load_config(&dir), Stored::Cleared);

        // The new process shows the setup page, even with a build-time default.
        let (app, main) = booted_app(&dir, Some("http://localhost:8787"));
        assert_eq!(app.state::<ServerState>().current(), None);
        let local = main.url().unwrap().to_string();
        assert!(policy::is_app_local(&main.url().unwrap()));
        assert!(denied(call(
            &main,
            "take_pending_navigation",
            "http://localhost:8787/",
            no_args()
        )));
        let args = serde_json::json!({ "url": "http://localhost:8788" });
        assert!(call(&main, "save_server", &local, args).is_ok());
        assert!(call(
            &main,
            "take_pending_navigation",
            "http://localhost:8788/",
            no_args()
        )
        .is_ok());
        assert!(denied(call(
            &main,
            "take_pending_navigation",
            "http://localhost:8787/",
            no_args()
        )));
        drop((app, main));

        // And after the next restart the new origin is the one that loads.
        let (app, main) = booted_app(&dir, Some("http://localhost:8787"));
        let new_origin = server("http://localhost:8788").url().clone();
        assert_eq!(
            app.state::<ServerState>().current(),
            Some(new_origin.clone())
        );
        assert_eq!(main.url().unwrap(), new_origin);
        assert!(denied(call(
            &main,
            "take_pending_navigation",
            "http://localhost:8787/",
            no_args()
        )));
        assert!(call(
            &main,
            "take_pending_navigation",
            "http://localhost:8788/",
            no_args()
        )
        .is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hostile_stored_config_never_reaches_the_capability_builder() {
        for (i, hostile) in [
            r#"{"serverUrl":"http://evil.example"}"#,
            r#"{"serverUrl":"https://evil.example/phish"}"#,
            r#"{"serverUrl":"https://evil.example/*"}"#,
            r#"{"serverUrl":"javascript:alert(1)"}"#,
            r#"{"serverUrl":"https://user:pw@evil.example"}"#,
            r#"{"serverUrl":"https://tauri.localhost"}"#,
            "garbage",
        ]
        .into_iter()
        .enumerate()
        {
            let dir = scratch_dir(&format!("hostile-{i}"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(config::CONFIG_FILE), hostile).unwrap();
            let stored = config::load_config(&dir);
            assert_eq!(stored, Stored::Invalid, "{hostile}");
            // Not even the build-time default: a broken file asks the user.
            let start = config::resolve_start(&stored, Some("http://localhost:8787"));
            assert_eq!(start, Start::Setup, "{hostile}");
            assert!(start_capability(&start).is_none(), "{hostile}");

            let (app, main) = booted_app(&dir, Some("http://localhost:8787"));
            assert_eq!(app.state::<ServerState>().current(), None, "{hostile}");
            assert!(policy::is_app_local(&main.url().unwrap()));
            for url in [
                "http://evil.example/",
                "https://evil.example/",
                "https://evil.example/phish",
                "http://localhost:8787/",
            ] {
                assert!(
                    denied(call(&main, "take_pending_navigation", url, no_args())),
                    "{hostile}: {url}"
                );
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Another origin to probe with: same host on another port (or another
    /// host entirely for default-port origins).
    fn neighbour(o: &config::ServerOrigin) -> String {
        let mut other = o.url().clone();
        other
            .set_port(Some(o.url().port().map_or(1, |p| p + 1)))
            .unwrap();
        other.to_string()
    }

    #[test]
    fn every_origin_shape_boots_from_a_saved_config_without_panicking() {
        for (i, input) in config::ORIGIN_SHAPES.into_iter().enumerate() {
            let o = server(input);
            let dir = scratch_dir(&format!("shape-boot-{i}"));
            config::save_config(&dir, Some(&o)).unwrap();
            let (app, main) = booted_app(&dir, None);
            assert_eq!(
                app.state::<ServerState>().current().as_ref(),
                Some(o.url()),
                "{input}"
            );
            assert_eq!(&main.url().unwrap(), o.url(), "{input}");
            let page = o.url().join("/c/x").unwrap().to_string();
            assert!(
                call(&main, "take_pending_navigation", &page, no_args()).is_ok(),
                "{input}"
            );
            let other = neighbour(&o);
            assert!(
                denied(call(&main, "take_pending_navigation", &other, no_args())),
                "{input} vs {other}"
            );
            assert!(
                denied(call(
                    &main,
                    "take_pending_navigation",
                    "https://other.example/",
                    no_args()
                )),
                "{input}"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn every_origin_shape_can_be_saved_from_the_setup_page() {
        for (i, input) in config::ORIGIN_SHAPES.into_iter().enumerate() {
            let o = server(input);
            let dir = scratch_dir(&format!("shape-save-{i}"));
            let (app, main) = booted_app(&dir, None);
            let local = main.url().unwrap().to_string();
            let saved = call(
                &main,
                "save_server",
                &local,
                serde_json::json!({ "url": input }),
            );
            assert_eq!(saved, Ok(serde_json::json!(o.origin())), "{input}");
            assert_eq!(
                config::load_config(&dir),
                Stored::Server(o.clone()),
                "{input}"
            );
            assert_eq!(app.state::<ServerState>().current().as_ref(), Some(o.url()));
            assert!(call(
                &main,
                "take_pending_navigation",
                o.url().as_str(),
                no_args()
            )
            .is_ok());
            let other = neighbour(&o);
            assert!(
                denied(call(&main, "take_pending_navigation", &other, no_args())),
                "{input} vs {other}"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_hand_edited_ipv6_or_metacharacter_host_never_panics_boot() {
        for (i, (text, expect_remote)) in [
            (r#"{"serverUrl":"https://[2001:db8::1]"}"#, true),
            (r#"{"serverUrl":"http://[::1]:8787"}"#, true),
            (r#"{"serverUrl":"https://*"}"#, false),
            (r#"{"serverUrl":"https://a+.example.com"}"#, false),
            (r#"{"serverUrl":"https://chat(x).example.com"}"#, false),
            (r#"{"serverUrl":"http://*.local"}"#, false),
        ]
        .into_iter()
        .enumerate()
        {
            let dir = scratch_dir(&format!("hand-{i}"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(config::CONFIG_FILE), text).unwrap();
            let (app, _main) = booted_app(&dir, None);
            assert_eq!(
                app.state::<ServerState>().current().is_some(),
                expect_remote,
                "{text}"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn deep_links_on_the_setup_page_are_ignored_and_keep_the_verifier() {
        let action = deep_link_action(&format!("backroom://auth?code={CODE}"), None, || {
            panic!("verifier taken without a server")
        });
        assert_eq!(action, DeepLinkAction::NoServer);

        let dir = scratch_dir("deeplink");
        let (app, main) = booted_app(&dir, None);
        let challenge = app.state::<VerifierStore>().login_challenge();
        let before = main.url().unwrap();
        let origin = current_origin(app.handle());
        assert_eq!(origin, None);
        handle_deep_link(
            app.handle(),
            origin.as_ref(),
            &format!("backroom://auth?code={CODE}"),
            &no_notice,
        );
        handle_deep_link(
            app.handle(),
            origin.as_ref(),
            &format!("backroom://channel/{ULID}"),
            &no_notice,
        );
        assert_eq!(main.url().unwrap(), before, "main not navigated");
        assert_eq!(app.state::<PendingNavigation>().take(), None);
        let verifier = app
            .state::<VerifierStore>()
            .take_verifier()
            .expect("verifier kept");
        assert_eq!(auth::challenge_for(&verifier), challenge);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_build_default_loads_only_without_a_config_file() {
        let dir = scratch_dir("default");
        let (app, main) = booted_app(&dir, Some("http://localhost:8787"));
        assert_eq!(app.state::<ServerState>().current(), Some(origin()));
        assert_eq!(main.url().unwrap(), origin());
        assert!(call(
            &main,
            "take_pending_navigation",
            "http://localhost:8787/",
            no_args()
        )
        .is_ok());
        assert_eq!(
            config::load_config(&dir),
            Stored::Missing,
            "a default is not saved"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_page_is_self_contained_and_accessible() {
        let html = include_str!("../../dist/index.html");
        let js = include_str!("../../dist/setup.js");
        let css = include_str!("../../dist/setup.css");

        // Only the two sibling files are referenced.
        let mut refs = Vec::new();
        for attr in ["src=\"", "href=\""] {
            for (i, _) in html.match_indices(attr) {
                let rest = &html[i + attr.len()..];
                refs.push(&rest[..rest.find('"').unwrap()]);
            }
        }
        refs.sort();
        assert_eq!(refs, ["setup.css", "setup.js"]);
        // No URL anywhere except the example text and the IPC origin in the CSP.
        let stripped = html
            .replace("https://chat.example.com", "")
            .replace("http://ipc.localhost", "");
        assert!(!stripped.contains("://"), "{stripped}");
        assert!(!js.contains("://") && !css.contains("://"));
        for banned in ["@import", "url(", "@font-face"] {
            assert!(!css.contains(banned), "{banned}");
        }
        for banned in [
            "fetch(",
            "XMLHttpRequest",
            "import(",
            "eval(",
            "innerHTML",
            "WebSocket",
        ] {
            assert!(!js.contains(banned), "{banned}");
        }
        assert!(
            !html.contains("<script>") && !html.contains("style="),
            "no inline code"
        );

        // CSP: only the page's own files and the IPC channel.
        let csp_start = html
            .find("<meta http-equiv=\"Content-Security-Policy\" content=\"")
            .expect("a CSP meta tag");
        let csp = &html[csp_start..];
        let csp = &csp[csp.find("content=\"").unwrap() + 9..];
        let csp = &csp[..csp.find('"').unwrap()];
        for part in [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "connect-src ipc: http://ipc.localhost",
            "base-uri 'none'",
            "form-action 'none'",
        ] {
            assert!(csp.contains(part), "{part} in {csp}");
        }
        assert!(!csp.contains("unsafe"), "{csp}");

        // The required parts.
        for part in [
            "<label for=\"server-url\">",
            "id=\"server-url\"",
            "<button id=\"connect\" type=\"submit\">Connect</button>",
            "role=\"alert\"",
            "id=\"insecure\"",
            "Enter the address of your Backroom server, for example https://chat.example.com",
            "<html lang=\"en\">",
        ] {
            assert!(html.contains(part), "{part}");
        }
        assert!(css.contains("prefers-color-scheme: dark"));
        assert!(css.contains(":focus-visible"));
        for part in [
            "__TAURI_INTERNALS__",
            "'check_server'",
            "'save_server'",
            "preventDefault",
        ] {
            assert!(js.contains(part), "{part}");
        }

        // The app serves this page with its own CSP, and never exposes the
        // global Tauri API (the remote page uses the bridge's imports).
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["build"]["frontendDist"], "../dist");
        let app_csp = conf["app"]["security"]["csp"].as_str().unwrap();
        assert!(
            app_csp.contains("connect-src ipc: http://ipc.localhost"),
            "{app_csp}"
        );
        assert!(!app_csp.contains("unsafe"));
        assert!(conf["app"]["withGlobalTauri"].as_bool() != Some(true));
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
