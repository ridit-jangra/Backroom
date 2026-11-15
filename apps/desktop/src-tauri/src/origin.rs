//! The address rules for a server origin, with no dependency beyond `url`
//! and `std`, so `build.rs` applies exactly the same rules to the build-time
//! `BACKROOM_APP_URL` (via `#[path]`). The runtime adds two more checks on top
//! (`policy::app_origin` and the capability-pattern check in `config`).

use std::fmt;

use url::{Host, Url};

/// Longest accepted input: a 253-char DNS name plus room for scheme and port.
pub const MAX_INPUT_CHARS: usize = 253 + 10;

/// Why an address was refused. `Display` is the text the setup page shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigError {
    Empty,
    TooLong,
    InvalidUrl,
    UnsupportedScheme,
    Credentials,
    NotAnOrigin,
    ReservedHost,
    InsecureHost,
    InvalidHostName,
    UnusableOrigin,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ConfigError::Empty => "Enter your server's address.",
            ConfigError::TooLong => "That address is too long.",
            ConfigError::InvalidUrl => "That is not a valid server address.",
            ConfigError::UnsupportedScheme => {
                "Use an address that starts with https:// (or http:// on your own network)."
            }
            ConfigError::Credentials => "Leave any user name or password out of the address.",
            ConfigError::NotAnOrigin => {
                "Enter only the server address, without a path, \"?\" or \"#\"."
            }
            ConfigError::ReservedHost => "That address cannot be a Backroom server.",
            ConfigError::InvalidHostName => {
                "Server names may use only letters, digits, hyphens and dots."
            }
            ConfigError::UnusableOrigin => "The app cannot use this address.",
            ConfigError::InsecureHost => {
                "Use https:// for this server. Plain http:// works only for localhost, \
                 private network addresses and .local names."
            }
        })
    }
}

impl std::error::Error for ConfigError {}

/// Applies the address rules to typed (or stored, or build-time) input and
/// returns the parsed URL and whether it is plain http.
///
/// Trims; adds `https://` when there is no scheme; accepts http and https only;
/// rejects credentials, any path other than `/`, a query or fragment (even an
/// empty one), whitespace or backslashes inside, port 0, empty, non-LDH or
/// reserved hosts (`*.localhost`, which the webview uses for its own origins)
/// and input over [`MAX_INPUT_CHARS`]. Plain http is allowed only for
/// `localhost`, loopback and RFC 1918 addresses and `.local` names. Hosts come
/// out lowercased and punycoded, default ports are dropped.
pub fn check_origin(input: &str) -> Result<(Url, bool), ConfigError> {
    let s = input.trim();
    if s.is_empty() {
        return Err(ConfigError::Empty);
    }
    if s.chars().count() > MAX_INPUT_CHARS {
        return Err(ConfigError::TooLong);
    }
    // The URL parser silently drops tabs and newlines and reads `\` as `/`;
    // refuse them (and invisible format characters) instead of guessing.
    if s.starts_with('/')
        || s.contains('\\')
        || s.chars()
            .any(|c| c.is_whitespace() || c.is_control() || is_format_char(c))
    {
        return Err(ConfigError::InvalidUrl);
    }
    let candidate = if has_scheme(s) {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let url = Url::parse(&candidate).map_err(|_| ConfigError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ConfigError::UnsupportedScheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::Credentials);
    }
    // Checked on the raw text as well: the parser resolves `/%2e%2e/` and
    // `/./` to `/`, which must not pass for "no path".
    if !raw_path_is_empty(&candidate)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ConfigError::NotAnOrigin);
    }
    if url.port() == Some(0) {
        return Err(ConfigError::InvalidUrl);
    }
    let host = url.host().ok_or(ConfigError::InvalidUrl)?;
    match host {
        Host::Domain(d) => {
            if d.is_empty() || d.starts_with('.') || d.ends_with('.') {
                return Err(ConfigError::InvalidUrl);
            }
            if !is_ldh_hostname(d) {
                return Err(ConfigError::InvalidHostName);
            }
            // `*.localhost` names the webview's own origins (`tauri.localhost`,
            // `ipc.localhost`) on some platforms.
            if d.ends_with(".localhost") {
                return Err(ConfigError::ReservedHost);
            }
        }
        Host::Ipv4(ip) if ip.is_unspecified() || ip.is_broadcast() => {
            return Err(ConfigError::InvalidUrl)
        }
        Host::Ipv6(ip) if ip.is_unspecified() => return Err(ConfigError::InvalidUrl),
        _ => {}
    }
    let insecure = url.scheme() == "http";
    if insecure && !is_private_host(&host) {
        return Err(ConfigError::InsecureHost);
    }
    Ok((url, insecure))
}

/// True when `s` starts with a URL scheme. `host:port` (`chat.example.com:8443`,
/// `localhost:8787`) is not a scheme.
fn has_scheme(s: &str) -> bool {
    let Some(i) = s.find(':') else {
        return false;
    };
    let (scheme, rest) = (&s[..i], &s[i + 1..]);
    let valid = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid {
        return false;
    }
    let port = rest.split(['/', '?', '#']).next().unwrap_or("");
    !(!port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
}

/// The text after `scheme://authority` is empty or exactly `/`.
fn raw_path_is_empty(candidate: &str) -> bool {
    let Some((_, after)) = candidate.split_once("://") else {
        return false;
    };
    match after.find(['/', '?', '#']) {
        Some(i) => &after[i..] == "/",
        None => true,
    }
}

/// Hosts where plain http is acceptable: this machine, RFC 1918 networks and
/// mDNS `.local` names.
fn is_private_host(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(d) => *d == "localhost" || (d.len() > ".local".len() && d.ends_with(".local")),
        Host::Ipv4(ip) => ip.is_loopback() || ip.is_private(),
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

/// After IDNA: dot-separated LDH labels (`a-z`, `0-9`, `-`, 1-63 chars, no
/// leading or trailing hyphen), at most 253 chars. Everything else (`*`,
/// `(`, `+`, `_`, …) is refused: the URL parser keeps such characters, and
/// several are URLPattern syntax.
fn is_ldh_hostname(d: &str) -> bool {
    d.len() <= 253
        && d.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// Unicode general category Cf (format characters): bidi controls, zero-width
/// characters, BOM, tags and the like. A static table, so no extra crate.
pub fn is_format_char(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
    )
}
