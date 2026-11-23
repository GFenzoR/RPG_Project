# 18. Seguridad: modelo de amenazas, controles y checklist del operador

Pedido del dueño (2026-11-20): "importante que te asegures que el servidor y el juego en
general tenga un excelente estándar de ciberseguridad para que no nos hackeen o los
usuarios no modifiquen sus datos". El lote 16 auditó el servidor, el protocolo, la API, las
cuentas, la economía, el despliegue y la cadena de suministro, cerró lo confirmado y dejó
este documento como referencia. Cuando cambies un control, actualiza su sección.

Documentos relacionados: `01-architecture.md` (loop y persistencia), `05-network-protocol.md`
(límites de `/ws` y de la API), `08-testing-and-verification.md` (fuzzing y CI),
`09-deployment-aws.md` (despliegue y "Seguridad del despliegue"),
`13-hosting-de-pruebas.md` (hosting en casa, OAuth, lanzador).

## Modelo de amenazas

| Quién | Qué puede hacer | Qué buscamos |
|---|---|---|
| **Cliente de internet sin cuenta** | Conectarse a `/api` y `/ws` desde muchas IPs, mandar cualquier byte, inundar | Que no tumbe el servidor ni la base, que no lea nada privado, que no adivine cuentas ni tokens |
| **Cliente modificado o bot** (con cuenta) | Mandar mensajes protobuf válidos pero imposibles: caminar de más, atacar lejos, usar items ajenos, inundar comandos | Servidor autoritativo: nada de lo que manda decide un resultado; los abusos se rechazan o se cortan |
| **Jugador malicioso con alts** | Varias cuentas y personajes, coordinarlos, intentar duplicar items o oro, ver a jugadores ocultos | Sin duplicaciones ni dinero de la nada; las recompensas cooperativas no se hacen con alts |
| **Dependencia o acción de CI comprometida** | Un paquete npm/Go o una GitHub Action con código malicioso | Versiones fijadas (SHA y lockfiles), auditoría automática, permisos mínimos en CI |
| **Error del operador** | Subir un secreto, exponer Postgres, dejar un interruptor de prueba en producción, dar staff a la cuenta equivocada | Que el sistema se niegue a arrancar o avise, y una checklist clara |
| **Servidor comprometido** | Leer `.env`, la base y los backups | Daño acotado: secretos fuera del repo, contraseñas con argon2id, tokens solo como hash, backups cifrados |

Fuera de alcance por ahora: un atacante que controla la red entre el jugador y Caddy (lo
cubre TLS), DDoS volumétrico de red (lo absorbe el proveedor o Cloudflare) y un cliente que
lee lo que ya recibió (todo lo que el cliente dibuja es público para quien lo corre).

## Controles que ya existen

### Gateway WebSocket (`server/internal/net/gateway`)
- Límite de lectura de 4 KiB por mensaje, también antes del `Hello`; el primer frame tiene
  que ser un `ClientMessage` binario con `hello`, dentro del tiempo de espera, y con una
  versión de cliente compatible.
- El `Hello` lleva un **token de juego** de un solo uso (60 s, guardado como SHA-256,
  `DELETE ... RETURNING` que además rechaza cuentas deshabilitadas o baneadas), no la
  cookie: no hay secuestro de WebSocket entre sitios. `OriginPatterns` con lista explícita.
- Balde por conexión (30/s, ráfaga 60, deuda 30): lo que sobra se descarta y el abuso
  desconecta con `RATE_LIMITED`. Un frame de texto, un protobuf que no decodifica o un
  `ClientMessage` sin `oneof` desconectan con `KICKED`; un `Hello` repetido se ignora.
- Cola de salida acotada (128 lotes) con timeout de escritura y `SLOW_CLIENT`.
- Las goroutines de red nunca tocan el mundo: solo encolan comandos al loop.

### Game loop y sesión (`server/internal/game`, `server/internal/session`)
- Un solo dueño del estado: inventario, oro, mercado, casas e intercambio solo cambian en
  la goroutine del loop. Un panic en un comando se recupera y se descarta esa unidad.
- El servidor decide el ritmo (`readyAt`), las colas de pasos (`max_queued_steps`,
  `max_path_tiles`), el alcance, la línea de visión, los cooldowns, el maná, la capacidad y
  las zonas de protección. No hay posición elegida por el cliente en ningún mensaje.
- Los items se resuelven por casilla visible + id contra el índice (un índice viejo o
  inventado da nil); contenedores, bolsillos, slots y cantidades se acotan.
- Intercambio todo-o-nada con las mismas instancias, revalidado en cada aceptar y cada tick;
  transfers idempotentes en una transacción; libro de economía que se reconcilia cada tick
  en los tests (`economy mismatch`).
- Baúl de la cuenta (`session/stash.go`): una sola copia por cuenta en el loop mientras un
  personaje de la cuenta está en línea (o un login suyo lee la base, o su última escritura
  no se confirmó), así dos personajes conectados a la vez nunca sacan el mismo item. Cada
  movimiento es un transfer (personaje + baúl entero, una transacción) y deja al personaje
  en espera (`heldDrop`) hasta el acuse; un transfer descartado marca el baúl en el Saver
  (lo que lo toque después no se escribe y marca a su personaje) y el mundo queda en solo
  lectura. Solo items comerciables: un item de quest no pasa entre personajes.
- `Input` ignora enums y oneofs desconocidos.

### Anti-flood dentro del juego
GCRA (balde) por jugador en chat (con silencio), canal global, intercambio, mercado,
casas, comandos de staff, reportes, grupo, gremio, presencia, apariencia y cosméticos.
Chat sin caracteres de control ni bidi (`cleanChat`). Ver `05-network-protocol.md`.

### Estructuras acotadas
Cola del loop (8192, 2048 por tick), colas de salida, tablas de rate limit de tamaño fijo
(asociativas, con clave HMAC por proceso), longitud de chat, ofertas y montos del mercado
(caben en `int64`), cantidades de tienda (1..100 por precio máximo), profundidad de
contenedores, items por casilla, diario de misiones, avisos de muertes link-dead (uno por
personaje).

### API HTTP y rate limits (`server/internal/httpapi`)
- Todo cuerpo JSON pasa por `decode`: exige `Content-Type: application/json` (bloquea CSRF
  por formulario), 4 KiB, `DisallowUnknownFields`, un solo objeto.
- Errores con códigos fijos (`{"error":{"code"}}`); lo interno va al log, nunca a la
  respuesta; un `recover` convierte panics en `500 internal`. `Cache-Control: no-store`.
- Timeouts de cabecera, lectura, escritura e inactividad en el `http.Server`.
- Límites por IP (IPv6 por /64) en las rutas de auth; logins fallidos por (email, IP) y por
  email, con reserva y devolución si la contraseña no era la incorrecta; por cuenta en
  tienda, subida y bajada de mapas; por dirección y cuenta en los emails.
- Detrás de Caddy solo se confía en el **último** `X-Forwarded-For`, que Caddy reescribe.
- SQL solo por sqlc o strings estáticos; `statement_timeout` de 10 s. `/metrics` en su
  propio listener interno; sin pprof ni handlers de debug; sin CORS (mismo origen).

### Cuentas, OAuth y sesiones (`server/internal/auth`, `server/internal/oauth`)
- argon2id (19 MiB, t=2, p=1) con parámetros acotados al verificar y comparación en tiempo
  constante; 8 a 128 caracteres; login con email desconocido verifica un hash de relleno
  (mismo tiempo); el estado de baneo solo se revela tras la contraseña correcta.
- Tokens de sesión y de enlaces: 32 bytes de `crypto/rand`, en la base solo el SHA-256.
  Cookie `rpg_session` `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api`; el login web
  nunca devuelve el token en el cuerpo.
- Ban, cambio de rol y reseteo de contraseña borran todas las sesiones.
- **Sesiones cortas (lote 17):** el juego nunca guarda el login. La sesión de cuenta dura
  12 h como máximo y vence tras 30 min sin actividad autenticada (`last_seen_at`, refrescado
  como mucho una vez por minuto; la sesión inactiva se borra al rechazarla y el job de
  limpieza borra el resto). La cookie es de sesión del navegador (sin `Expires`/`Max-Age`;
  Chrome/Edge con "continuar donde lo dejaste" y las PWA la restauran al reabrir, y ahí
  solo la acotan los 30 min / 12 h) y la app de escritorio guarda el token solo en memoria (borra el que una versión vieja
  dejó en el llavero). Solo se recuerda el email para rellenar el login.
- **"Cerrar sesión en todos lados"** (`POST /api/auth/logout-all`): borra todas las sesiones
  y tokens de juego de la cuenta y sus flujos OAuth en curso en una transacción auditada
  (`sessions_revoked`), y saca del juego a sus personajes por el loop
  (`SIGNED_OUT_EVERYWHERE`, guardados como en un logout).
- **Cambiar la contraseña logueado** (`POST /api/account/password`): exige la actual bajo
  los límites de login fallido; revoca las demás sesiones, los enlaces de reset y
  `claim_email` pendientes y los flujos OAuth, todo en una transacción auditada
  (`password_changed`); saca del juego a los personajes conectados (`PASSWORD_CHANGED`),
  también los de la sesión que la cambió (a propósito). Si la sesión que pide el cambio
  fue revocada entre la verificación y la transacción (un "cerrar sesión en todos lados"
  simultáneo), el cambio falla con `401`: la transacción bloquea esa sesión antes de
  escribir. Con mailer, cada cambio o creación de contraseña manda a la cuenta el aviso
  `email.password_changed` (enlace a `/forgot-password`): una cookie robada que crea o
  cambia la contraseña deja una credencial que sobrevive a "cerrar sesión en todos lados",
  y el dueño se entera y la recupera con un reset (que borra todas las sesiones). Sin
  mailer no hay aviso (riesgo aceptado, como al vincular un proveedor).
- Revocar (reset, cambio de contraseña, "cerrar sesión en todos lados") también rechaza
  el login que ya canjeó su token de juego y aún no entró al mundo: el `Join` compara el
  instante del canje con el de la última revocación de la cuenta (docs/05).
  Una cuenta solo OAuth crea su primera contraseña dentro de los 10 min de su login.
- OAuth: Authorization Code + PKCE S256, `state` de 256 bits de un solo uso atado al
  navegador por cookie; `id_token` de Google solo RS256 contra JWKS, con `iss`, `aud`,
  `exp/iat` y `nonce`; redirecciones solo a una lista fija (`auth.SafeReturn`). Nunca se
  vincula una identidad por coincidencia de email.
- IDOR: todo endpoint de personajes filtra por la cuenta de la sesión; las entregas de
  mapas de otro dan el mismo 404 que una inexistente.
- Nombres de personaje sin palabras de staff ni homoglifos; emails ASCII normalizados.

### Herramientas de staff y log de auditoría
- Los roles solo se dan desde la CLI del operador (`gameserver admin set-role`, `make
  set-role`/`make home-admin`), con nota obligatoria, entrada en `audit_log` y sesiones
  revocadas; el rol se relee de la base en cada pedido y en el juego (`checkRoles`).
- Comandos de staff con su GCRA, auditados todos, con jerarquía de roles en kick, ban y
  teletransporte; un comando desconocido y uno prohibido contestan igual.
- Descargas de parches de mapas por staff auditadas, como adjunto con `nosniff` y CSP
  `default-src 'none'; sandbox`.

### Interruptores de desarrollo y sandbox
- Las islas `dev_only` (Thimblewick) solo entran a `world.bin` con `mapcompile -dev`, y el
  gameserver no arranca con ellas si `RPG_ENV` es de producción.
- Las acciones de diálogo de desarrollo tienen tres capas: `make validate`, el arranque
  (`CheckDevPlacement`) y la elección (`dialog.Check` con `DevIsland`).
- El proveedor de pagos falso se niega a arrancar fuera de `development`/`test`.

### Herramientas de mapas
- Un parche subido es entrada no confiable: rutas por lista blanca de regex
  (`mappatch.AllowedPath`), tamaño por `Content-Length` + `MaxBytesReader`, cupos de subida,
  plazo por pedido, cuenta verificada, antigüedad, baneos y límite diario antes de leer.
- El editor local: API de desarrollo con cabecera propia, sin CORS, `Origin` y
  `Sec-Fetch-Site` revisados, `fs.strict`, chequeo de host de Vite contra DNS rebinding y
  escrituras confinadas por `resolve()` + `inside()`.
- Los workflows de PR de mapas nunca usan `pull_request_target`; el que escribe comentarios
  corre el código de la rama por defecto (`tools/mapcli/src/workflows.test.ts`).

### App de escritorio (Tauri)
CSP estricta sin `unsafe-eval`; solo 3 comandos IPC propios (sin plugins de fs ni shell); el
token de la cuenta vive solo en la memoria del proceso Rust mientras la app está abierta
(lote 17; nada en disco ni en el llavero) y nunca llega al webview; el proxy de la
API solo acepta `GET/POST /api/...` validado por segmento y no sigue redirecciones; URL de
servidor `https` salvo host privado.

### Despliegue, Caddy y contenedores
- Solo 80/443 abiertos; Postgres sin puertos publicados; Grafana apagado por defecto y,
  encendido, con lista de IPs y basic auth; `/metrics` nunca pasa por Caddy.
- Caddy: `nosniff`, `Referrer-Policy`, `X-Frame-Options DENY`, sin cabecera `Server`, HSTS en
  producción; cuerpo del webhook de pagos acotado; reescribe `X-Forwarded-For`.
- Webhook de Mercado Pago: firma HMAC en tiempo constante con ventana de tiempo, relectura
  del pago en la API del proveedor, referencia firmada, monto y moneda, idempotente.

### Secretos en git
Ningún secreto en el repo: van en `deploy/.env` (o `deploy/.env.home`), que git ignora. Las
credenciales de los tests son falsas a propósito (`bot-password`, `fake-client-secret`) y
están en la lista blanca de `.gitleaks.toml`, que es **por valor, no por ruta**: un secreto
real pegado en un test o en `testdata/` también se reporta. La única ruta exenta es el
proveedor OAuth falso (`server/internal/oauth/oauthtest/`). Un valor falso nuevo que
gitleaks marque se suma como una regex propia (anclada o de 9 caracteres o más:
`workflows.test.ts` rechaza fragmentos cortos como `s3cret`). La historia entera pasó sin
hallazgos con gitleaks 8.30.1 el 2026-11-23 (antes de eso marcaba los nonces de
`Sec-WebSocket-Key` de `deploy/smoke.sh` y una clave de quest de un test).

### GitHub Actions
Permisos `contents: read` por defecto y por job solo lo necesario; ningún
`pull_request_target`; ninguna expresión de datos del evento dentro de un script (lo
comprueba `workflows.test.ts`); los jobs de PR no ven secretos.

### Dependencias
`pnpm-lock.yaml` y `go.sum` fijan todo; `pnpm install --frozen-lockfile` en CI; las
herramientas (`actionlint`, `golangci-lint`, `govulncheck`) con versión exacta.

## Lo que agrega el lote 16
Cinco ramas, cada una con sus tests y su doc:

- **`sec/http-auth-limits`** (docs/05 "Límites de la API"): tokens inventados se rechazan por
  forma y por límite por cliente antes de llegar a Postgres; límites por cuenta en `play` y
  crear personaje, por red (/48 y /24) y un solo hash de contraseña a la vez por red;
  `/healthz` guarda el ping 1 s; pool de 16 conexiones; logs repetidos muestreados; una sola
  IP ya no bloquea el login de una cuenta (par 15/h y cookie `rpg_device` de dispositivo
  conocido); desvincular un método de login pide la contraseña; `forgot` devuelve al dueño
  del buzón una dirección que otro registró sin verificar; nombres de NPC reservados.
- **`sec/ws-gateway-caps`** (docs/05 "Límites", docs/01 "Equidad de la cola"): por IP, 8
  conexiones abiertas, 4 en handshake y un balde de handshakes (HTTP 429); globales, 1000
  sin login y 32 handshakes leyendo la base (HTTP 503); `-max-players` (`SERVER_FULL`); 2
  personajes por cuenta en el mundo (`TOO_MANY_CHARACTERS`); `Hello` en 5 s; cupo de 16
  comandos por conexión en la cola del loop y un carril propio para los logins; el lector y
  el escritor recuperan panics.
- **`sec/game-integrity`**: lo soltado a la calle queda reservado hasta que se guarda quien
  lo soltó (sin duplicación por caída); `recover` con log en el Saver y los escritores de
  admin, economía y tienda; los hitos cooperativos rechazan dos personajes de una cuenta;
  anti-flood de `Turn`; la oferta de casa no revela invisibles ni staff; el chequeo de
  presencia muestra un color en vez de nombrarlo; los hooks E2E no salen en el build de
  producción.
- **`sec/deploy-hardening`** (docs/09 "Seguridad del despliegue"): Go 1.27.4 en todas partes
  y pgx, x/text y x/crypto parchados; imágenes firmadas con cosign (sin clave) y fijadas por
  digest, verificadas por `deploy.sh`; CSP, `Permissions-Policy` y COOP en el sitio y
  `/play`; HSTS también en casa; contenedores con `cap_drop: ALL`, `no-new-privileges` y raíz
  de solo lectura; backups con `umask 077`, cifrado en S3 y opcional con `age`; `set-role`
  muestra la cuenta y se niega a promover una que nunca probó su email; el gameserver no
  arranca en producción con interruptores de prueba; semilla del loop de `crypto/rand` y no
  logueada.
- **`sec/security-docs`** (esta rama): este documento; fuzzing nativo de Go
  (`FuzzClientFrame`, `FuzzInputDispatch`, `FuzzJSONRoutes`, `make fuzz`, docs/08
  "Fuzzing"); cada `uses:` de los workflows fijado a un commit de 40 hex con su versión en
  comentario y un paso de CI que falla si no (`.github/scripts/check-action-pins.sh`);
  `security.yml` (govulncheck, `pnpm audit --prod --audit-level high`, gitleaks con checksum
  sobre toda la historia; en PR, en `main` y cada lunes); `dependabot.yml` semanal (actions,
  los cuatro módulos Go, npm); `make audit`.

## Hallazgos verificados y descartados
- **"Las flechas conjuradas se venden a un NPC (oro desde maná)":** falso. `conjure_arrows`
  crea `arrow`, pero ningún NPC compra flechas: el armero de Lanternby las **vende**
  (`sells`), y ningún `buys` de `data/npcs/` tiene `arrow`. Si algún día un NPC compra algo
  que un hechizo conjura, `checkShopPrices` tiene que considerarlo.
- **pgx GO-2026-5004 (inyección por confusión de placeholders con `$$`):** solo aplica al
  protocolo simple con literales en dólares. El servidor usa el protocolo extendido
  (consultas de sqlc, sin `default_query_exec_mode=simple_protocol`) y ninguna consulta
  arma SQL con strings. govulncheck lo marca alcanzable por `storetest` (helper de tests).
  Igual, `sec/deploy-hardening` sube pgx a v5.13.0.
- **Acciones sobre items del suelo sin línea de visión:** seguro con `inventory.reach: 1`
  (Chebyshev, mismo piso): a una casilla no hay nada que tape la vista. Si se sube el
  alcance (el balance lo permite hasta 6), hay que sumar `LineOfSight` a `itemAt`.

## Riesgos aceptados y trabajo diferido
- **El registro revela si un email existe** (`409 email_taken`), aunque login y `forgot`
  contestan igual. Arreglarlo pide registrar por email (enviar el enlace siempre y crear la
  cuenta al confirmar), que cambia el flujo y necesita SMTP en todos los entornos.
- **El dueño de un buzón se queda con una cuenta que nunca lo verificó** (`claim_email`,
  docs/05 "Dirección nunca verificada"): si alguien se registra con un email mal tecleado
  que es de un tercero y no lo verifica, ese tercero puede pedir el reset y quedarse con la
  cuenta y sus personajes. Es la contracara buscada contra el squatting de direcciones
  ajenas; quien quiere conservar su cuenta verifica su email (una dirección verificada ya no se
  puede reclamar así).
- **Sin MFA para el staff.** Mitigación: el staff es poco y sus roles solo se dan por CLI;
  los comandos quedan auditados. (Las sesiones de 30 días, la falta de "cerrar sesión en
  todos lados" y de "cambiar contraseña" logueado se resolvieron en el lote 17.)
- **Una partida abierta no depende de la sesión HTTP** (lote 17): canjeado el token de
  juego, la conexión sigue aunque la sesión venza por inactividad o por sus 12 h. Solo
  "cerrar sesión en todos lados", un cambio/reset de contraseña o un ban la cortan. Es a
  propósito: cortar a alguien a mitad de una pelea por no tocar la lista de personajes
  sería peor, y un ladrón de cookie no gana nada con eso (necesita la cookie viva para
  pedir un token de juego nuevo).
- **Recompensas por personaje farmeables con alts** (cofres, oro y espada del capítulo 1, oro
  del tutorial): cada personaje nuevo las cobra. Son pocas y chicas; el libro de economía
  marca los extremos. Atarlas a la cuenta queda para cuando la economía lo pida.
- **El bundle del cliente trae datos de portales, salas de misión y textos de quests:** quien
  lo lea sabe dónde está cada cosa antes de llegar. Nada de eso da ventaja que el servidor
  no controle; servirlo bajo demanda queda diferido.
- **Instaladores de escritorio sin firma** (docs/09 "Sin firma de código"): Windows y macOS
  avisan al instalar. Firmar necesita certificados pagos del dueño.
- **Bloqueo distribuido del login por email** desde 3 o más redes y otros detalles de cada
  rama: en `docs/14` "Pendientes conocidos".

## Checklist del operador
Hacer una vez y revisar cada mes.

**GitHub**
- [ ] 2FA en la cuenta del dueño y de todo colaborador con escritura.
- [ ] Protección de la rama `main`: PR obligatorio, checks requeridos `ci`, `security` y
  `map-pr/verdict`, sin force push ni borrado, revisión de `CODEOWNERS` (docs/14 "Lo que
  es tuyo"). GitHub elige los checks por nombre de **job**: `ci` y `security` son los jobs
  finales de `ci.yml` y `security.yml`, que esperan a todos los demás de su workflow
  (`if: always()`) y fallan si alguno falló o se canceló (saltado cuenta como aprobado);
  `map-pr/verdict` es el status que escribe `map-pr-comment.yml`. Aparecen en el buscador
  de Branch protection después de su primera corrida en un PR.
- [ ] "Dependabot alerts" y "Dependabot security updates" encendidos (Settings → Code
  security); los PR de `dependabot.yml` se revisan cada semana.
- [ ] Secret scanning y push protection encendidos si el plan del repo los ofrece.

**Secretos**
- [ ] Todos en `deploy/.env` (AWS) o `deploy/.env.home` (casa), con `chmod 600`, nunca en el
  repo, en un issue, en un chat ni en un log. `deploy.sh` deja `.env` en 600.
- [ ] Si uno se filtra: rotarlo primero (Google, Discord, Mercado Pago, SMTP, Postgres),
  después limpiar.

**Login con Google (y Discord si se usa)** — detalle en `13-hosting-de-pruebas.md` 8c:
- [ ] Una app OAuth propia por proveedor; `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` (y
  `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`) en el `.env`.
- [ ] Redirect URIs exactas: `<PUBLIC_URL>/api/auth/oauth/google/callback` y
  `<PUBLIC_URL>/api/auth/oauth/discord/callback`, una por cada `PUBLIC_URL` usada (la tabla
  de docs/13). Solo `https` fuera de `localhost`.
- [ ] Permisos mínimos: `openid` y `email` (Google), `identify` y `email` (Discord).

**Base de datos y backups**
- [ ] Postgres nunca expuesto (sin `ports:` en compose, sin regla de firewall).
- [ ] Backups diarios cifrados (S3 con cifrado del servidor y, mejor, `age` con
  `BACKUP_AGE_RECIPIENT`); la clave privada de `age` fuera del servidor.
- [ ] Una restauración de prueba al mes (docs/09 "Backups y restauración").

**Actualizaciones**
- [ ] Actualizaciones automáticas de seguridad del sistema operativo.
- [ ] Imágenes nuevas desde CI (firmadas) con `deploy.sh`; nunca compilar en el servidor.
- [ ] `make audit` antes de cada release; el job `security` en verde.

**Sesiones** (lote 17)
- [ ] Tras desplegar el lote 17, todos los jugadores entran de nuevo una vez (la migración
  00024 borra las sesiones de 30 días). Avisarlo en el anuncio de la versión.
- [ ] Ante un reporte de cuenta comprometida: pedir al jugador "Cerrar sesión en todos
  lados" y cambiar la contraseña desde la pantalla de personajes (o mandarle un enlace con
  `gameserver admin reset-link`); revisar `gameserver admin audit` por
  `sessions_revoked` / `password_changed`.
- [ ] Revisar que los valores por defecto (12 h absolutas, 30 min de inactividad) sigan
  siendo los de `auth.DefaultAccountTokenTTL` y `auth.DefaultSessionIdle`; no hay flag
  para cambiarlos.

**Logs** (qué mirar, al menos una vez por semana)
- [ ] `audit_log`: cambios de rol, bans, comandos de staff, descargas de parches. Un cambio
  que nadie recuerda haber hecho es un incidente.
- [ ] Picos de `RATE_LIMITED`, `SERVER_FULL`, HTTP 429/503 y `KICKED` (malformados): bots o
  un ataque. Mirar desde qué redes.
- [ ] Fallas de firma del webhook de pagos: alguien prueba pagos falsos o el secreto cambió.
- [ ] `economy` (alertas de extremos y `mismatch`) y `PersistenceDataLost`.
- [ ] Avisos `INSECURE` al arrancar (`-cookie-secure=false` fuera de casa).
