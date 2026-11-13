//! Tray icon: Show / Quit menu and the unread count in the tooltip.

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

/// Updates the tooltip; unsupported platforms (Linux tray tooltips) are ignored.
pub fn set_unread<R: Runtime>(app: &AppHandle<R>, unread: i64) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip_text(unread)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_shows_unread_count() {
        assert_eq!(tooltip_text(0), "Backroom");
        assert_eq!(tooltip_text(1), "Backroom — 1 unread");
        assert_eq!(tooltip_text(9_999), "Backroom — 9999 unread");
    }
}
