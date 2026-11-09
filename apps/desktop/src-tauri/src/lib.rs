//! RPG Project desktop client (T2.5): the web client (`client/`, built into
//! `build/client`) in a Tauri 2 webview. The Rust side only adds what a webview served from
//! `tauri://localhost` cannot do safely on its own: pick the game server (config.rs) and
//! call its HTTP API with the account token kept in the OS keyring (api.rs).

mod api;
mod config;

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::utils::config::{Csp, CspDirectiveSources};

/// What the page needs to connect: the WebSocket URL of the chosen server, and whether the
/// login screen may change it (not when RPG_SERVER_URL pins it for this run).
#[derive(Serialize)]
struct ServerInfo {
    origin: String,
    ws_url: String,
    editable: bool,
}

/// Where the server came from and where the picker saves a new one.
struct Settings {
    source: config::Source,
    config_path: Option<PathBuf>,
}

impl Settings {
    fn editable(&self) -> bool {
        self.source != config::Source::Env && self.config_path.is_some()
    }
}

#[tauri::command]
fn server_info(
    api: tauri::State<'_, api::Api>,
    settings: tauri::State<'_, Settings>,
) -> ServerInfo {
    ServerInfo {
        origin: api.server.origin(),
        ws_url: api.server.ws_url(),
        editable: settings.editable(),
    }
}

/// The login screen's server picker: validates the URL like config.json, saves it there and
/// restarts the app, because the CSP that lets the WebSocket out is fixed at start. Errors
/// are codes the page translates: `env_locked`, `invalid` or `save`.
#[tauri::command]
fn set_server(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Settings>,
    url: String,
) -> Result<(), String> {
    let Some(path) = settings
        .config_path
        .as_ref()
        .filter(|_| settings.editable())
    else {
        return Err("env_locked".to_owned());
    };
    let server = config::Server::parse(&url).map_err(|e| {
        eprintln!("[desktop] server picker: {e}");
        "invalid".to_owned()
    })?;
    if let Err(e) = config::save_server_url(path, &server) {
        eprintln!("[desktop] server picker: {e}");
        return Err("save".to_owned());
    }
    eprintln!(
        "[desktop] game server set to {}; restarting",
        server.origin()
    );
    app.restart()
}

#[tauri::command]
async fn api(
    state: tauri::State<'_, api::Api>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<api::Response, String> {
    state.call(&method, &path, body).await
}

/// Adds the server's WebSocket origin to `connect-src`: the CSP in tauri.conf.json allows
/// no network origin, and the server is only known at start.
fn allow_server_in_csp(csp: Option<Csp>, server: &config::Server) -> Csp {
    let mut map: HashMap<String, CspDirectiveSources> = csp.map(Into::into).unwrap_or_default();
    map.entry("connect-src".to_owned())
        .or_default()
        .push(server.ws_origin());
    Csp::DirectiveMap(map)
}

/// Stops the app before it has a window. Windows release builds have no console, so the
/// error also goes to `<config dir>/<identifier>/startup-error.log` (docs/12).
fn fatal(identifier: &str, msg: &str) -> ! {
    eprintln!("[desktop] {msg}");
    if let Some(path) = config::startup_log_path(identifier) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, format!("{msg}\n"));
    }
    std::process::exit(1);
}

pub fn run() {
    let mut context = tauri::generate_context!();
    let identifier = context.config().identifier.clone();

    let env = std::env::var("RPG_SERVER_URL").ok();
    let config_path = config::config_path(&identifier);
    let file = config_path.as_deref().and_then(|path| {
        config::read_file_override(path).unwrap_or_else(|e| {
            eprintln!("[desktop] ignoring {e}");
            None
        })
    });
    let (server, source, warnings) =
        match config::resolve(env.as_deref(), file.as_deref(), config::compiled_default()) {
            Ok(r) => r,
            Err(e) => fatal(&identifier, &e),
        };
    for w in warnings {
        eprintln!("[desktop] {w}");
    }
    eprintln!("[desktop] game server {} ({source:?})", server.origin());

    let security = &mut context.config_mut().app.security;
    security.csp = Some(allow_server_in_csp(security.csp.take(), &server));

    let state = match api::Api::new(server) {
        Ok(state) => state,
        Err(e) => fatal(&identifier, &e),
    };

    if let Err(e) = tauri::Builder::default()
        .manage(state)
        .manage(Settings {
            source,
            config_path,
        })
        .invoke_handler(tauri::generate_handler![server_info, api, set_server])
        .run(context)
    {
        fatal(&identifier, &e.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csp_gets_the_server_websocket_origin() {
        let server = config::Server::parse("https://juego.example.com").unwrap();
        let base = Csp::Policy("default-src 'self'; connect-src ipc: http://ipc.localhost".into());
        let csp = allow_server_in_csp(Some(base), &server).to_string();
        assert!(
            csp.contains("connect-src ipc: http://ipc.localhost wss://juego.example.com"),
            "{csp}"
        );
        assert!(csp.contains("default-src 'self'"), "{csp}");

        let csp = allow_server_in_csp(None, &server).to_string();
        assert_eq!(csp, "connect-src wss://juego.example.com");
    }

    /// The app version is client/package.json's (tauri.conf.json points at it), the same
    /// one the client sends in Hello.
    #[test]
    fn version_comes_from_the_client_package() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"], "../../../client/package.json");
        let pkg: Value =
            serde_json::from_str(include_str!("../../../../client/package.json")).unwrap();
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let context_version = context.config().version.clone();
        assert_eq!(context_version.as_deref(), pkg["version"].as_str());
    }

    /// The window opens the game page of the client build, not the public website at /
    /// (T4.3: the client is a two-page Vite build; the game is play/index.html).
    #[test]
    fn window_opens_the_game_page() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["windows"][0]["url"], "play/index.html");
        let page = include_str!("../../../../client/play/index.html");
        assert!(page.contains("/src/main.tsx"), "{page}");
    }
}
