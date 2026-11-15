//! Tray icon: Show / Change server… / Quit menu and the unread count in the
//! tooltip and, for AppIndicator trays on Linux (which ignore tooltips), as a
//! label. "Change server…" also sits in the macOS app menu and, when Linux has
//! no tray host, in a small menu bar on the main window, so it stays reachable
//! even when the remote page is broken. One handler serves every menu.
//!
//! Tray-host detection: on Linux the tray icon is only visible when a
//! StatusNotifier host runs (GNOME without the AppIndicator extension has
//! none), yet building the icon succeeds either way. Startup asks the session
//! bus whether `org.kde.StatusNotifierWatcher` has an owner; without one,
//! closing the main window quits instead of hiding to an invisible tray.

use std::sync::mpsc;
use std::time::Duration;

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

pub const TRAY_ID: &str = "backroom";
pub const MENU_SHOW: &str = "show";
pub const MENU_CHANGE_SERVER: &str = "change_server";
pub const MENU_QUIT: &str = "quit";
pub const CHANGE_SERVER_LABEL: &str = "Change server…";

/// "Backroom — N unread", or "Backroom" when nothing is unread.
pub fn tooltip_text(unread: i64) -> String {
    if unread > 0 {
        format!("Backroom — {unread} unread")
    } else {
        "Backroom".to_string()
    }
}

/// Label beside the tray icon: the unread count, or none when nothing is unread.
pub fn title_text(unread: i64) -> Option<String> {
    (unread > 0).then(|| unread.to_string())
}

/// Well-known D-Bus name of the StatusNotifier watcher (the tray host registry).
pub const STATUS_NOTIFIER_WATCHER: &str = "org.kde.StatusNotifierWatcher";
/// Fixed log token when no tray host was found.
pub const TRAY_UNAVAILABLE: &str = "tray_unavailable";
/// Upper bound on how long startup waits for the D-Bus probe.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// What closing the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide; the tray's Show brings it back and its Quit exits.
    HideToTray,
    /// Exit the app: with no tray host, a hidden window could not come back.
    Quit,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ClosePolicy {
    pub on_close: CloseAction,
    /// Fixed token to log at startup, if any.
    pub log: Option<&'static str>,
}

/// Pure decision from the probe result.
pub fn close_policy(tray_host: bool) -> ClosePolicy {
    if tray_host {
        ClosePolicy {
            on_close: CloseAction::HideToTray,
            log: None,
        }
    } else {
        ClosePolicy {
            on_close: CloseAction::Quit,
            log: Some(TRAY_UNAVAILABLE),
        }
    }
}

/// The probe could not answer (no session bus, D-Bus error).
#[derive(Debug)]
pub struct ProbeError;

/// Runs `probe` on its own thread and waits at most `timeout`. Only a timely
/// `Ok(true)` counts as available; an error, a panic or a timeout does not.
/// A hung probe thread is left behind rather than blocking startup.
pub fn probe_with_timeout<F>(probe: F, timeout: Duration) -> bool
where
    F: FnOnce() -> Result<bool, ProbeError> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("tray-probe".into())
        .spawn(move || {
            let _ = tx.send(probe());
        });
    if spawned.is_err() {
        return false;
    }
    matches!(rx.recv_timeout(timeout), Ok(Ok(true)))
}

/// Whether a tray host is running (always true off Linux).
pub fn host_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        probe_with_timeout(status_notifier_watcher_present, PROBE_TIMEOUT)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Asks the session bus whether the StatusNotifier watcher name has an owner.
#[cfg(target_os = "linux")]
fn status_notifier_watcher_present() -> Result<bool, ProbeError> {
    let conn = zbus::blocking::Connection::session().map_err(|_| ProbeError)?;
    let dbus = zbus::blocking::fdo::DBusProxy::new(&conn).map_err(|_| ProbeError)?;
    let name = zbus::names::BusName::try_from(STATUS_NOTIFIER_WATCHER).map_err(|_| ProbeError)?;
    dbus.name_has_owner(name).map_err(|_| ProbeError)
}

/// The one menu handler. Tauri registers a tray's menu handler as a global
/// one, so it also receives the app menu and window menu events (same ids).
fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_SHOW => crate::show_main(app),
        MENU_CHANGE_SERVER => crate::change_server(app),
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

fn change_server_item<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(
        app,
        MENU_CHANGE_SERVER,
        CHANGE_SERVER_LABEL,
        true,
        None::<&str>,
    )
}

/// Tray menu: Show, Change server…, Quit.
pub fn tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, MENU_SHOW, "Show", true, None::<&str>)?;
    let change = change_server_item(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &change, &quit])
}

/// Menu bar for the main window when there is no tray host (Linux without a
/// StatusNotifier host): "Backroom" › Change server…, Quit.
pub fn window_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let change = change_server_item(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    let backroom = Submenu::with_items(app, "Backroom", true, &[&change, &separator, &quit])?;
    Menu::with_items(app, &[&backroom])
}

/// macOS: the default app menu with "Change server…" after "About Backroom".
/// Compiled everywhere (so it is type-checked on Linux), called only on macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn install_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        app_menu.insert(&change_server_item(app)?, 1)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(tooltip_text(0))
        .on_menu_event(on_menu_event);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Updates the tooltip and the label; whatever a platform does not support
/// (Linux tray tooltips, Windows tray titles) is ignored.
pub fn set_unread<R: Runtime>(app: &AppHandle<R>, unread: i64) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip_text(unread)));
        let _ = tray.set_title(title_text(unread));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn no_tray_host_means_close_quits_and_logs_tray_unavailable() {
        assert_eq!(
            close_policy(false),
            ClosePolicy {
                on_close: CloseAction::Quit,
                log: Some("tray_unavailable"),
            }
        );
        assert_eq!(TRAY_UNAVAILABLE, "tray_unavailable");
    }

    #[test]
    fn a_tray_host_keeps_hide_on_close() {
        assert_eq!(
            close_policy(true),
            ClosePolicy {
                on_close: CloseAction::HideToTray,
                log: None,
            }
        );
    }

    #[test]
    fn probe_result_counts_only_a_timely_yes() {
        let t = Duration::from_millis(500);
        assert!(probe_with_timeout(|| Ok(true), t));
        assert!(!probe_with_timeout(|| Ok(false), t), "no watcher");
        assert!(!probe_with_timeout(|| Err(ProbeError), t), "no session bus");
        assert!(!probe_with_timeout(|| panic!("probe crashed"), t));
    }

    #[test]
    fn a_hanging_probe_does_not_block_startup() {
        let started = Instant::now();
        let available = probe_with_timeout(
            || {
                std::thread::sleep(Duration::from_secs(5));
                Ok(true)
            },
            Duration::from_millis(100),
        );
        assert!(!available, "timed out counts as unavailable");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn watcher_name_is_the_status_notifier_watcher() {
        assert_eq!(STATUS_NOTIFIER_WATCHER, "org.kde.StatusNotifierWatcher");
    }

    fn texts<R: Runtime>(items: Vec<MenuItemKind<R>>) -> Vec<String> {
        items
            .into_iter()
            .map(|item| match item {
                MenuItemKind::MenuItem(i) => i.text().unwrap(),
                MenuItemKind::Submenu(s) => format!("{} ›", s.text().unwrap()),
                MenuItemKind::Predefined(_) => "---".to_string(),
                _ => "?".to_string(),
            })
            .collect()
    }

    #[test]
    fn tray_and_window_menus_offer_change_server() {
        assert_eq!(CHANGE_SERVER_LABEL, "Change server…");
        let app = tauri::test::mock_app();
        let tray = tray_menu(app.handle()).unwrap();
        assert_eq!(
            texts(tray.items().unwrap()),
            ["Show", "Change server…", "Quit"]
        );
        let ids: Vec<String> = tray
            .items()
            .unwrap()
            .iter()
            .map(|i| i.id().as_ref().to_string())
            .collect();
        assert_eq!(ids, [MENU_SHOW, MENU_CHANGE_SERVER, MENU_QUIT]);
        let window = window_menu(app.handle()).unwrap();
        let Some(MenuItemKind::Submenu(sub)) = window.items().unwrap().into_iter().next() else {
            panic!("a Backroom submenu");
        };
        assert_eq!(sub.text().unwrap(), "Backroom");
        assert_eq!(
            texts(sub.items().unwrap()),
            ["Change server…", "---", "Quit"]
        );
    }

    #[test]
    fn tooltip_shows_unread_count() {
        assert_eq!(tooltip_text(0), "Backroom");
        assert_eq!(tooltip_text(1), "Backroom — 1 unread");
        assert_eq!(tooltip_text(9_999), "Backroom — 9999 unread");
    }

    #[test]
    fn title_shows_unread_count_or_nothing() {
        assert_eq!(title_text(0), None);
        assert_eq!(title_text(-1), None);
        assert_eq!(title_text(1), Some("1".to_string()));
        assert_eq!(title_text(9_999), Some("9999".to_string()));
    }
}
