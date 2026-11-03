# apps/desktop/ — cliente de escritorio (Tauri 2)

Lee `docs/12-local-development.md` ("Cliente de escritorio") y `docs/09-deployment-aws.md`
("Cliente de escritorio") antes de tocar algo aquí.

- Envuelve `build/client` (el build web): **no** pongas lógica de juego ni UI aquí. Lo que
  cambia en la app vive en `client/src/net/desktop.ts` (detecta Tauri con `isTauri()`).
- Rust (`src-tauri/src`): `config.rs` elige el servidor, `api.rs` llama a la API HTTP con el
  token en el llavero del SO (nunca lo devuelve al webview), `lib.rs` arma la CSP con el
  origen WS del servidor elegido y registra los comandos `server_info` y `api`.
- Seguridad: comandos deny-by-default (`build.rs` declara el manifiesto) y la capability
  `default` solo concede esos dos; sin plugins de shell/fs; sin acceso IPC remoto.
  `freezePrototype` está apagado porque rompe Preact (asigna `constructor` a sus vnodes).
- Versión: `tauri.conf.json` apunta a `client/package.json`; no pongas otra.
- Verificación: `make desktop-test`; si tocas el webview o el flujo de login,
  `make desktop-smoke` (Linux) y revisa `e2e/screenshots/` con Read.
