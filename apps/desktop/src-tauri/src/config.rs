//! Which game server the desktop app talks to (docs/12-local-development.md, "Cliente de
//! escritorio"). Highest priority first:
//!
//! 1. `RPG_SERVER_URL` in the environment (one run, e.g. `make desktop-dev`).
//! 2. `server_url` in `config.json` inside the app's config directory (home testing,
//!    docs/13-hosting-de-pruebas.md).
//! 3. The default compiled into the binary: `RPG_DESKTOP_SERVER_URL` at build time
//!    (the release workflow sets it), else `http://localhost:8080` in debug builds and
//!    `PRODUCTION_PLACEHOLDER` in release builds.
//!
//! An override that is not a valid server URL is reported and skipped, so a typo never
//! points the app at an unexpected host.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use url::{Host, Url};

/// Release default when the build did not set `RPG_DESKTOP_SERVER_URL`.
pub const PRODUCTION_PLACEHOLDER: &str = "https://juego.example.com";

/// Name of the override file inside the app's config directory.
pub const CONFIG_FILE: &str = "config.json";

/// A validated game server: its HTTP origin (the API lives under `/api`) and the WebSocket
/// URL of `/ws`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Server {
    origin: Url,
}

impl Server {
    /// Parses a server URL: `https://host[:port]`, or `http://` only for this machine or a
    /// private network (LAN testing). No credentials, path, query or fragment.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let url = Url::parse(raw.trim()).map_err(|e| format!("{raw:?} is not a URL: {e}"))?;
        let host = url.host().ok_or_else(|| format!("{raw:?} has no host"))?;
        match url.scheme() {
            "https" => {}
            "http" if is_local(&host) => {}
            "http" => {
                return Err(format!(
                "{raw:?}: plain http is only allowed for localhost or a private network; use https"
            ))
            }
            other => return Err(format!("{raw:?}: scheme {other:?} is not http or https")),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(format!("{raw:?} must not contain credentials"));
        }
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return Err(format!(
                "{raw:?} must be just the server origin (no path, query or fragment)"
            ));
        }
        Ok(Self { origin: url })
    }

    /// `https://host[:port]`, without a trailing slash.
    pub fn origin(&self) -> String {
        self.origin.origin().ascii_serialization()
    }

    /// Absolute URL of an API path such as `/api/characters`.
    pub fn api_url(&self, path: &str) -> String {
        format!("{}{path}", self.origin())
    }

    /// `wss://host[:port]/ws` (`ws://` for a local http server).
    pub fn ws_url(&self) -> String {
        format!("{}/ws", self.ws_origin())
    }

    /// The WebSocket origin, for the CSP's `connect-src`.
    pub fn ws_origin(&self) -> String {
        let origin = self.origin();
        match origin.strip_prefix("https://") {
            Some(rest) => format!("wss://{rest}"),
            None => format!("ws://{}", origin.trim_start_matches("http://")),
        }
    }
}

fn is_local(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(d) => *d == "localhost" || d.ends_with(".localhost"),
        Host::Ipv4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Host::Ipv6(ip) => {
            let ip = IpAddr::V6(*ip);
            ip.is_loopback()
                || matches!(ip, IpAddr::V6(v6) if (v6.segments()[0] & 0xfe00) == 0xfc00)
        }
    }
}

/// Where the chosen server came from (logged on start).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Env,
    File,
    Default,
}

/// Picks the server from the candidates in priority order. Invalid overrides are skipped
/// and returned as warnings; an invalid compiled default is an error.
pub fn resolve(
    env: Option<&str>,
    file: Option<&str>,
    default: &str,
) -> Result<(Server, Source, Vec<String>), String> {
    let mut warnings = Vec::new();
    for (raw, source, what) in [
        (env, Source::Env, "RPG_SERVER_URL"),
        (file, Source::File, CONFIG_FILE),
    ] {
        let Some(raw) = raw.filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        match Server::parse(raw) {
            Ok(server) => return Ok((server, source, warnings)),
            Err(e) => warnings.push(format!("ignoring {what}: {e}")),
        }
    }
    let server = Server::parse(default).map_err(|e| format!("compiled default server: {e}"))?;
    Ok((server, Source::Default, warnings))
}

/// The `server_url` of a `config.json` body. Unknown keys are ignored so the file can grow.
pub fn server_url_from_file(body: &str) -> Result<Option<String>, String> {
    #[derive(serde::Deserialize)]
    struct File {
        server_url: Option<String>,
    }
    let file: File =
        serde_json::from_str(body).map_err(|e| format!("{CONFIG_FILE} is not valid: {e}"))?;
    Ok(file.server_url)
}

/// The compiled default for this build.
pub fn compiled_default() -> &'static str {
    match option_env!("RPG_DESKTOP_SERVER_URL") {
        Some(url) if !url.is_empty() => url,
        _ if cfg!(debug_assertions) => "http://localhost:8080",
        _ => PRODUCTION_PLACEHOLDER,
    }
}

/// `<config dir>/<identifier>/config.json`, the same directory as Tauri's
/// `app_config_dir()` (it is needed before the app exists, to set the CSP).
pub fn config_path(identifier: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(identifier).join(CONFIG_FILE))
}

/// Reads the override file, if any. A missing file is not an error.
pub fn read_file_override(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(body) => server_url_from_file(&body).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_and_derives_urls() {
        let s = Server::parse("https://juego.example.com/").unwrap();
        assert_eq!(s.origin(), "https://juego.example.com");
        assert_eq!(s.api_url("/api/play"), "https://juego.example.com/api/play");
        assert_eq!(s.ws_url(), "wss://juego.example.com/ws");
        assert_eq!(s.ws_origin(), "wss://juego.example.com");
        let s = Server::parse(" https://x.trycloudflare.com:8443 ").unwrap();
        assert_eq!(s.ws_url(), "wss://x.trycloudflare.com:8443/ws");
    }

    #[test]
    fn http_only_for_local_hosts() {
        for ok in [
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://192.168.1.20:8080",
            "http://10.0.0.5",
            "http://[::1]:8080",
        ] {
            let s = Server::parse(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
            assert!(s.ws_url().starts_with("ws://"), "{ok}");
        }
        assert_eq!(
            Server::parse("http://localhost:8080").unwrap().ws_url(),
            "ws://localhost:8080/ws"
        );
        for bad in ["http://juego.example.com", "http://8.8.8.8"] {
            assert!(Server::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_anything_but_an_origin() {
        for bad in [
            "",
            "juego.example.com",
            "ftp://juego.example.com",
            "file:///etc/passwd",
            "https://user:pw@juego.example.com",
            "https://juego.example.com/game",
            "https://juego.example.com/?x=1",
            "https://juego.example.com/#x",
        ] {
            assert!(Server::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn resolve_priority_and_fallbacks() {
        let d = "https://default.example.com";
        let (s, src, w) = resolve(
            Some("http://localhost:9000"),
            Some("https://f.example.com"),
            d,
        )
        .unwrap();
        assert_eq!(
            (s.origin().as_str(), src, w.len()),
            ("http://localhost:9000", Source::Env, 0)
        );

        let (s, src, _) = resolve(None, Some("https://f.example.com"), d).unwrap();
        assert_eq!(
            (s.origin().as_str(), src),
            ("https://f.example.com", Source::File)
        );

        let (s, src, _) = resolve(Some("  "), None, d).unwrap();
        assert_eq!(
            (s.origin().as_str(), src),
            ("https://default.example.com", Source::Default)
        );

        // An invalid override is skipped with a warning, never silently "fixed".
        let (s, src, w) = resolve(
            Some("http://evil.example.com"),
            Some("https://f.example.com"),
            d,
        )
        .unwrap();
        assert_eq!(
            (s.origin().as_str(), src, w.len()),
            ("https://f.example.com", Source::File, 1)
        );

        assert!(resolve(None, None, "not a url").is_err());
    }

    #[test]
    fn reads_the_config_file() {
        assert_eq!(
            server_url_from_file(r#"{"server_url": "https://a.example.com", "other": 1}"#).unwrap(),
            Some("https://a.example.com".to_owned())
        );
        assert_eq!(server_url_from_file("{}").unwrap(), None);
        assert!(server_url_from_file("server_url=x").is_err());

        let dir = std::env::temp_dir().join(format!("rpg-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CONFIG_FILE);
        assert_eq!(read_file_override(&path).unwrap(), None);
        std::fs::write(&path, r#"{"server_url":"http://192.168.0.2:8080"}"#).unwrap();
        assert_eq!(
            read_file_override(&path).unwrap().as_deref(),
            Some("http://192.168.0.2:8080")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compiled_default_is_valid() {
        Server::parse(compiled_default()).unwrap();
        Server::parse(PRODUCTION_PLACEHOLDER).unwrap();
    }
}
