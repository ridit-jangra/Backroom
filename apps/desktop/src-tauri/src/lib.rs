pub mod policy;

use policy::Nav;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Runtime, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Build-time app URL (`BACKROOM_APP_URL`), default for local development.
const APP_URL: &str = match option_env!("BACKROOM_APP_URL") {
    Some(url) => url,
    None => "http://localhost:8787",
};

pub const MAIN_WINDOW: &str = "main";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let origin = policy::app_origin(APP_URL)?;
            build_main_window(app.handle(), origin)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Backroom");
}

fn build_main_window<R: Runtime>(app: &AppHandle<R>, origin: Url) -> tauri::Result<()> {
    let nav_origin = origin.clone();
    let nav_app = app.clone();
    let new_window_origin = origin.clone();
    let new_window_app = app.clone();

    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(origin))
        .title("Backroom")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 560.0)
        // Every top-level and frame navigation: only the app origin loads in-app.
        .on_navigation(move |url| match policy::nav_decision(url, &nav_origin) {
            Nav::Allow => true,
            Nav::OpenExternal => {
                open_external(&nav_app, url);
                false
            }
            Nav::Drop => false,
        })
        // window.open / target=_blank: never open a second in-app window. Any
        // http(s) URL (same origin included) goes to the default browser.
        .on_new_window(move |url, _features| {
            match policy::nav_decision(&url, &new_window_origin) {
                Nav::Allow | Nav::OpenExternal => open_external(&new_window_app, &url),
                Nav::Drop => {}
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

fn open_external<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    // Never log the URL itself: it may carry tokens.
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        eprintln!("backroom: failed to open link in the default browser");
    }
}
