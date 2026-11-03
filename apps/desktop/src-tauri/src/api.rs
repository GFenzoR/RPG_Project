//! The game server's HTTP API (docs/05-network-protocol.md, "API HTTP"), called from Rust
//! so the 30-day account token never reaches the webview: the page sends method, path and
//! body; this side adds `Authorization: Bearer`, asks login for `token_in_body`, keeps
//! the token in the OS keyring and strips it from the response.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::config::Server;

const LOGIN: &str = "/api/auth/login";
const LOGOUT: &str = "/api/auth/logout";
/// Same limit as the server's request body (4 KiB).
const MAX_BODY: usize = 4096;

/// What the page gets back: the HTTP status and the JSON body (null when empty or not JSON).
#[derive(Debug, Serialize, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}

/// Checks a request from the page. Only `GET`/`POST` to `/api/...` paths made of plain
/// segments: no query, fragment, `..`, or anything that could change the host.
pub fn check_request(method: &str, path: &str, body: Option<&Value>) -> Result<(), String> {
    if method != "GET" && method != "POST" {
        return Err(format!("method {method:?} not allowed"));
    }
    let rest = path
        .strip_prefix("/api/")
        .ok_or_else(|| format!("path {path:?} is not under /api/"))?;
    let segment_ok = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if path.len() > 128 || !rest.split('/').all(segment_ok) {
        return Err(format!("path {path:?} not allowed"));
    }
    if let Some(body) = body {
        if method == "GET" {
            return Err("GET with a body".to_owned());
        }
        if !body.is_object() || body.to_string().len() > MAX_BODY {
            return Err("body must be a JSON object of at most 4 KiB".to_owned());
        }
    }
    Ok(())
}

/// The login body with `token_in_body: true`.
pub fn login_body(body: Option<Value>) -> Value {
    let mut body = body.unwrap_or_else(|| Value::Object(Default::default()));
    if let Some(obj) = body.as_object_mut() {
        obj.insert("token_in_body".to_owned(), Value::Bool(true));
    }
    body
}

/// Removes `token` from a login response and returns it.
pub fn take_token(body: &mut Value) -> Option<String> {
    match body.as_object_mut()?.remove("token")? {
        Value::String(t) if !t.is_empty() => Some(t),
        _ => None,
    }
}

/// Where the account token lives: the OS keyring (Keychain, Credential Manager, Secret
/// Service), with a copy in memory. When there is no keyring (e.g. Linux without a Secret
/// Service, common on WSL2) it stays only in memory and the player logs in again on the
/// next start.
pub struct TokenStore {
    entry: Option<keyring::Entry>,
    cached: Mutex<Option<String>>,
}

const KEYRING_SERVICE: &str = "dev.rpgproject.client";
const KEYRING_USER: &str = "account-token";

impl TokenStore {
    pub fn open(server: &Server) -> Self {
        // One entry per server, so a home test server never sees the production token.
        let user = format!("{KEYRING_USER}@{}", server.origin());
        let (entry, cached) = match keyring::Entry::new(KEYRING_SERVICE, &user) {
            Ok(e) => match e.get_password() {
                Ok(t) => (Some(e), Some(t)),
                Err(keyring::Error::NoEntry) => (Some(e), None),
                // No usable keyring (no Secret Service, locked, denied): stop using it.
                Err(err) => {
                    eprintln!("[desktop] OS keyring unavailable ({err}); the session lives in memory only");
                    (None, None)
                }
            },
            Err(e) => {
                eprintln!(
                    "[desktop] OS keyring unavailable ({e}); the session lives in memory only"
                );
                (None, None)
            }
        };
        Self {
            entry,
            cached: Mutex::new(cached),
        }
    }

    fn get(&self) -> Option<String> {
        self.cached.lock().ok()?.clone()
    }

    fn set(&self, token: String) {
        if let Some(e) = &self.entry {
            if let Err(err) = e.set_password(&token) {
                eprintln!("[desktop] cannot save to the keyring ({err}); the session lives in memory only");
            }
        }
        if let Ok(mut c) = self.cached.lock() {
            *c = Some(token);
        }
    }

    fn clear(&self) {
        if let Some(e) = &self.entry {
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(err) => eprintln!("[desktop] cannot delete from the keyring ({err})"),
            }
        }
        if let Ok(mut c) = self.cached.lock() {
            *c = None;
        }
    }
}

/// Shared state of the `api` command.
pub struct Api {
    pub server: Server,
    http: reqwest::Client,
    tokens: TokenStore,
}

impl Api {
    pub fn new(server: Server) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .user_agent("rpg-desktop")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            // The API never redirects; following one could leak the bearer token.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let tokens = TokenStore::open(&server);
        Ok(Self {
            server,
            http,
            tokens,
        })
    }

    pub async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Response, String> {
        check_request(method, path, body.as_ref())?;
        let body = if path == LOGIN {
            Some(login_body(body))
        } else {
            body
        };
        let url = self.server.api_url(path);
        let mut req = match method {
            "GET" => self.http.get(&url),
            _ => self.http.post(&url),
        };
        if let Some(token) = self.tokens.get().filter(|_| path != LOGIN) {
            req = req.bearer_auth(token);
        }
        if let Some(body) = &body {
            req = req.json(body);
        }
        let result = req.send().await;
        if path == LOGOUT {
            // Logged out from this device whatever the server said (it may be unreachable).
            self.tokens.clear();
        }
        let res = result.map_err(|e| format!("network: {e}"))?;
        let status = res.status().as_u16();
        let bytes = res.bytes().await.map_err(|e| format!("network: {e}"))?;
        let mut body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if path == LOGIN {
            match take_token(&mut body) {
                Some(token) if status == 200 => self.tokens.set(token),
                _ => {}
            }
        } else if status == 401 {
            // Expired or revoked: forget it so the next start shows the login.
            self.tokens.clear();
        }
        Ok(Response { status, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allows_the_api_calls_of_the_client() {
        check_request(
            "POST",
            "/api/auth/register",
            Some(&json!({"email": "a@b.c", "password": "x"})),
        )
        .unwrap();
        check_request("POST", LOGIN, Some(&json!({}))).unwrap();
        check_request("POST", LOGOUT, None).unwrap();
        check_request("GET", "/api/characters", None).unwrap();
        check_request("POST", "/api/play", Some(&json!({"character_id": 3}))).unwrap();
    }

    #[test]
    fn rejects_other_requests() {
        for (m, p) in [
            ("DELETE", "/api/characters"),
            ("GET", "/healthz"),
            ("GET", "/api/"),
            ("GET", "/api//x"),
            ("GET", "/api/../admin"),
            ("GET", "/api/characters?x=1"),
            ("GET", "/api/characters#x"),
            ("GET", "/api/x%2F..%2Fy"),
            ("GET", "//evil.example.com/api/x"),
            ("GET", "/api/@evil.example.com"),
        ] {
            assert!(check_request(m, p, None).is_err(), "{m} {p}");
        }
        assert!(check_request("GET", "/api/characters", Some(&json!({}))).is_err());
        assert!(check_request("POST", "/api/play", Some(&json!([1]))).is_err());
        let big = json!({"x": "a".repeat(MAX_BODY)});
        assert!(check_request("POST", "/api/play", Some(&big)).is_err());
    }

    #[test]
    fn login_asks_for_the_token_and_hides_it() {
        assert_eq!(
            login_body(Some(
                json!({"email": "a@b.c", "password": "p", "token_in_body": false})
            )),
            json!({"email": "a@b.c", "password": "p", "token_in_body": true})
        );
        let mut body = json!({"expires_at": "2026-12-01T00:00:00Z", "token": "secret"});
        assert_eq!(take_token(&mut body).as_deref(), Some("secret"));
        assert_eq!(body, json!({"expires_at": "2026-12-01T00:00:00Z"}));
        assert_eq!(
            take_token(&mut json!({"error": {"code": "invalid_credentials"}})),
            None
        );
        assert_eq!(take_token(&mut Value::Null), None);
    }
}
