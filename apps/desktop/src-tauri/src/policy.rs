//! Pure policy decisions for the desktop shell: which URLs may load in the app
//! window, which deep links are accepted, and how command arguments are
//! bounded. No Tauri types here, so everything is unit-testable.

use std::fmt;
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
/// anything else → `Drop`.
pub fn nav_decision(target: &Url, origin: &Url) -> Nav {
    if !is_http(target) {
        return Nav::Drop;
    }
    // `Url::origin` compares scheme, host and port (default ports normalised).
    if is_http(origin) && target.origin() == origin.origin() {
        Nav::Allow
    } else {
        Nav::OpenExternal
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

/// Clamps an unread count to `0..=9999`.
pub fn clamp_badge(count: i64) -> i64 {
    count.clamp(0, MAX_BADGE)
}

fn is_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// `^[0-9A-Z]{26}$`
fn is_ulid(s: &str) -> bool {
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
