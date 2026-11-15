//! The server address the app connects to, chosen at runtime (P8-R1).
//!
//! - [`normalize_server_url`] turns what a user typed into a bare origin, or
//!   refuses it. It is the only way a [`ServerOrigin`] is made, for typed input,
//!   for the stored file and for the build-time default alike.
//! - `server.json` in the app config dir holds `{"serverUrl": "<origin>"}` or
//!   `{"serverUrl": null}` (the user chose "Change server…"). The file is never
//!   trusted: [`load_config`] re-normalises it, and anything unexpected is
//!   [`Stored::Invalid`], which shows the setup page.
//! - [`resolve_start`] applies the precedence: stored config, then the optional
//!   build-time default, then the setup page.
//! - [`check_health`] asks `<origin>/health` whether a Backroom server answers.
//!
//! No Tauri types here (except the managed [`ServerState`] wrapper), so the
//! rules are unit-testable.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use url::{Host, Url};

use crate::policy;

/// File name inside the app config dir.
pub const CONFIG_FILE: &str = "server.json";
/// Longest accepted input: a 253-char DNS name plus room for scheme and port.
pub const MAX_INPUT_CHARS: usize = 253 + 10;
/// A larger `server.json` is not ours: it is ignored.
pub const MAX_CONFIG_BYTES: u64 = 4096;
/// Total time budget for the `/health` check.
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);
/// Largest `/health` body read; the real one is 11 bytes.
pub const MAX_HEALTH_BODY: u64 = 1024;

/// A validated server origin: http(s), host, optional non-default port, nothing
/// else. `url()` ends with `/` (as [`policy::app_origin`] returns it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerOrigin {
    url: Url,
    insecure: bool,
}

impl ServerOrigin {
    /// The origin as a URL with path `/`, e.g. `https://chat.example.com/`.
    pub fn url(&self) -> &Url {
        &self.url
    }

    /// The origin as text, e.g. `https://chat.example.com` (punycode, no slash).
    pub fn origin(&self) -> String {
        self.url.origin().ascii_serialization()
    }

    /// Plain http (allowed only for local and private-network hosts).
    pub fn insecure(&self) -> bool {
        self.insecure
    }
}

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

/// Normalises a typed server address to its origin.
///
/// Trims; adds `https://` when there is no scheme; accepts http and https only;
/// rejects credentials, any path other than `/`, a query or fragment (even an
/// empty one), whitespace or backslashes inside, empty or reserved hosts
/// (`*.localhost`, which the webview uses for its own origins) and input over
/// [`MAX_INPUT_CHARS`]. Plain http is allowed only for `localhost`, loopback
/// and RFC 1918 addresses and `.local` names (`insecure: true`). Hosts come out
/// lowercased and punycoded, default ports are dropped.
pub fn normalize_server_url(input: &str) -> Result<ServerOrigin, ConfigError> {
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
            .any(|c| c.is_whitespace() || c.is_control() || policy::is_format_char(c))
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
    // The same checks the build-time origin always had, never weaker.
    let url = policy::app_origin(&url.origin().ascii_serialization())
        .map_err(|_| ConfigError::InvalidUrl)?;
    verify_pattern(&url)?;
    Ok(ServerOrigin { url, insecure })
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

/// The capability URL pattern for `origin`: `<scheme>://<host>[:port]/*`,
/// with URLPattern syntax characters in the host escaped (an IPv6 literal's
/// colons would otherwise make Tauri's parser panic inside `add_capability`).
pub fn remote_pattern(origin: &Url) -> String {
    let host: String = origin
        .host_str()
        .unwrap_or_default()
        .chars()
        .flat_map(|c| {
            let special = matches!(c, '\\' | ':' | '*' | '?' | '+' | '(' | ')' | '{' | '}');
            special.then_some('\\').into_iter().chain([c])
        })
        .collect();
    let port = origin.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{}://{host}{port}/*", origin.scheme())
}

/// Parses `origin`'s pattern exactly as Tauri will, and checks that it matches
/// the origin and not its neighbours. A `ServerOrigin` only exists after this
/// passed, so nothing saved or loaded can reach the capability builder with a
/// pattern that panics it or matches more than one origin.
fn verify_pattern(origin: &Url) -> Result<(), ConfigError> {
    let pattern: tauri::utils::acl::RemoteUrlPattern = remote_pattern(origin)
        .parse()
        .map_err(|_| ConfigError::UnusableOrigin)?;
    let mut other_port = origin.clone();
    let _ = other_port.set_port(Some(origin.port_or_known_default().map_or(1, |p| p ^ 1)));
    let mut other_scheme = origin.clone();
    let _ = other_scheme.set_scheme(if origin.scheme() == "http" {
        "https"
    } else {
        "http"
    });
    let with_path = origin
        .join("/x?y#z")
        .map_err(|_| ConfigError::UnusableOrigin)?;
    let other_host = Url::parse("https://backroom-pattern-check.invalid/").expect("static URL");
    if pattern.test(origin)
        && pattern.test(&with_path)
        && !pattern.test(&other_port)
        && !pattern.test(&other_scheme)
        && !pattern.test(&other_host)
    {
        Ok(())
    } else {
        Err(ConfigError::UnusableOrigin)
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

/// What `server.json` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stored {
    /// No file: the build-time default (if any) applies.
    Missing,
    /// `{"serverUrl": null}`: the user asked to choose a server.
    Cleared,
    /// Unreadable, oversized, not JSON, wrong shape or a refused address.
    Invalid,
    /// A valid, re-normalised origin.
    Server(ServerOrigin),
}

/// Parses the file's bytes. Never trusts the stored string: it goes through
/// [`normalize_server_url`] again.
pub fn parse_config(bytes: &[u8]) -> Stored {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Stored::Invalid;
    };
    let Some(object) = value.as_object() else {
        return Stored::Invalid;
    };
    match object.get("serverUrl") {
        None | Some(serde_json::Value::Null) => Stored::Cleared,
        Some(serde_json::Value::String(raw)) => {
            normalize_server_url(raw).map_or(Stored::Invalid, Stored::Server)
        }
        Some(_) => Stored::Invalid,
    }
}

/// Reads `<dir>/server.json`. Only a regular file is read (a FIFO or a
/// directory under that name is `Invalid`, never waited on).
pub fn load_config(dir: &Path) -> Stored {
    let path = dir.join(CONFIG_FILE);
    match fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_CONFIG_BYTES => {}
        Ok(_) => return Stored::Invalid,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Stored::Missing,
        Err(_) => return Stored::Invalid,
    }
    let Ok(file) = File::open(&path) else {
        return Stored::Invalid;
    };
    let mut bytes = Vec::new();
    match file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes) {
        Ok(n) if n as u64 <= MAX_CONFIG_BYTES => parse_config(&bytes),
        _ => Stored::Invalid,
    }
}

/// Writes `<dir>/server.json` atomically (temp file, fsync, rename). The dir
/// is created 0700 and the file 0600 on Unix. `None` writes the "cleared"
/// state that makes the next start show the setup page.
pub fn save_config(dir: &Path, server: Option<&ServerOrigin>) -> io::Result<()> {
    create_private_dir(dir)?;
    let body = serde_json::json!({ "serverUrl": server.map(ServerOrigin::origin) }).to_string();
    let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
    // A leftover from a crash (or anything planted there) is removed, never
    // followed: `create_new` refuses to open an existing path or symlink.
    match fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp, dir.join(CONFIG_FILE))
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    // Make the rename itself durable (best effort; not possible on Windows).
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Creates `dir` (and parents) and makes it owner-only on Unix.
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// What the main window loads at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Start {
    Remote(ServerOrigin),
    Setup,
}

/// Precedence: a valid stored origin, then (only when there is no file at all)
/// the build-time default, then the setup page. A cleared or invalid file
/// shows the setup page even when a build-time default exists.
pub fn resolve_start(stored: &Stored, build_default: Option<&str>) -> Start {
    match stored {
        Stored::Server(origin) => Start::Remote(origin.clone()),
        Stored::Missing => build_default
            .and_then(|raw| normalize_server_url(raw).ok())
            .map_or(Start::Setup, Start::Remote),
        Stored::Cleared | Stored::Invalid => Start::Setup,
    }
}

/// Why the `/health` check failed. `Display` is the text the setup page shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthError {
    Unreachable,
    Timeout,
    Untrusted,
    TlsFailed,
    Redirect,
    Status,
    NotBackroom,
}

impl fmt::Display for HealthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            HealthError::Unreachable => {
                "Could not reach the server. Check the address and your connection."
            }
            HealthError::Timeout => "The server did not answer within 5 seconds.",
            HealthError::Untrusted => "The server's certificate is not trusted by this computer.",
            HealthError::TlsFailed => "Could not set up a secure connection to the server.",
            HealthError::Redirect => {
                "The server sent the app to another address. Enter that final address instead."
            }
            HealthError::Status => "The server answered, but it is not healthy right now.",
            HealthError::NotBackroom => "That address does not look like a Backroom server.",
        })
    }
}

impl std::error::Error for HealthError {}

/// Judges a `/health` response: exactly HTTP 200 with the JSON `{"ok":true}`.
pub fn health_result(status: u16, body: &[u8]) -> Result<(), HealthError> {
    if (300..400).contains(&status) {
        return Err(HealthError::Redirect);
    }
    if status != 200 {
        return Err(HealthError::Status);
    }
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(v) if v == serde_json::json!({ "ok": true }) => Ok(()),
        _ => Err(HealthError::NotBackroom),
    }
}

/// `GET <origin>/health` with a total `timeout`, no redirects (a redirect must
/// not move the origin silently), a body cap and the User-Agent
/// `Backroom-Desktop/<version>`. Blocking: run it off the main thread.
pub fn check_health(origin: &ServerOrigin, timeout: Duration) -> Result<(), HealthError> {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    // Certificates are verified against the OS trust store (as the webview
    // does), so a server signed by an internal CA installed on this computer
    // passes; verification is never turned off.
    let tls = TlsConfig::builder()
        .provider(TlsProvider::Rustls)
        .root_certs(RootCerts::PlatformVerifier)
        .build();
    let mut config = ureq::Agent::config_builder()
        .tls_config(tls)
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent(format!("Backroom-Desktop/{}", env!("CARGO_PKG_VERSION")));
    // Proxies: ureq reads ALL_PROXY / HTTPS_PROXY / HTTP_PROXY (and NO_PROXY)
    // from the environment, while the webview follows the desktop's system
    // proxy settings, so the two can differ. The environment proxy is used
    // for public servers only; local and private-network servers are always
    // reached directly.
    if origin.insecure() {
        config = config.proxy(None);
    }
    let agent: ureq::Agent = config.build().into();
    let url = origin
        .url()
        .join("health")
        .map_err(|_| HealthError::Unreachable)?;
    let mut response = agent
        .get(url.as_str())
        .header("Accept", "application/json")
        .call()
        .map_err(|e| classify_error(&e))?;
    let status = response.status().as_u16();
    if status != 200 {
        return health_result(status, &[]);
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_HEALTH_BODY)
        .read_to_vec()
        .map_err(|e| match e {
            ureq::Error::Timeout(_) => HealthError::Timeout,
            _ => HealthError::NotBackroom,
        })?;
    health_result(status, &body)
}

/// Maps a request error to what the user is told.
pub fn classify_error(e: &ureq::Error) -> HealthError {
    match e {
        ureq::Error::Timeout(_) => HealthError::Timeout,
        ureq::Error::Rustls(tls) => classify_tls(tls),
        ureq::Error::Tls(_) => HealthError::TlsFailed,
        ureq::Error::Io(io) => match io.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
            Some(tls) => classify_tls(tls),
            None if io.kind() == io::ErrorKind::TimedOut => HealthError::Timeout,
            None => HealthError::Unreachable,
        },
        _ => HealthError::Unreachable,
    }
}

fn classify_tls(e: &rustls::Error) -> HealthError {
    match e {
        rustls::Error::InvalidCertificate(_) | rustls::Error::NoCertificatesPresented => {
            HealthError::Untrusted
        }
        _ => HealthError::TlsFailed,
    }
}

/// Managed state: the origin this process serves (fixed at startup, or set
/// once by `save_server`) and where `server.json` lives. Every part of the
/// shell that needs the origin reads it here.
pub struct ServerState {
    origin: Mutex<Option<Url>>,
    dir: Option<PathBuf>,
}

impl ServerState {
    pub fn new(origin: Option<Url>, dir: Option<PathBuf>) -> Self {
        Self {
            origin: Mutex::new(origin),
            dir,
        }
    }

    /// The current origin; `None` while the setup page is showing.
    pub fn current(&self) -> Option<Url> {
        self.slot().clone()
    }

    pub fn config_dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    pub(crate) fn slot(&self) -> std::sync::MutexGuard<'_, Option<Url>> {
        self.origin.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
/// Every kind of origin the rules accept (C1: IPv6 used to panic Tauri's
/// URLPattern parser inside `add_capability`).
pub(crate) const ORIGIN_SHAPES: [&str; 13] = [
    "http://[::1]:8787",
    "http://[::1]",
    "https://[2001:db8::1]",
    "https://[2001:db8::1]:8443",
    "https://bücher.example",
    "https://chat.example.com",
    "https://chat.example.com:8443",
    "https://8.8.8.8:8443",
    "http://localhost",
    "http://localhost:8787",
    "http://192.168.1.20:8080",
    "http://10.0.0.5",
    "http://backroom.local:8787",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn ok(input: &str) -> ServerOrigin {
        normalize_server_url(input).unwrap_or_else(|e| panic!("{input}: {e:?}"))
    }

    fn origin_of(input: &str) -> String {
        ok(input).origin()
    }

    // ---- normalize_server_url ----

    #[test]
    fn plain_https_origins_are_kept() {
        assert_eq!(
            origin_of("https://chat.example.com"),
            "https://chat.example.com"
        );
        assert_eq!(
            origin_of("https://chat.example.com/"),
            "https://chat.example.com"
        );
        assert_eq!(
            origin_of("https://chat.example.com:8443"),
            "https://chat.example.com:8443"
        );
        let o = ok("https://chat.example.com");
        assert_eq!(o.url().as_str(), "https://chat.example.com/");
        assert!(!o.insecure());
    }

    #[test]
    fn input_is_trimmed_and_a_missing_scheme_becomes_https() {
        assert_eq!(
            origin_of("  chat.example.com  "),
            "https://chat.example.com"
        );
        assert_eq!(
            origin_of("chat.example.com:8443"),
            "https://chat.example.com:8443"
        );
        assert_eq!(origin_of("chat.example.com/"), "https://chat.example.com");
        assert_eq!(origin_of("localhost:8787"), "https://localhost:8787");
        assert_eq!(origin_of("[::1]:8443"), "https://[::1]:8443");
        assert_eq!(
            origin_of("\tchat.example.com\n"),
            "https://chat.example.com"
        );
    }

    #[test]
    fn hosts_are_lowercased_punycoded_and_default_ports_dropped() {
        assert_eq!(
            origin_of("HTTPS://Chat.Example.COM"),
            "https://chat.example.com"
        );
        assert_eq!(
            origin_of("https://chat.example.com:443"),
            "https://chat.example.com"
        );
        assert_eq!(origin_of("http://localhost:80"), "http://localhost");
        assert_eq!(
            origin_of("https://bücher.example"),
            "https://xn--bcher-kva.example"
        );
        assert_eq!(
            origin_of("https://BÜCHER.example"),
            "https://xn--bcher-kva.example"
        );
        // Odd IPv4 spellings become the canonical address.
        assert_eq!(origin_of("http://0x7f.1:8787"), "http://127.0.0.1:8787");
    }

    #[test]
    fn plain_http_is_allowed_only_on_local_and_private_hosts() {
        for input in [
            "http://localhost",
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://127.1.2.3",
            "http://[::1]:8787",
            "http://10.0.0.5",
            "http://172.16.0.1:3000",
            "http://172.31.255.254",
            "http://192.168.1.20:8080",
            "http://backroom.local",
            "http://chat.office.local:8787",
        ] {
            let o = ok(input);
            assert!(o.insecure(), "{input} is reported as insecure");
        }
        for input in [
            "http://chat.example.com",
            "http://example.com:8787",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://192.169.1.1",
            "http://11.0.0.1",
            "http://[2001:db8::1]",
            "http://local",
            "http://evil.local.example.com",
            "http://localhost.example.com",
        ] {
            assert_eq!(
                normalize_server_url(input),
                Err(ConfigError::InsecureHost),
                "{input}"
            );
        }
        // The same public hosts are fine over https.
        assert!(!ok("https://8.8.8.8").insecure());
        assert!(!ok("https://[2001:db8::1]").insecure());
        assert!(!ok("https://localhost:8443").insecure());
    }

    #[test]
    fn other_schemes_are_refused() {
        for input in [
            "javascript:alert(1)",
            "javascript://chat.example.com/%0aalert(1)",
            "file:///etc/passwd",
            "file://chat.example.com/",
            "data:text/html,hi",
            "ftp://chat.example.com",
            "ws://chat.example.com",
            "wss://chat.example.com",
            "backroom://auth",
            "tauri://localhost",
            "about:blank",
            "mailto:a@example.com",
            "blob:https://chat.example.com/1",
        ] {
            assert_eq!(
                normalize_server_url(input),
                Err(ConfigError::UnsupportedScheme),
                "{input}"
            );
        }
    }

    #[test]
    fn credentials_are_refused() {
        for input in [
            "https://user@chat.example.com",
            "https://user:pw@chat.example.com",
            "https://:pw@chat.example.com",
            "https://chat.example.com@evil.example",
            "http://user@localhost:8787",
        ] {
            assert_eq!(
                normalize_server_url(input),
                Err(ConfigError::Credentials),
                "{input}"
            );
        }
        // Without a scheme `user:` reads as one; refused either way.
        assert!(normalize_server_url("user:pw@chat.example.com").is_err());
    }

    #[test]
    fn paths_queries_and_fragments_are_refused() {
        for input in [
            "https://chat.example.com/app",
            "https://chat.example.com/app/",
            "https://chat.example.com//",
            "https://chat.example.com/?",
            "https://chat.example.com?x=1",
            "https://chat.example.com/#",
            "https://chat.example.com#frag",
            "chat.example.com/path",
            "https://chat.example.com/%2e%2e/",
            "https://evil.example/https://chat.example.com",
        ] {
            assert_eq!(
                normalize_server_url(input),
                Err(ConfigError::NotAnOrigin),
                "{input}"
            );
        }
    }

    #[test]
    fn empty_garbage_and_overlong_input_is_refused() {
        assert_eq!(normalize_server_url(""), Err(ConfigError::Empty));
        assert_eq!(normalize_server_url("   \t\n"), Err(ConfigError::Empty));
        for input in [
            "https://",
            "https:///",
            "http://:8787",
            "https://chat example.com",
            "https://chat.example.com\\@evil.example",
            "https:\\\\evil.example",
            "https://chat.example.com:99999",
            "https://chat.example.com.",
            "https://.example.com",
            "https://0.0.0.0",
            "https://[::]",
            "https://exa\u{0}mple.com",
            "https://exa\u{7f}mple.com",
            "https://chat.example.com\u{200b}x",
            "//chat.example.com",
            "::",
        ] {
            assert_eq!(
                normalize_server_url(input),
                Err(ConfigError::InvalidUrl),
                "{input:?}"
            );
        }
        let longest = format!("https://{}.example.com", "a".repeat(MAX_INPUT_CHARS - 20));
        assert_eq!(longest.chars().count(), MAX_INPUT_CHARS);
        assert!(!matches!(
            normalize_server_url(&longest),
            Err(ConfigError::TooLong)
        ));
        let too_long = format!("https://{}.example.com", "a".repeat(MAX_INPUT_CHARS - 19));
        assert_eq!(normalize_server_url(&too_long), Err(ConfigError::TooLong));
        assert_eq!(
            normalize_server_url(&"a".repeat(100_000)),
            Err(ConfigError::TooLong)
        );
    }

    #[test]
    fn the_webviews_own_origins_are_reserved() {
        for input in [
            "https://tauri.localhost",
            "http://tauri.localhost",
            "http://ipc.localhost",
            "https://asset.localhost",
            "http://x.y.localhost:8787",
        ] {
            assert_eq!(
                normalize_server_url(input),
                Err(ConfigError::ReservedHost),
                "{input}"
            );
        }
    }

    fn parsed_pattern(o: &ServerOrigin) -> tauri::utils::acl::RemoteUrlPattern {
        let pattern = remote_pattern(o.url());
        pattern
            .parse()
            .unwrap_or_else(|e| panic!("{pattern} does not parse: {e}"))
    }

    #[test]
    fn normalized_origins_pass_the_policy_check_and_its_capability_pattern() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        for input in ORIGIN_SHAPES {
            let o = ok(input);
            assert_eq!(policy::app_origin(o.url().as_str()).as_ref(), Ok(o.url()));
            assert_eq!(format!("{}/", o.origin()), o.url().as_str());
            // The capability the app would build carries exactly this pattern,
            // and the pattern parses (Tauri panics on one that does not).
            let CapabilityFile::Capability(cap) =
                crate::commands::remote_capability(o.url()).build()
            else {
                panic!("a single capability");
            };
            let urls = &cap.remote.as_ref().unwrap().urls;
            assert_eq!(urls, &vec![remote_pattern(o.url())], "{input}");
            parsed_pattern(&o);
        }
    }

    #[test]
    fn every_capability_pattern_matches_exactly_its_origin() {
        for input in ORIGIN_SHAPES {
            let o = ok(input);
            let pattern = parsed_pattern(&o);
            let url = o.url();
            assert!(pattern.test(url), "{input}");
            assert!(
                pattern.test(&url.join("/c/x?y=1#z").unwrap()),
                "{input} with a path"
            );
            let mut other_port = url.clone();
            other_port.set_port(Some(1)).unwrap();
            assert!(!pattern.test(&other_port), "{input} vs port 1");
            let mut other_scheme = url.clone();
            let flipped = if url.scheme() == "http" {
                "https"
            } else {
                "http"
            };
            other_scheme.set_scheme(flipped).unwrap();
            assert!(!pattern.test(&other_scheme), "{input} vs {flipped}");
            for other in [
                "https://other.example/",
                "http://other.example/",
                "https://[::2]:8787/",
                "http://[::1]:8788/",
                "https://[2001:db8::2]/",
                "http://127.0.0.1:8787/",
                "https://xn--bcher-kva.example.evil/",
            ] {
                let other = Url::parse(other).unwrap();
                if other.origin() != url.origin() {
                    assert!(!pattern.test(&other), "{input} matched {other}");
                }
            }
        }
    }

    #[test]
    fn ipv6_patterns_escape_their_colons() {
        assert_eq!(
            remote_pattern(ok("http://[::1]:8787").url()),
            r"http://[\:\:1]:8787/*"
        );
        assert_eq!(
            remote_pattern(ok("https://chat.example.com").url()),
            "https://chat.example.com/*"
        );
    }

    #[test]
    fn urlpattern_metacharacters_in_hosts_are_refused() {
        for input in [
            "https://*",
            "https://*/",
            "https://*.example.com",
            "https://a*b.example",
            "https://chat(x).example.com",
            "https://(x)",
            "https://{a}.example.com",
            "https://a{b}c",
            "https://a+.example.com",
            "https://a+b",
            "http://*.local",
            "http://localhost*",
            "https://a_b.example.com",
            "https://-a.example.com",
            "https://a-.example.com",
            "https://exa$mple.com",
            "https://a!b.example",
            "https://a'b.example",
            "https://a=b.example",
            "https://a&b.example",
            "https://a;b.example",
            "https://a,b.example",
            "https://a~b.example",
            "https://a|b.example",
            "https://a^b.example",
            "https://a\"b.example",
        ] {
            assert!(
                matches!(
                    normalize_server_url(input),
                    Err(ConfigError::InvalidHostName | ConfigError::InvalidUrl)
                ),
                "{input}: {:?}",
                normalize_server_url(input)
            );
        }
        // `?` and `:` end the host; refused for other reasons.
        for input in [
            "https://a?b.example",
            "https://a:b.example",
            "https://a?.example",
        ] {
            assert!(normalize_server_url(input).is_err(), "{input}");
        }
        let long_label = format!("https://{}.example", "a".repeat(64));
        assert_eq!(
            normalize_server_url(&long_label),
            Err(ConfigError::InvalidHostName)
        );
        let max_label = format!("https://{}.example", "a".repeat(63));
        assert!(normalize_server_url(&max_label).is_ok());
    }

    #[test]
    fn port_zero_is_refused() {
        for input in [
            "https://chat.example.com:0",
            "http://localhost:0",
            "http://[::1]:0",
        ] {
            assert_eq!(
                normalize_server_url(input),
                Err(ConfigError::InvalidUrl),
                "{input}"
            );
        }
    }

    #[test]
    fn error_messages_never_look_like_acl_denials() {
        // The ACL tests tell a command's own error from an ACL denial by the
        // words "not allowed"; no message here may contain them.
        let config = [
            ConfigError::Empty,
            ConfigError::TooLong,
            ConfigError::InvalidUrl,
            ConfigError::UnsupportedScheme,
            ConfigError::Credentials,
            ConfigError::NotAnOrigin,
            ConfigError::ReservedHost,
            ConfigError::InsecureHost,
            ConfigError::InvalidHostName,
            ConfigError::UnusableOrigin,
        ]
        .map(|e| e.to_string());
        let health = [
            HealthError::Unreachable,
            HealthError::Timeout,
            HealthError::Redirect,
            HealthError::Status,
            HealthError::NotBackroom,
            HealthError::Untrusted,
            HealthError::TlsFailed,
        ]
        .map(|e| e.to_string());
        for m in config.iter().chain(health.iter()) {
            assert!(!m.is_empty());
            assert!(!m.contains("not allowed"), "{m}");
        }
    }

    // ---- server.json ----

    static DIR_SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh scratch dir (removed by the caller via `cleanup`).
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "backroom-config-test-{}-{}-{name}",
            std::process::id(),
            DIR_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn parse_accepts_a_stored_origin_and_the_cleared_state() {
        assert_eq!(
            parse_config(br#"{"serverUrl":"https://chat.example.com"}"#),
            Stored::Server(ok("https://chat.example.com"))
        );
        assert_eq!(parse_config(br#"{"serverUrl":null}"#), Stored::Cleared);
        assert_eq!(parse_config(b"{}"), Stored::Cleared);
        // Re-normalised on load: a hand-edited but valid address is accepted
        // in its normal form.
        assert_eq!(
            parse_config(br#"{"serverUrl":"Chat.Example.com:443"}"#),
            Stored::Server(ok("https://chat.example.com"))
        );
    }

    #[test]
    fn a_hostile_or_broken_config_is_invalid() {
        for bytes in [
            &br#"{"serverUrl":"javascript:alert(1)"}"#[..],
            br#"{"serverUrl":"file:///etc/passwd"}"#,
            br#"{"serverUrl":"https://user:pw@evil.example"}"#,
            br#"{"serverUrl":"https://evil.example/phish"}"#,
            br#"{"serverUrl":"http://evil.example"}"#,
            br#"{"serverUrl":"https://tauri.localhost"}"#,
            br#"{"serverUrl":"https://evil.example/*"}"#,
            br#"{"serverUrl":""}"#,
            br#"{"serverUrl":42}"#,
            br#"{"serverUrl":["https://chat.example.com"]}"#,
            br#"["https://chat.example.com"]"#,
            br#""https://chat.example.com""#,
            b"null",
            b"",
            b"not json",
            br#"{"serverUrl":"https://chat.example.com""#,
            b"\xff\xfe",
        ] {
            assert_eq!(
                parse_config(bytes),
                Stored::Invalid,
                "{}",
                String::from_utf8_lossy(bytes)
            );
        }
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = scratch("roundtrip");
        assert_eq!(load_config(&dir), Stored::Missing, "no dir yet");
        let o = ok("https://chat.example.com:8443");
        save_config(&dir, Some(&o)).unwrap();
        assert_eq!(load_config(&dir), Stored::Server(o));
        let text = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert_eq!(
            text.trim_end(),
            r#"{"serverUrl":"https://chat.example.com:8443"}"#
        );
        save_config(&dir, None).unwrap();
        assert_eq!(load_config(&dir), Stored::Cleared);
        assert_eq!(
            fs::read_to_string(dir.join(CONFIG_FILE))
                .unwrap()
                .trim_end(),
            r#"{"serverUrl":null}"#
        );
        // No temp file is left behind.
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![CONFIG_FILE.to_string()]);
        cleanup(&dir);
    }

    #[test]
    fn save_replaces_a_stale_temp_file_or_symlink() {
        let dir = scratch("stale");
        fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
        fs::write(&tmp, "junk").unwrap();
        save_config(&dir, Some(&ok("https://a.example"))).unwrap();
        assert_eq!(load_config(&dir), Stored::Server(ok("https://a.example")));
        #[cfg(unix)]
        {
            let victim = dir.join("victim");
            fs::write(&victim, "keep").unwrap();
            std::os::unix::fs::symlink(&victim, &tmp).unwrap();
            save_config(&dir, Some(&ok("https://b.example"))).unwrap();
            assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
            assert_eq!(load_config(&dir), Stored::Server(ok("https://b.example")));
        }
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn config_dir_is_owner_only_and_the_file_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perms");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        save_config(&dir, Some(&ok("https://chat.example.com"))).unwrap();
        let dir_mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(dir.join(CONFIG_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        cleanup(&dir);
        assert_eq!(dir_mode, 0o700);
        assert_eq!(file_mode, 0o600);
    }

    #[test]
    fn load_ignores_hostile_oversized_and_non_regular_files() {
        let dir = scratch("hostile");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CONFIG_FILE);
        fs::write(&path, r#"{"serverUrl":"javascript:alert(1)"}"#).unwrap();
        assert_eq!(load_config(&dir), Stored::Invalid);
        let padded = format!(
            r#"{{"serverUrl":"https://chat.example.com","pad":"{}"}}"#,
            "x".repeat(MAX_CONFIG_BYTES as usize)
        );
        fs::write(&path, padded).unwrap();
        assert_eq!(load_config(&dir), Stored::Invalid, "oversized");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(load_config(&dir), Stored::Invalid, "a directory");
        fs::remove_dir(&path).unwrap();
        #[cfg(unix)]
        {
            // A FIFO would block a plain open forever.
            let status = std::process::Command::new("mkfifo").arg(&path).status();
            if status.is_ok_and(|s| s.success()) {
                assert_eq!(load_config(&dir), Stored::Invalid, "a FIFO");
            }
        }
        cleanup(&dir);
    }

    // ---- precedence ----

    #[test]
    fn stored_config_wins_over_the_build_default() {
        let stored = Stored::Server(ok("https://chat.example.com"));
        assert_eq!(
            resolve_start(&stored, Some("http://localhost:8788")),
            Start::Remote(ok("https://chat.example.com"))
        );
        assert_eq!(
            resolve_start(&stored, None),
            Start::Remote(ok("https://chat.example.com"))
        );
    }

    #[test]
    fn the_build_default_applies_only_without_a_file() {
        assert_eq!(
            resolve_start(&Stored::Missing, Some("http://localhost:8788")),
            Start::Remote(ok("http://localhost:8788"))
        );
        assert_eq!(resolve_start(&Stored::Missing, None), Start::Setup);
        assert_eq!(
            resolve_start(&Stored::Cleared, Some("http://localhost:8788")),
            Start::Setup,
            "Change server… must reach the setup page even with a default"
        );
        assert_eq!(
            resolve_start(&Stored::Invalid, Some("http://localhost:8788")),
            Start::Setup,
            "a hostile file never falls through to anything"
        );
        // A build default that fails the runtime rules is ignored.
        assert_eq!(
            resolve_start(&Stored::Missing, Some("http://chat.example.com")),
            Start::Setup
        );
    }

    // ---- /health ----

    #[test]
    fn health_requires_200_and_exactly_ok_true() {
        assert_eq!(health_result(200, br#"{"ok":true}"#), Ok(()));
        assert_eq!(health_result(200, b"{ \"ok\" : true }\n"), Ok(()));
        for (status, body, err) in [
            (200, &br#"{"ok":false}"#[..], HealthError::NotBackroom),
            (200, br#"{"ok":true,"x":1}"#, HealthError::NotBackroom),
            (200, br#"{"ok":"true"}"#, HealthError::NotBackroom),
            (200, b"<html>ok</html>", HealthError::NotBackroom),
            (200, b"", HealthError::NotBackroom),
            (204, b"", HealthError::Status),
            (
                503,
                br#"{"error":{"code":"unavailable"}}"#,
                HealthError::Status,
            ),
            (404, b"", HealthError::Status),
            (301, b"", HealthError::Redirect),
            (302, br#"{"ok":true}"#, HealthError::Redirect),
            (307, b"", HealthError::Redirect),
            (308, b"", HealthError::Redirect),
        ] {
            assert_eq!(health_result(status, body), Err(err), "{status}");
        }
    }

    /// A one-shot HTTP server on 127.0.0.1 (ports 8930-8989 only; 8990-8999
    /// are left for the unreachable test, so tests running in parallel never
    /// share a port). Returns the origin and the raw request it received.
    fn serve_once(
        response: Vec<u8>,
        delay: Duration,
    ) -> (ServerOrigin, std::thread::JoinHandle<String>) {
        let listener = (8930..=8989)
            .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
            .expect("a free port in 8930-8989");
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&buf[..n]),
                }
            }
            std::thread::sleep(delay);
            let _ = stream.write_all(&response);
            let _ = stream.flush();
            String::from_utf8_lossy(&request).into_owned()
        });
        (ok(&format!("http://127.0.0.1:{port}")), handle)
    }

    fn http_response(status: &str, extra: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn health_check_accepts_a_backroom_server_and_sends_only_the_app_user_agent() {
        let (origin, server) = serve_once(
            http_response("200 OK", "", r#"{"ok":true}"#),
            Duration::ZERO,
        );
        assert_eq!(check_health(&origin, HEALTH_TIMEOUT), Ok(()));
        let request = server.join().unwrap();
        let first = request.lines().next().unwrap();
        assert_eq!(first, "GET /health HTTP/1.1");
        let ua = format!("user-agent: Backroom-Desktop/{}", env!("CARGO_PKG_VERSION"));
        assert!(
            request.lines().any(|l| l.eq_ignore_ascii_case(&ua)),
            "{request}"
        );
        assert!(!request.to_ascii_lowercase().contains("cookie"));
        assert!(!request.to_ascii_lowercase().contains("authorization"));
    }

    #[test]
    fn health_check_does_not_follow_redirects() {
        let (origin, server) = serve_once(
            http_response("302 Found", "Location: https://evil.example/health\r\n", ""),
            Duration::ZERO,
        );
        assert_eq!(
            check_health(&origin, HEALTH_TIMEOUT),
            Err(HealthError::Redirect)
        );
        server.join().unwrap();
    }

    #[test]
    fn health_check_refuses_other_servers_and_huge_bodies() {
        let (origin, server) = serve_once(
            http_response("200 OK", "", "<html>hello</html>"),
            Duration::ZERO,
        );
        assert_eq!(
            check_health(&origin, HEALTH_TIMEOUT),
            Err(HealthError::NotBackroom)
        );
        server.join().unwrap();

        let huge = format!(r#"{{"ok":true,"pad":"{}"}}"#, "x".repeat(100_000));
        let (origin, server) = serve_once(http_response("200 OK", "", &huge), Duration::ZERO);
        assert_eq!(
            check_health(&origin, HEALTH_TIMEOUT),
            Err(HealthError::NotBackroom)
        );
        server.join().unwrap();

        let (origin, server) = serve_once(
            http_response("503 Service Unavailable", "", "{}"),
            Duration::ZERO,
        );
        assert_eq!(
            check_health(&origin, HEALTH_TIMEOUT),
            Err(HealthError::Status)
        );
        server.join().unwrap();
    }

    #[test]
    fn health_check_times_out() {
        let (origin, server) = serve_once(
            http_response("200 OK", "", r#"{"ok":true}"#),
            Duration::from_millis(1_500),
        );
        let started = std::time::Instant::now();
        assert_eq!(
            check_health(&origin, Duration::from_millis(300)),
            Err(HealthError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        server.join().unwrap();
    }

    #[test]
    fn request_errors_map_to_distinct_messages() {
        use rustls::{CertificateError, Error as TlsError};
        let untrusted = || TlsError::InvalidCertificate(CertificateError::UnknownIssuer);
        assert_eq!(
            classify_error(&ureq::Error::Rustls(untrusted())),
            HealthError::Untrusted
        );
        assert_eq!(
            classify_error(&ureq::Error::Rustls(TlsError::InvalidCertificate(
                CertificateError::Expired
            ))),
            HealthError::Untrusted
        );
        assert_eq!(
            classify_error(&ureq::Error::Rustls(TlsError::NoCertificatesPresented)),
            HealthError::Untrusted
        );
        // As it arrives from inside the TLS stream: an io::Error around it.
        let wrapped = io::Error::new(io::ErrorKind::InvalidData, untrusted());
        assert_eq!(
            classify_error(&ureq::Error::Io(wrapped)),
            HealthError::Untrusted
        );
        assert_eq!(
            classify_error(&ureq::Error::Rustls(TlsError::HandshakeNotComplete)),
            HealthError::TlsFailed
        );
        assert_eq!(
            classify_error(&ureq::Error::Tls("no TLS")),
            HealthError::TlsFailed
        );
        let refused = io::Error::from(io::ErrorKind::ConnectionRefused);
        assert_eq!(
            classify_error(&ureq::Error::Io(refused)),
            HealthError::Unreachable
        );
        assert_eq!(
            classify_error(&ureq::Error::Io(io::Error::from(io::ErrorKind::TimedOut))),
            HealthError::Timeout
        );
        assert_eq!(
            classify_error(&ureq::Error::HostNotFound),
            HealthError::Unreachable
        );
    }

    /// A TLS server on 127.0.0.1 with a fresh self-signed certificate (made
    /// with the `openssl` CLI; skipped when it is missing). The check must
    /// refuse it as untrusted: verification stays on.
    #[test]
    fn health_check_refuses_a_self_signed_certificate() {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer};
        let dir = scratch("tls");
        fs::create_dir_all(&dir).unwrap();
        let (key_pem, cert_der, key_der) = (
            dir.join("key.pem"),
            dir.join("cert.der"),
            dir.join("key.der"),
        );
        let made = std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
            ])
            .args([
                "-nodes",
                "-days",
                "2",
                "-subj",
                "/CN=localhost",
                "-outform",
                "DER",
            ])
            .args(["-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"])
            .arg("-keyout")
            .arg(&key_pem)
            .arg("-out")
            .arg(&cert_der)
            .output()
            .is_ok_and(|o| o.status.success())
            && std::process::Command::new("openssl")
                .args(["pkcs8", "-topk8", "-nocrypt", "-outform", "DER", "-in"])
                .arg(&key_pem)
                .arg("-out")
                .arg(&key_der)
                .output()
                .is_ok_and(|o| o.status.success());
        if !made {
            eprintln!("openssl CLI unavailable; skipping the live TLS test");
            cleanup(&dir);
            return;
        }
        let cert = CertificateDer::from(fs::read(&cert_der).unwrap());
        let key = PrivateKeyDer::try_from(fs::read(&key_der).unwrap()).unwrap();
        cleanup(&dir);
        let config = rustls::ServerConfig::builder_with_provider(std::sync::Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
        let listener = (8930..=8989)
            .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
            .expect("a free port in 8930-8989");
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut conn = rustls::ServerConnection::new(std::sync::Arc::new(config)).unwrap();
            let mut stream = rustls::Stream::new(&mut conn, &mut tcp);
            let mut buf = [0u8; 64];
            // The client aborts the handshake; this read just ends.
            let _ = stream.read(&mut buf);
        });
        // https on a loopback address is accepted by the rules.
        let origin = ok(&format!("https://127.0.0.1:{port}"));
        assert_eq!(
            check_health(&origin, HEALTH_TIMEOUT),
            Err(HealthError::Untrusted)
        );
        server.join().unwrap();
    }

    #[test]
    fn health_check_reports_an_unreachable_server() {
        // Bind then drop: nothing listens on that port any more.
        let port = (8990..=8999)
            .find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok())
            .map(|l| l.local_addr().unwrap().port())
            .unwrap();
        let origin = ok(&format!("http://127.0.0.1:{port}"));
        assert_eq!(
            check_health(&origin, HEALTH_TIMEOUT),
            Err(HealthError::Unreachable)
        );
    }
}
