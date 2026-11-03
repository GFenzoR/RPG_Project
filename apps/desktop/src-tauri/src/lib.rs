//! RPG Project desktop client (T2.5): the web client (`client/`, built into
//! `build/client`) in a Tauri 2 webview. The Rust side only adds what a webview served from
//! `tauri://localhost` cannot do safely on its own: pick the game server (config.rs) and
//! call its HTTP API with the account token kept in the OS keyring (api.rs).

mod api;
mod config;

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::utils::config::{Csp, CspDirectiveSources};

/// What the page needs to connect: the WebSocket URL of the chosen server.
#[derive(Serialize)]
struct ServerInfo {
    origin: String,
    ws_url: String,
}

#[tauri::command]
fn server_info(api: tauri::State<'_, api::Api>) -> ServerInfo {
    ServerInfo {
        origin: api.server.origin(),
        ws_url: api.server.ws_url(),
    }
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

pub fn run() {
    let mut context = tauri::generate_context!();
    let identifier = context.config().identifier.clone();

    let env = std::env::var("RPG_SERVER_URL").ok();
    let file = config::config_path(&identifier).and_then(|path| {
        config::read_file_override(&path).unwrap_or_else(|e| {
            eprintln!("[desktop] ignoring {e}");
            None
        })
    });
    let (server, source, warnings) =
        match config::resolve(env.as_deref(), file.as_deref(), config::compiled_default()) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[desktop] {e}");
                std::process::exit(1);
            }
        };
    for w in warnings {
        eprintln!("[desktop] {w}");
    }
    eprintln!("[desktop] game server {} ({source:?})", server.origin());

    let security = &mut context.config_mut().app.security;
    security.csp = Some(allow_server_in_csp(security.csp.take(), &server));

    let state = match api::Api::new(server) {
        Ok(state) => state,
        Err(e) => {
            eprintln!("[desktop] {e}");
            std::process::exit(1);
        }
    };

    if let Err(e) = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![server_info, api])
        .run(context)
    {
        eprintln!("[desktop] {e}");
        std::process::exit(1);
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
}
