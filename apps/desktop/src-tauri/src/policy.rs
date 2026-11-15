//! Pure policy decisions for the desktop shell: which URLs may load in the app
//! window, which deep links are accepted, and how command arguments are
//! bounded. No Tauri types here, so everything is unit-testable.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use url::Url;

/// Maximum title length (in chars) for native notifications.
pub const MAX_TITLE_CHARS: usize = 200;
/// Maximum body length (in chars) for native notifications.
pub const MAX_BODY_CHARS: usize = 1_000;
/// Upper bound for the unread badge count.
pub const MAX_BADGE: i64 = 9_999;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// The app URL could not be parsed.
    InvalidUrl,
    /// The app URL is not http or https.
    UnsupportedScheme,
    /// The app URL carries a path, query, fragment or credentials.
    NotAnOrigin,
    /// A channel id is not a 26-char uppercase ULID.
    InvalidChannelId,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            PolicyError::InvalidUrl => "app URL is not a valid URL",
            PolicyError::UnsupportedScheme => "app URL must use http or https",
            PolicyError::NotAnOrigin => {
                "app URL must be a bare origin (no path, query, fragment or credentials)"
            }
            PolicyError::InvalidChannelId => "channel id must be a 26-char ULID",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for PolicyError {}

/// What to do with a navigation or new-window request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nav {
    /// Same origin as the app: load in the app window.
    Allow,
    /// Other http(s) URL: deny in-app, open in the default browser.
    OpenExternal,
    /// Any other scheme: deny and do nothing.
    Drop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    Auth { code: String },
    Channel { id: String },
}

/// Validates the configured app URL: http/https only, no path beyond `/`.
/// Query, fragment and credentials are rejected too, so the result is a bare
/// origin URL such as `http://localhost:8787/`.
pub fn app_origin(url: &str) -> Result<Url, PolicyError> {
    let parsed = Url::parse(url).map_err(|_| PolicyError::InvalidUrl)?;
    if !is_http(&parsed) {
        return Err(PolicyError::UnsupportedScheme);
    }
    if parsed.host().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(PolicyError::NotAnOrigin);
    }
    Ok(parsed)
}

/// Same origin (scheme, host, port) → `Allow`; other http/https → `OpenExternal`;
/// anything else → `Drop`. URLs carrying credentials (`user[:pw]@`) are always
/// `Drop`: they are a classic way to disguise the real host.
pub fn nav_decision(target: &Url, origin: &Url) -> Nav {
    if !is_http(target) || !target.username().is_empty() || target.password().is_some() {
        return Nav::Drop;
    }
    // `Url::origin` compares scheme, host and port (default ports normalised).
    if is_http(origin) && target.origin() == origin.origin() {
        Nav::Allow
    } else {
        Nav::OpenExternal
    }
}

/// The webview's own origin on this platform, where the bundled setup page
/// runs: `tauri://localhost` (Linux, macOS) or `http(s)://tauri.localhost`
/// (Windows; the other spelling is refused). No port, no credentials.
pub fn is_app_local(url: &Url) -> bool {
    #[cfg(not(windows))]
    let own = url.scheme() == "tauri" && url.host_str() == Some("localhost");
    #[cfg(windows)]
    let own = matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost");
    own && url.port().is_none() && url.username().is_empty() && url.password().is_none()
}

/// Navigation rule for a window given the current server origin. With an
/// origin it is [`nav_decision`]. Without one the setup page is showing: only
/// the app's own origin loads and everything else is dropped (no browser
/// either). `save_server` sets the origin before it navigates, so its one
/// navigation passes as an ordinary same-origin load.
pub fn window_nav(target: &Url, origin: Option<&Url>) -> Nav {
    match origin {
        Some(origin) => nav_decision(target, origin),
        None if is_app_local(target) => Nav::Allow,
        None => Nav::Drop,
    }
}

/// Accepts only `backroom://auth?code=<10..100 base64url chars>` and
/// `backroom://channel/<26-char ULID>`. Matching is on the raw string (no URL
/// normalisation), so dot segments, extra query pairs, fragments, trailing
/// slashes and case variants are all rejected.
pub fn parse_deep_link(s: &str) -> Option<DeepLink> {
    if let Some(code) = s.strip_prefix("backroom://auth?code=") {
        let ok = (10..=100).contains(&code.len())
            && code
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        return ok.then(|| DeepLink::Auth {
            code: code.to_string(),
        });
    }
    if let Some(id) = s.strip_prefix("backroom://channel/") {
        return is_ulid(id).then(|| DeepLink::Channel { id: id.to_string() });
    }
    None
}

/// `<origin>/desktop-auth#code=<code>&verifier=<verifier>`. Both values travel
/// in the fragment, so they never reach a server or its logs. Callers pass a
/// code from [`parse_deep_link`] and a verifier from the store (both base64url).
pub fn desktop_auth_url(origin: &Url, code: &str, verifier: &str) -> Url {
    let mut url = origin
        .join("desktop-auth")
        .expect("origin joins a relative path");
    url.set_fragment(Some(&format!("code={code}&verifier={verifier}")));
    url
}

/// Truncates title/body on char boundaries and enforces the ULID channel id.
pub fn validate_notify(
    title: &str,
    body: &str,
    channel_id: &str,
) -> Result<(String, String, String), PolicyError> {
    if !is_ulid(channel_id) {
        return Err(PolicyError::InvalidChannelId);
    }
    Ok((
        truncate_chars(title, MAX_TITLE_CHARS),
        truncate_chars(body, MAX_BODY_CHARS),
        channel_id.to_string(),
    ))
}

/// Minimum time between two links opened in the default browser.
pub const EXTERNAL_OPEN_INTERVAL: Duration = Duration::from_secs(1);

/// Rate limit for opening links in the default browser: at most one per
/// [`EXTERNAL_OPEN_INTERVAL`], so a hostile page cannot spam browser tabs.
#[derive(Debug, Default)]
pub struct ExternalOpenLimiter {
    last: Option<Instant>,
}

impl ExternalOpenLimiter {
    /// True (and records `now`) when an open is allowed at `now`.
    pub fn allow(&mut self, now: Instant) -> bool {
        let ok = self
            .last
            .is_none_or(|last| now.saturating_duration_since(last) >= EXTERNAL_OPEN_INTERVAL);
        if ok {
            self.last = Some(now);
        }
        ok
    }
}

/// Fallback name for a download whose suggested name is unusable.
pub const DEFAULT_DOWNLOAD_NAME: &str = "download";

/// Reduces a suggested download name to a safe basename: the last path
/// component (either separator), without control or Unicode format characters
/// (bidi overrides, zero-width chars), without leading dots or whitespace, at
/// most [`MAX_DOWNLOAD_NAME_BYTES`] bytes (extension kept where possible, so a
/// " (n)" suffix still fits within NAME_MAX = 255 bytes). Unusable names become
/// [`DEFAULT_DOWNLOAD_NAME`].
pub fn sanitize_download_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !crate::origin::is_format_char(*c))
        .collect();
    let cleaned = cleaned
        .trim_start_matches(|c: char| c == '.' || c.is_whitespace())
        .trim_end();
    if cleaned.is_empty() {
        return DEFAULT_DOWNLOAD_NAME.to_string();
    }
    truncate_name_bytes(cleaned, MAX_DOWNLOAD_NAME_BYTES)
}

/// Maximum download file name length in bytes. Linux NAME_MAX is 255 bytes;
/// the rest leaves room for a " (n)" collision suffix.
pub const MAX_DOWNLOAD_NAME_BYTES: usize = 200;

/// Longest extension (bytes, dot included) kept when a name is shortened.
const MAX_KEPT_EXT_BYTES: usize = 20;

/// Shortens `name` to at most `max` bytes on a char boundary, keeping a short
/// extension (`.pdf`) when there is one.
fn truncate_name_bytes(name: &str, max: usize) -> String {
    if name.len() <= max {
        return name.to_string();
    }
    let ext = match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= MAX_KEPT_EXT_BYTES => &name[i..],
        _ => "",
    };
    let stem = &name[..name.len() - ext.len()];
    format!("{}{ext}", truncate_bytes(stem, max - ext.len()))
}

/// Longest prefix of `s` with at most `max` bytes that ends on a char boundary.
fn truncate_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// `dir/name`, or `dir/stem (n).ext` for the first `n` that does not exist, so
/// an existing file is never overwritten. `exists` is injected for tests.
pub fn unique_download_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1u32..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !exists(p))
        .expect("unbounded counter finds a free name")
}

/// Clamps an unread count to `0..=9999`.
pub fn clamp_badge(count: i64) -> i64 {
    count.clamp(0, MAX_BADGE)
}

fn is_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// `^[0-9A-Z]{26}$`
pub fn is_ulid(s: &str) -> bool {
    s.len() == 26
        && s.bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
}

fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => s[..idx].to_string(),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ULID: &str = "01HZX3K7Q9M2N4P6R8T0V2W4Y6";

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn origin() -> Url {
        app_origin("http://localhost:8787").unwrap()
    }

    // ---- app_origin ----

    #[test]
    fn app_origin_accepts_http_and_https_bare_origins() {
        assert_eq!(
            app_origin("http://localhost:8787").unwrap().as_str(),
            "http://localhost:8787/"
        );
        assert_eq!(
            app_origin("http://localhost:8787/").unwrap().as_str(),
            "http://localhost:8787/"
        );
        assert_eq!(
            app_origin("https://chat.example.com").unwrap().as_str(),
            "https://chat.example.com/"
        );
    }

    #[test]
    fn app_origin_rejects_other_schemes() {
        for s in [
            "ftp://example.com",
            "file:///tmp/x",
            "javascript:alert(1)",
            "data:text/html,x",
            "backroom://auth",
        ] {
            assert_eq!(app_origin(s), Err(PolicyError::UnsupportedScheme), "{s}");
        }
    }

    #[test]
    fn app_origin_rejects_paths_queries_fragments_credentials() {
        for s in [
            "http://localhost:8787/app",
            "http://localhost:8787/?x=1",
            "http://localhost:8787/#frag",
            "http://user:pw@localhost:8787",
        ] {
            assert_eq!(app_origin(s), Err(PolicyError::NotAnOrigin), "{s}");
        }
    }

    #[test]
    fn app_origin_rejects_garbage() {
        assert_eq!(app_origin("not a url"), Err(PolicyError::InvalidUrl));
        assert_eq!(app_origin(""), Err(PolicyError::InvalidUrl));
    }

    // ---- nav_decision ----

    #[test]
    fn same_origin_is_allowed() {
        let o = origin();
        assert_eq!(nav_decision(&u("http://localhost:8787/"), &o), Nav::Allow);
        assert_eq!(
            nav_decision(&u("http://localhost:8787/c/abc?x=1#m"), &o),
            Nav::Allow
        );
    }

    #[test]
    fn default_port_matches_explicit_port() {
        let o = app_origin("https://chat.example.com").unwrap();
        assert_eq!(
            nav_decision(&u("https://chat.example.com:443/x"), &o),
            Nav::Allow
        );
    }

    #[test]
    fn origin_port_mismatch_opens_external() {
        assert_eq!(
            nav_decision(&u("http://localhost:8788/"), &origin()),
            Nav::OpenExternal
        );
    }

    #[test]
    fn scheme_or_host_mismatch_opens_external() {
        let o = origin();
        assert_eq!(
            nav_decision(&u("https://localhost:8787/"), &o),
            Nav::OpenExternal
        );
        assert_eq!(
            nav_decision(&u("http://127.0.0.1:8787/"), &o),
            Nav::OpenExternal
        );
        assert_eq!(
            nav_decision(&u("https://example.com/"), &o),
            Nav::OpenExternal
        );
        assert_eq!(
            nav_decision(&u("http://localhost.evil.com:8787/"), &o),
            Nav::OpenExternal
        );
    }

    #[test]
    fn non_http_schemes_are_dropped() {
        let o = origin();
        for s in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "about:blank",
            "blob:http://localhost:8787/1234",
            "ftp://example.com/",
            "backroom://channel/01HZX3K7Q9M2N4P6R8T0V2W4Y6",
            "mailto:a@example.com",
        ] {
            assert_eq!(nav_decision(&u(s), &o), Nav::Drop, "{s}");
        }
    }

    #[test]
    fn urls_with_userinfo_are_dropped() {
        let o = origin();
        for s in [
            "http://user@localhost:8787/",
            "http://user:pw@localhost:8787/x",
            "http://:pw@localhost:8787/",
            "https://localhost:8787@evil.com/",
            "https://user@example.com/",
        ] {
            assert_eq!(nav_decision(&u(s), &o), Nav::Drop, "{s}");
        }
    }

    // ---- setup page (no server yet) ----

    #[test]
    fn app_local_is_only_the_webviews_own_origin() {
        // Per platform: the other platform's spelling is refused.
        #[cfg(not(windows))]
        let (own, foreign) = (
            ["tauri://localhost", "tauri://localhost/index.html"],
            [
                "http://tauri.localhost/",
                "https://tauri.localhost/setup.js",
            ],
        );
        #[cfg(windows)]
        let (own, foreign) = (
            [
                "http://tauri.localhost/",
                "https://tauri.localhost/setup.js",
            ],
            ["tauri://localhost", "tauri://localhost/index.html"],
        );
        for ok in own {
            assert!(is_app_local(&u(ok)), "{ok}");
        }
        for bad in foreign {
            assert!(!is_app_local(&u(bad)), "{bad}");
        }
        for bad in [
            "tauri://evil/",
            "tauri://localhost:1/",
            "http://localhost/",
            "http://localhost:8787/",
            "https://tauri.localhost.evil.com/",
            "http://x.tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://user@tauri.localhost/",
            "ipc://localhost/",
            "file:///index.html",
            "about:blank",
        ] {
            assert!(!is_app_local(&u(bad)), "{bad}");
        }
    }

    #[test]
    fn without_a_server_only_the_setup_page_loads() {
        #[cfg(not(windows))]
        let (own, foreign) = ("tauri://localhost/index.html", "http://tauri.localhost/");
        #[cfg(windows)]
        let (own, foreign) = ("http://tauri.localhost/", "tauri://localhost/index.html");
        assert_eq!(window_nav(&u(own), None), Nav::Allow);
        assert_eq!(window_nav(&u(foreign), None), Nav::Drop);
        for s in [
            "https://chat.example.com/",
            "http://localhost:8787/",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "about:blank",
            "tauri://evil/",
        ] {
            assert_eq!(window_nav(&u(s), None), Nav::Drop, "{s}");
        }
    }

    #[test]
    fn with_a_server_the_setup_page_is_out_of_reach() {
        let o = origin();
        assert_eq!(
            window_nav(&u("http://localhost:8787/x"), Some(&o)),
            Nav::Allow
        );
        assert_eq!(
            window_nav(&u("https://example.com/"), Some(&o)),
            Nav::OpenExternal
        );
        assert_eq!(window_nav(&u("tauri://localhost/"), Some(&o)), Nav::Drop);
        for s in [
            "https://chat.example.com/",
            "javascript:x",
            "http://localhost:8787/",
        ] {
            assert_eq!(window_nav(&u(s), Some(&o)), nav_decision(&u(s), &o), "{s}");
        }
    }

    // ---- ExternalOpenLimiter ----

    #[test]
    fn external_opens_are_limited_to_one_per_second() {
        let mut limiter = ExternalOpenLimiter::default();
        let t0 = Instant::now();
        assert!(limiter.allow(t0));
        assert!(!limiter.allow(t0));
        assert!(!limiter.allow(t0 + Duration::from_millis(999)));
        assert!(limiter.allow(t0 + Duration::from_secs(1)));
        assert!(!limiter.allow(t0 + Duration::from_millis(1_500)));
        assert!(limiter.allow(t0 + Duration::from_millis(2_000)));
    }

    #[test]
    fn denied_opens_do_not_extend_the_window() {
        let mut limiter = ExternalOpenLimiter::default();
        let t0 = Instant::now();
        assert!(limiter.allow(t0));
        for ms in [100, 300, 600, 900] {
            assert!(!limiter.allow(t0 + Duration::from_millis(ms)));
        }
        assert!(limiter.allow(t0 + Duration::from_millis(1_000)));
    }

    // ---- downloads ----

    #[test]
    fn download_name_keeps_plain_names() {
        assert_eq!(sanitize_download_name("report.pdf"), "report.pdf");
        assert_eq!(
            sanitize_download_name("my photo (1).jpg"),
            "my photo (1).jpg"
        );
        assert_eq!(sanitize_download_name("résumé.txt"), "résumé.txt");
    }

    #[test]
    fn download_name_is_reduced_to_its_basename() {
        assert_eq!(sanitize_download_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_download_name("/tmp/x.sh"), "x.sh");
        assert_eq!(sanitize_download_name("..\\..\\win.ini"), "win.ini");
        assert_eq!(sanitize_download_name("a/b\\c.txt"), "c.txt");
    }

    #[test]
    fn download_name_drops_control_chars_and_leading_dots() {
        assert_eq!(sanitize_download_name("a\u{0}b\nc.txt"), "abc.txt");
        assert_eq!(sanitize_download_name(".bashrc"), "bashrc");
        assert_eq!(sanitize_download_name("...hidden"), "hidden");
        assert_eq!(sanitize_download_name("  spaced.txt  "), "spaced.txt");
        assert_eq!(sanitize_download_name(". .bashrc"), "bashrc");
        assert_eq!(sanitize_download_name(" . . .y"), "y");
        assert_eq!(sanitize_download_name(".\u{a0}.x"), "x");
        assert_eq!(sanitize_download_name("\u{202E}.hidden"), "hidden");
    }

    #[test]
    fn unusable_download_names_fall_back() {
        for s in ["", ".", "..", "/", "a/", "\u{7}", "   ", "..\\"] {
            assert_eq!(sanitize_download_name(s), DEFAULT_DOWNLOAD_NAME, "{s:?}");
        }
    }

    #[test]
    fn download_name_is_bounded_in_bytes_keeping_the_extension() {
        let long = format!("{}.txt", "a".repeat(5_000));
        let out = sanitize_download_name(&long);
        assert_eq!(out.len(), MAX_DOWNLOAD_NAME_BYTES);
        assert!(out.ends_with(".txt"));
        // 4-byte chars: cut on a char boundary, never above the limit.
        let multi = "😀".repeat(500);
        let out = sanitize_download_name(&multi);
        assert!(out.len() <= MAX_DOWNLOAD_NAME_BYTES);
        assert_eq!(out.len(), 200);
        assert!(multi.starts_with(&out));
        let multi_ext = format!("{}.pdf", "€".repeat(300));
        let out = sanitize_download_name(&multi_ext);
        assert!(out.len() <= MAX_DOWNLOAD_NAME_BYTES);
        assert!(out.ends_with(".pdf"));
        // A long "extension" is not kept whole.
        let long_ext = format!("x.{}", "e".repeat(400));
        assert_eq!(
            sanitize_download_name(&long_ext).len(),
            MAX_DOWNLOAD_NAME_BYTES
        );
        // Room for the collision suffix within NAME_MAX (255 bytes).
        assert!(MAX_DOWNLOAD_NAME_BYTES + " (4294967295)".len() <= 255);
        assert_eq!(sanitize_download_name("short.txt"), "short.txt");
    }

    #[test]
    fn download_name_strips_bidi_and_format_chars() {
        assert_eq!(sanitize_download_name("\u{202E}gpj.exe"), "gpj.exe");
        assert_eq!(
            sanitize_download_name("a\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}b.txt"),
            "ab.txt"
        );
        assert_eq!(
            sanitize_download_name("\u{2066}x\u{2067}\u{2068}\u{2069}.pdf"),
            "x.pdf"
        );
        assert_eq!(sanitize_download_name("\u{FEFF}\u{200B}z.txt"), "z.txt");
        assert_eq!(sanitize_download_name("\u{202E}"), DEFAULT_DOWNLOAD_NAME);
    }

    #[test]
    fn unique_path_uses_the_name_when_free() {
        let dir = Path::new("/home/u/Downloads");
        assert_eq!(
            unique_download_path(dir, "a.pdf", |_| false),
            dir.join("a.pdf")
        );
    }

    #[test]
    fn unique_path_never_overwrites() {
        let dir = Path::new("/home/u/Downloads");
        let taken = [
            dir.join("a.pdf"),
            dir.join("a (1).pdf"),
            dir.join("a (2).pdf"),
        ];
        assert_eq!(
            unique_download_path(dir, "a.pdf", |p| taken.iter().any(|t| t == p)),
            dir.join("a (3).pdf")
        );
        let taken = [dir.join("notes")];
        assert_eq!(
            unique_download_path(dir, "notes", |p| taken.iter().any(|t| t == p)),
            dir.join("notes (1)")
        );
        let taken = [dir.join("x.tar.gz")];
        assert_eq!(
            unique_download_path(dir, "x.tar.gz", |p| taken.iter().any(|t| t == p)),
            dir.join("x.tar (1).gz")
        );
    }

    // ---- parse_deep_link ----

    #[test]
    fn auth_link_with_valid_code() {
        let code = "abcDEF0123_-xyz";
        assert_eq!(
            parse_deep_link(&format!("backroom://auth?code={code}")),
            Some(DeepLink::Auth {
                code: code.to_string()
            })
        );
    }

    #[test]
    fn auth_code_length_bounds() {
        let min = "a".repeat(10);
        let max = "a".repeat(100);
        assert!(parse_deep_link(&format!("backroom://auth?code={min}")).is_some());
        assert!(parse_deep_link(&format!("backroom://auth?code={max}")).is_some());
        assert_eq!(
            parse_deep_link(&format!("backroom://auth?code={}", "a".repeat(9))),
            None
        );
        assert_eq!(
            parse_deep_link(&format!("backroom://auth?code={}", "a".repeat(101))),
            None
        );
    }

    #[test]
    fn auth_oversized_code_is_rejected() {
        assert_eq!(
            parse_deep_link(&format!("backroom://auth?code={}", "A".repeat(10_000))),
            None
        );
    }

    #[test]
    fn auth_code_with_path_chars_is_rejected() {
        assert_eq!(parse_deep_link("backroom://auth?code=../x"), None);
        assert_eq!(
            parse_deep_link("backroom://auth?code=..%2Fxxxxxxxxxx"),
            None
        );
        assert_eq!(parse_deep_link("backroom://auth?code=abcdefghij+k"), None);
    }

    #[test]
    fn auth_link_shape_is_strict() {
        let c = "abcdefghijkl";
        for s in [
            format!("backroom://auth?code={c}&x=1"),
            format!("backroom://auth?x=1&code={c}"),
            format!("backroom://auth?code={c}#frag"),
            format!("backroom://auth/?code={c}"),
            format!("backroom://auth/x?code={c}"),
            format!("backroom://AUTH?code={c}"),
            format!("backroom://user@auth?code={c}"),
            format!("backroom://auth:1?code={c}"),
            format!("https://auth?code={c}"),
            format!("backroom:auth?code={c}"),
            "backroom://auth".to_string(),
            "backroom://auth?code=".to_string(),
        ] {
            assert_eq!(parse_deep_link(&s), None, "{s}");
        }
    }

    #[test]
    fn channel_link_with_valid_ulid() {
        assert_eq!(
            parse_deep_link(&format!("backroom://channel/{ULID}")),
            Some(DeepLink::Channel {
                id: ULID.to_string()
            })
        );
    }

    #[test]
    fn channel_lowercase_ulid_is_rejected() {
        assert_eq!(
            parse_deep_link(&format!("backroom://channel/{}", ULID.to_lowercase())),
            None
        );
    }

    #[test]
    fn channel_link_shape_is_strict() {
        for s in [
            format!("backroom://channel/{ULID}/"),
            format!("backroom://channel/{ULID}?x=1"),
            format!("backroom://channel/{ULID}#x"),
            format!("backroom://channel/{}", &ULID[..25]),
            format!("backroom://channel/{ULID}0"),
            format!("backroom://channel//{ULID}"),
            format!("backroom://channel/../{ULID}"),
            format!("backroom://CHANNEL/{ULID}"),
            format!("backroom://other/{ULID}"),
            "backroom://channel".to_string(),
            "".to_string(),
            "garbage".to_string(),
        ] {
            assert_eq!(parse_deep_link(&s), None, "{s}");
        }
    }

    // ---- desktop_auth_url ----

    #[test]
    fn desktop_auth_url_carries_code_and_verifier_in_the_fragment() {
        let url = desktop_auth_url(&origin(), "abcDEF0123_-xyz", "vErIfIeR-_0");
        assert_eq!(
            url.as_str(),
            "http://localhost:8787/desktop-auth#code=abcDEF0123_-xyz&verifier=vErIfIeR-_0"
        );
        assert_eq!(url.query(), None);
        assert_eq!(nav_decision(&url, &origin()), Nav::Allow);
        let https = app_origin("https://chat.example.com").unwrap();
        assert_eq!(
            desktop_auth_url(&https, "c", "v").as_str(),
            "https://chat.example.com/desktop-auth#code=c&verifier=v"
        );
    }

    // ---- validate_notify ----

    #[test]
    fn notify_passes_short_values_through() {
        assert_eq!(
            validate_notify("Hi", "there", ULID),
            Ok(("Hi".to_string(), "there".to_string(), ULID.to_string()))
        );
    }

    #[test]
    fn notify_truncates_body_to_1000_chars() {
        let body = "b".repeat(1_001);
        let (_, b, _) = validate_notify("t", &body, ULID).unwrap();
        assert_eq!(b.chars().count(), 1_000);
        let exact = "b".repeat(1_000);
        assert_eq!(validate_notify("t", &exact, ULID).unwrap().1, exact);
    }

    #[test]
    fn notify_truncates_title_to_200_chars() {
        let (t, _, _) = validate_notify(&"t".repeat(500), "b", ULID).unwrap();
        assert_eq!(t.chars().count(), 200);
    }

    #[test]
    fn notify_truncates_multibyte_title_without_panicking() {
        // 3- and 4-byte chars, so byte index 200 is not a char boundary.
        let title = "€😀".repeat(150);
        let (t, _, _) = validate_notify(&title, "b", ULID).unwrap();
        assert_eq!(t.chars().count(), 200);
        assert!(title.starts_with(&t));
        let body = "😀".repeat(1_500);
        let (_, b, _) = validate_notify("t", &body, ULID).unwrap();
        assert_eq!(b.chars().count(), 1_000);
    }

    #[test]
    fn notify_rejects_bad_channel_ids() {
        for id in [
            "",
            "abc",
            &ULID.to_lowercase(),
            &ULID[..25],
            &format!("{ULID}0"),
            "01HZX3K7Q9M2N4P6R8T0V2W4Y!",
        ] {
            assert_eq!(
                validate_notify("t", "b", id),
                Err(PolicyError::InvalidChannelId),
                "{id}"
            );
        }
    }

    // ---- clamp_badge ----

    #[test]
    fn badge_is_clamped() {
        assert_eq!(clamp_badge(-5), 0);
        assert_eq!(clamp_badge(i64::MIN), 0);
        assert_eq!(clamp_badge(0), 0);
        assert_eq!(clamp_badge(42), 42);
        assert_eq!(clamp_badge(9_999), 9_999);
        assert_eq!(clamp_badge(10_000_000), 9_999);
        assert_eq!(clamp_badge(i64::MAX), 9_999);
    }
}
