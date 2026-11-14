//! Tray icon: Show / Quit menu and the unread count in the tooltip and, for
//! AppIndicator trays on Linux (which ignore tooltips), as a label.
//!
//! Tray-host detection: on Linux the tray icon is only visible when a
//! StatusNotifier host runs (GNOME without the AppIndicator extension has
//! none), yet building the icon succeeds either way. Startup asks the session
//! bus whether `org.kde.StatusNotifierWatcher` has an owner; without one,
//! closing the main window quits instead of hiding to an invisible tray.

use std::sync::mpsc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

pub const TRAY_ID: &str = "backroom";
const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";

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

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(tooltip_text(0))
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => crate::show_main(app),
            MENU_QUIT => app.exit(0),
            _ => {}
        });
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
