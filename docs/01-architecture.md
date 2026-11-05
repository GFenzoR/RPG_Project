# 01 — Arquitectura

## Vista general
```
 Navegador / Tauri (PC)                       Instancia AWS (Docker Compose)
┌──────────────────────┐   HTTPS  ┌───────────────────────────────────────────────┐
│ client (Pixi+Preact) │─────────▶│ Caddy (TLS, estáticos del cliente y editor)   │
│ editor (Pixi+Preact) │   WSS    │   ├─▶ gameserver (Go)                         │
└──────────────────────┘─────────▶│   │     ├─ HTTP API (login, personajes, OAuth)│
                                  │   │     ├─ WS gateway (conexiones)            │
                                  │   │     ├─ game loop (1 goroutine)            │
                                  │   │     └─ persistencia (goroutine aparte)    │
                                  │   └─▶ postgres 16                             │
                                  │ backups diarios → S3                          │
                                  └───────────────────────────────────────────────┘
```
### Rutas HTTP (T4.3)
Caddy (`deploy/caddy-routes.caddy`) reparte una sola origin:

| Ruta | Destino |
|---|---|
| `/api/*`, `/ws`, `/healthz` | gameserver: API HTTP (cuentas, personajes, `play`, y los públicos `status` y `highscores`; docs/05), WebSocket del juego y health |
| `/play`, `/play/*` | página del juego del build del cliente (`client/play/index.html`) |
| todo lo demás | sitio público (`client/index.html`): landing en `/`, `/highscores`, `/news` y `/news/<fecha>-<slug>`; primero los archivos estáticos del build (`/assets`, `/atlas`, `/audio`) |

El cliente es un build multipágina de Vite (`client/`): las dos páginas comparten i18n,
estilos y el selector de idioma. El atlas y los sonidos se piden desde la raíz del sitio,
así que sirven a las dos páginas. La app de escritorio abre `play/index.html` directo. Las
noticias (`data/news`) se publican en el build: no hay admin web ni tabla en la base.
El handler de `/api/status` no toca el mundo: lee contadores atómicos que publica el game
loop (principio 2).

Un solo binario Go para todo el backend. Separar servicios es una decisión para cuando
haya más de ~500 jugadores simultáneos; hasta entonces es complejidad sin beneficio.

## El game loop
```
for each tick (50 ms):
  1. drenar la cola de comandos de jugadores (con tope por tick)
  2. procesar eventos programados que vencen en este tick (scheduler por min-heap)
  3. avanzar movimiento de criaturas que completan su paso
  4. IA de monstruos solo en sectores activos (con jugadores cerca)
  5. resolver combate (rondas cada 2000 ms por criatura, desfasadas)
  6. condiciones (veneno, regeneración) en sus intervalos
  7. respawns pendientes
  8. construir eventos por sesión según su área de interés (AOI) y encolarlos para envío
```
- **Una sola goroutine muta el mundo.** Elimina carreras y bloqueos. Para 100–500
  jugadores un núcleo sobra.
- Las goroutines de red leen del socket, decodifican, validan forma y encolan `Command`.
  Escriben los `Event` que el loop les deja en una cola por sesión.
- La persistencia recibe **snapshots inmutables** (copias) y escribe en Postgres fuera
  del loop. El loop nunca espera a la base de datos.
- Si un tick tarda más de 50 ms, se registra y el siguiente arranca de inmediato
  (no se acumula deuda). Métrica `tick_duration_ms`.

## El mundo en memoria
- Posición: `(x uint16, y uint16, z uint8)`. Pisos 0–15, piso 7 = nivel del mar.
- El mapa se carga completo en memoria al arrancar desde `world.bin` (compilado).
  Una isla de 512x512 con 3 pisos útiles cabe holgadamente en pocos cientos de MB.
- **Sectores** de 32x32 casillas por piso. Cada sector conoce sus criaturas.
  Se usan para AOI, para despertar IA y para decidir qué enviar a cada jugador.
- Un sector está "activo" si un jugador está a menos de 2 sectores. Los monstruos de
  sectores inactivos no piensan ni se mueven (ahorro principal de CPU).
- Tiles con flags precomputados (bloquea paso, bloquea proyectil, zona de protección,
  no-logout, pvp) para que el pathfinding y la línea de visión sean baratos.

## Área de interés (AOI)
- Cada jugador ve 15x11 casillas (rango Tibia-like) + 1 de margen para animar entradas.
- Al moverse, el servidor envía solo la fila o columna nueva de tiles y las criaturas
  que entran o salen. Nunca reenvía la pantalla completa salvo al teletransportarse.
- Pisos: sobre el nivel del mar se ven los pisos inferiores visibles; bajo tierra solo
  el piso actual (regla simple, ajustable).

## Red
- WebSocket (wss) en `/ws`. Autenticación: el cliente hace login por HTTP, recibe un
  token de sesión de corta vida y lo manda en el primer mensaje del socket.
- Mensajes binarios Protobuf. Un `ClientMessage` y un `ServerMessage` con `oneof`.
- Ver `05-network-protocol.md`.

## Persistencia
| Qué | Dónde | Cuándo |
|---|---|---|
| Cuentas, personajes, inventario, skills, quests | Postgres | Al salir + autoguardado cada 5 min escalonado |
| Estado del mundo (items en el suelo) | Memoria | Se pierde al reiniciar (como Tibia en sus inicios); casas en el futuro sí persisten |
| Log de economía (T4.1: creación y destrucción de oro e items por fuente) | Postgres, `economy_log` append-only | Asíncrono por lotes (COPY), goroutine propia |
| Reportes de jugadores (T4.1) | Postgres, `player_reports` | Asíncrono, goroutine de admin |
| Mapa y contenido | Repo git (world/, data/) | Se despliegan con cada versión |
| Roles, bans y log de auditoría (T2.6) | Postgres (`audit_log` append-only) | Asíncrono, goroutine de admin |

Transacciones: el trade entre jugadores se resuelve atómicamente en el loop (estado en
memoria) y se persiste ambos personajes en una sola transacción de base de datos.

## Autenticación y cuentas
- Email + contraseña (argon2id), verificación de email, reset de contraseña.
- OAuth 2.0 con Google y Discord vinculados a la misma cuenta.
- Una cuenta tiene varios personajes. Cosméticos pertenecen a la cuenta.
- Tokens de sesión opacos en Postgres (fácil de revocar); cookie `HttpOnly` en web,
  almacenamiento seguro en Tauri: el llavero del SO desde Rust, la página nunca lo ve
  (T2.5, `apps/desktop`; si no hay llavero, solo memoria).

## Contenido y mapas en el build
```
data/*.yaml ──validate──▶ server lo carga al arrancar (y cliente/editor por HTTP)
world/**.json ──mapcompile──▶ world.bin (servidor) + chunks servidos al editor
assets/sprites ──spritepack──▶ atlas.png + atlas.json (cliente y editor)
```

## Paquetes TS compartidos
- `packages/protocol`: tipos generados desde `proto/` (ts-proto o protobuf-es).
- `packages/map-format`: lectura/escritura/validación de chunks y **operaciones de edición**.
- `packages/content-schema`: JSON Schemas de `data/` y tipos TS generados.
- `packages/renderer`: dibujo de tiles e items con Pixi, compartido por cliente y editor.

## Observabilidad
- `/healthz` en la API pública. `/metrics` (Prometheus, `internal/metrics`) va en un
  listener aparte, `-metrics-addr` (por defecto `127.0.0.1:9100`, vacío lo apaga), para
  que el proxy de la API nunca lo exponga. En Docker Compose escucha en `:9100` dentro
  del contenedor. No se publica en el host y Caddy no tiene ruta hacia él. Prometheus lo
  lee por la red `monitoring`, aunque los demás contenedores del stack también lo
  alcanzan por sus redes. No lleva datos de jugadores.
- Logs JSON con `slog`.
- Stack de monitoreo opcional (T4.4): profile `monitoring` del compose, con Prometheus,
  Alertmanager, Grafana y node-exporter. Configuración versionada en `deploy/monitoring/`.
  Cómo activarlo: `09-deployment-aws.md` ("Monitoreo"), `13-hosting-de-pruebas.md` y
  `12-local-development.md`. Cómo medir con el dashboard: `07-performance-budget.md`.

### Métricas del servidor
| Métrica | Tipo | Desde | Qué mide |
|---|---|---|---|
| `tick_duration_ms` | histograma | T1.17 | duración de cada tick (buckets finos bajo 10 ms) |
| `tick_overruns_total` | contador | T1.17 | ticks de más de 50 ms |
| `tick_commands_total`, `command_queue_pending` | contador, gauge | T1.17 | comandos ejecutados y los que quedan en cola tras el tick |
| `ws_connections`, `ws_sent_bytes_total`, `ws_sent_batches_total` | gauge, contadores | T1.17 | conexiones WS abiertas y salida |
| `players_online` | gauge | T4.4 | jugadores en el mundo (`World.PublishedOnline`, el mismo atomic de `/api/status`) |
| `economy_alerts_total{kind}` | contador | T4.1 | `mismatch`, `gold_outlier`, `items_outlier`, `log_dropped`; empiezan en 0 |
| `persistence_errors_total{writer,outcome}` | contador | T4.4 | escrituras fallidas a Postgres. `writer`: `character` (snapshots), `audit` (auditoría, bans, reportes), `economy` (log de economía). `outcome`: `retry` (se reintenta), `rejected` (la base rechazó los valores; se descarta y queda en el log), `abandoned` (se abandonó al apagar) |
| `http_requests_total{route,code}` | contador | T4.4 | API HTTP por patrón de ruta (`GET /api/status`, `unmatched`...) y código. Sin `/ws` |
| `http_request_duration_seconds{route}` | histograma | T4.4 | latencia de la API por patrón de ruta |
| `process_*`, `go_*` | estándar | T1.17 | CPU, RSS, goroutines, GC |

Las etiquetas son conjuntos fijos: patrones de rutas del `ServeMux` (nunca la URL), códigos
HTTP, escritores y resultados. Ninguna lleva datos del jugador (nombre, cuenta, IP).
La detección de bots (T4.1) no publica métrica todavía: su puntaje vive en la base y en
`/reports`.

Métricas de fuera del gameserver:
- **Máquina** (node-exporter): CPU, RAM y disco de `/` del host.
- **Backups**: `deploy/backup.sh` escribe `rpg_backup_last_run_success`,
  `rpg_backup_last_run_timestamp_seconds`, `rpg_backup_last_success_timestamp_seconds`,
  `rpg_backup_last_size_bytes` y `rpg_backup_interval_seconds` en
  `/backups/metrics/backup.prom`. node-exporter lo lee con su collector `textfile`.

### Alertas
Reglas en `deploy/monitoring/prometheus/rules/alerts.yml`, el único archivo con umbrales.
Tienen tests (`prometheus/tests/alerts_test.yml`, `make monitoring-check`).

| Alerta | Severidad | Condición |
|---|---|---|
| `GameServerDown` | critical | scrape de `/metrics` fallido (`up == 0`) durante 1 min: proceso parado, caído o colgado |
| `GameServerNotReady` | critical | más de la mitad de las llamadas a `/healthz` del último minuto responden 503 (Postgres no contesta), sostenido durante 2 min. Un corte de un par de minutos (por ejemplo, Postgres recreado por `deploy.sh`) no avisa, y la alerta se resuelve ~30 s después de la recuperación. `/metrics` tiene su propio listener y sigue respondiendo, así que `GameServerDown` no lo ve. Funciona sin jugadores: el healthcheck del compose llama a `/healthz` cada 10 s |
| `GameServerMetricsMissing` | warning | no existe el target del gameserver durante 5 min |
| `TickP99OverBudget` | warning | tick p99 (ventana de 5 min) > 10 ms durante 10 min (docs/07) |
| `TickOverruns` | warning | más de 5 ticks de más de 50 ms en 5 min |
| `GameServerMemoryHigh` | warning | RSS del proceso > 600 MB durante 10 min (docs/07) |
| `HostMemoryHigh` | critical | menos de 10 % de la RAM de la máquina disponible durante 5 min |
| `HostDiskAlmostFull` / `HostDiskCritical` | warning / critical | menos de 15 % / 5 % libre en `/` |
| `PersistenceRetrying` | warning | más de 3 reintentos de un escritor en 10 min |
| `PersistenceDataLost` | critical | cualquier escritura `rejected` o `abandoned` en 15 min (`abandoned` es best effort, ver abajo) |
| `EconomyMismatch` | critical | cualquier `economy_alerts_total{kind="mismatch"}` nuevo en 15 min |
| `BackupFailed` | critical | la última corrida de `backup.sh` falló |
| `BackupStale` | critical | sin backup exitoso en dos intervalos (la regla de `backup.sh --check`) durante 10 min |
| `HTTPErrorsHigh` | warning | más de 5 % de respuestas 5xx de la API (con algo de tráfico) durante 5 min |

Las alertas se ven siempre en Grafana: en el dashboard (panel "Alertas activas") y en
Alerting → Alert rules. Las notificaciones van por Alertmanager a los canales que estén
configurados por variables de entorno: Discord, Telegram, un webhook o email
(`09-deployment-aws.md`). Sin canales configurados, no se envían. Mientras
`GameServerDown` está activa, se silencian las `warning`.

`outcome="abandoned"` solo ocurre al apagar, cuando vence el plazo de una etapa. Pasa
microsegundos antes de que el proceso termine, y el proceso siguiente empieza la serie en
0. Para que Prometheus alcance a leerlo, el gameserver mantiene `/metrics` arriba
`-metrics-linger` (20 s, más que un scrape) después de apagarse, solo si hubo algo
abandonado. Por eso el compose le da `stop_grace_period: 90s`. Aun así es best effort:
la fuente de verdad son los logs `save abandoned at shutdown`, `job abandoned at
shutdown` y `batch abandoned at shutdown`, que llevan el contenido completo.

## Seguridad básica
- Rate limit por IP en login y por conexión en comandos.
- Validación de forma de cada mensaje (tamaño máximo, rangos).
- Nada del cliente se usa sin validar contra el estado del servidor.
- Secretos por variables de entorno, nunca en el repo.

## Trampas y anti-bot
Decisión del 2026-11-03: el juego se sigue jugando en el navegador y en el escritorio
(Tauri). No hay anticheat en el cliente. Las trampas se combaten en el servidor.

### El cliente no es de confianza
- Cualquier cliente puede estar modificado: el del navegador, el de Tauri o uno escrito
  a mano. `tools/bots` ya es un cliente sin interfaz que habla el protocolo (Protobuf
  sobre WebSocket).
- Por eso el servidor decide todo lo que importa:
  - el movimiento: velocidad según el suelo y colisiones;
  - el combate: rango, línea de visión, cooldowns y daño;
  - la magia: maná y cooldowns;
  - el inventario, el botín, el comercio y la recolección.
- Con cualquier cliente ya es imposible:
  - correr más rápido o teletransportarse;
  - hacer más daño o curarse más;
  - duplicar items u oro;
  - atacar a través de un muro o fuera de rango.

### Por qué no hay anticheat en el cliente
- **Hacerlo instalable no protege.** El webview, la memoria del proceso y el tráfico
  siguen siendo manipulables. Un bot que habla el protocolo directamente ni siquiera usa
  nuestro cliente.
- **Un anticheat a nivel de sistema no compensa.** Los del tipo BattlEye o EasyAntiCheat
  cuestan dinero, son invasivos y tienen mal soporte en Linux y macOS. Tampoco ven a un
  bot de protocolo. Otros juegos del género tienen cliente de escritorio con anticheat y
  siguen llenos de bots.
- **El navegador es la puerta de entrada.** Abrir un link y jugar es lo que más jugadores
  trae a un juego chico.
- **Si alguna vez hace falta más fricción:** el `Hello` ya lleva la versión del cliente, y
  se le podría sumar el tipo de cliente para exigir el de escritorio en modos competitivos
  (PvP). Sería fricción, no protección, y no está planificado.

### Lo que un tramposo sí puede hacer, y la respuesta
1. **Bots y macros**: cazar solo, curarse solo o recolectar 24/7. Respuesta:
   - límites de ritmo;
   - diseño de juego que le quite valor al bot;
   - detección por comportamiento en el servidor (T4.1).
2. **Ver de más.** Todo lo que el servidor manda se puede leer, así que el servidor solo
   manda lo que las reglas dejan ver:
   - **La ventana completa.** Se ve la ventana de 15x11 del piso visible. Lo que está
     detrás de un muro dentro de esa ventana se ve por diseño: la línea de visión es una
     regla de juego, no de dibujo (`03-world-and-maps.md`).
   - **De otras criaturas viaja solo lo público:** nombre, outfit, dirección, velocidad y
     `health_percent`. Nunca su vida exacta, maná, skills ni inventario.
   - **Bajo tierra** solo se manda el piso actual (ver "Área de interés").
   - **Lo oculto se filtra en el servidor.** Esto incluye la invisibilidad (T3.2), las
     trampas y los secretos del mapa. A quien no puede ver algo, ese algo no se le manda.
     No alcanza con que el cliente no lo dibuje. La invisibilidad ya lo hace (qué no viaja:
     `05-network-protocol.md`, "Condiciones"); `TestInvisibilityIsFilteredByServer`
     (`internal/session/condition_test.go`) es la auditoría de información de T4.1 para ese
     caso. Un invisible sigue ocupando su casilla: quien intente pisarla recibe
     `WalkRejected` (un camino por click lo rodea) y los monstruos lo esquivan. Es una pista
     aceptada.
   - **No viaja** lo que está fuera de la ventana: jugadores, botín ni restos. Tampoco su
     posición por otro camino: un grito llega más lejos que la ventana, y quien no ve a
     quien grita lo oye por nombre, sin posición; de un proyectil con una punta fuera de la
     ventana esa punta llega en el borde, alineada con la otra (solo se sabe el lado).
     Tampoco por las respuestas: una acción sobre un item del suelo o un hechizo o runa
     apuntado a una casilla que el jugador no ve responde igual haya algo ahí o no (antes
     decía "muy lejos" o "fuera de alcance" solo si lo había). Todas estas fugas las encontró
     la auditoría de T4.1.
   - **Grupos (T3.3):** de un miembro fuera de vista solo viajan nombre, vocación, nivel e
     isla; vida y maná solo mientras está en vista, y nunca la posición. Invitar exige ver
     al jugador. `TestPartyInfoAudit` (`internal/session/party_test.go`) es la auditoría.
3. **Abuso de la API HTTP** (registro masivo, fuerza bruta). Respuesta: los rate limits
   por IP, por cuenta y por email+IP de T1.3.

### Defensas que ya existen
- Rate limit por conexión: 30 mensajes por segundo con ráfaga de 60
  (`internal/net/gateway`). Lo que sobra se descarta. Si el exceso se sostiene, la
  conexión se cierra con `RATE_LIMITED`.
- Validación de forma y de rangos de cada mensaje, y versión mínima de cliente en el
  `Hello`.
- Anti-flood de chat, entrenamiento que rinde menos contra un objetivo que no responde,
  recolección con un intervalo mínimo y recursos que se agotan (`02-game-design.md`).

### Moderación (T2.6)
Reglas de juego y comandos en `02-game-design.md` ("Moderación").
- **Roles** en `accounts.role` (`player` por defecto, `gm`, `admin`). Solo los cambia la
  herramienta del operador (`gameserver admin set-role`), que escribe el cambio y su
  entrada de auditoría en una transacción, y revoca los tokens de la cuenta. El log no
  guarda el email (no se podría borrar después): solo el id de la cuenta. No hay mensaje del protocolo ni comando del
  juego que cambie un rol: el cliente no tiene forma de escalar privilegios.
- **Comandos por chat:** un `Say` cuyo texto empieza con `/`. Se eligió el chat y no un
  mensaje nuevo porque no suma superficie al protocolo y un cliente común ya puede
  escribirlos. `session/admin.go` los ejecuta en el game loop: el rol viene del login
  (`Character.Role`), se revisa en cada comando y los argumentos se validan contra el
  estado del servidor. Sin mutex: todo lo del mundo lo toca el loop.
- **Persistencia fuera del tick:** el loop arma la entrada de auditoría con la hora del
  tick (reloj inyectable) y la entrega sin bloquear a la goroutine de admin
  (`app/admin.go`, como el `Saver`). Si la cola está llena, el loop la guarda y reintenta en
  el próximo flush, en orden: ninguna entrada se pierde. Un error de la base se reintenta
  con backoff. Al apagar se drena la cola y se escribe lo pendiente.
- **Bans:** `/ban` y `/unban` son trabajos de esa goroutine. En una transacción resuelven
  el personaje, revisan la jerarquía, insertan o levantan el ban (`account_bans`), revocan
  los tokens y escriben la auditoría. La jerarquía usa el rol actual del actor en la base
(el menor entre ese y el del login), así un GM degradado pierde los bans al instante.
- **Revocación en vivo:** cada `RoleCheckEvery` (100 ticks, 5 s) el loop entrega a la
  goroutine de admin un trabajo `AdminCheckRoles` con las cuentas del staff en línea; la
  goroutine lee sus roles (`GetAccountRoles`) y los devuelve con `World.RolesChanged`, que
  solo **baja** `Player.role` (una cuenta borrada cuenta como jugador). Después de cada
  comando de staff auditado se relee también el rol de su autor. El tick nunca espera a
  la base; si la cola está llena, esa ronda se salta. El resultado vuelve al loop (`World.AdminDone`), que
  desconecta a los personajes de la cuenta con `BANNED` y recuerda el ban en memoria: así
  frena también un login que leyó la base antes del ban. Además, las consultas de sesión,
  de canje del token de juego y de carga del personaje excluyen a las cuentas con un ban
  activo, y el login responde `account_banned` (solo si la contraseña es correcta).
- **El resultado de un ban no se pierde:** si la cola del loop está llena, la goroutine de
  admin reintenta encolarlo hasta que haya lugar o el loop pare. Un trabajo que la base
  rechaza por valores inválidos se responde como fallido y se audita con una entrada
  reducida. Si al apagar la base no responde, lo que queda (en la cola o pendiente en el loop) va
  completo al log estructurado: actor, acción, objetivo y argumentos.
- **`audit_log`** es append-only (triggers como `economy_log`) y no tiene claves foráneas:
  sobrevive al borrado de cuentas. El operador lo lee con `make audit-log`.

### Log de economía (T4.1)
- **Qué se registra:** toda creación y destrucción de oro e items, por fuente
  (`economy_log.kind`): `loot` (al llenarse los restos de un monstruo, a nombre de quien se
  lleva el botín), `npc_buy` y `npc_sell` (tienda), `npc` (lo que da o quita un diálogo:
  items de quest, bendiciones), `quest` (recompensas), `tutorial` (premio del tutorial, T4.2), `travel` (pasaje y ticket),
  `gather` (pesca, minería, tala), `craft` (ingredientes y resultado), `death` (lo que cae
  en los restos al morir), `gm` (`/item`), `consume` (comida, pociones, la última carga
  de una runa, munición; también lo usado del suelo, a nombre de quien lo usó), `conjure`
  (hechizos que crean items) y `decay` (lo que quedaba en unos restos al pudrirse, a nombre
  del muerto si era un jugador). `trade` queda reservado
  para la ventana de intercambio, que todavía no existe. `count` (unidades) y `amount`
  (dinero, en cobre) llevan signo: positivo se crea o se recibe, negativo se destruye o se
  pierde. `details.ref` es el id de contenido de la fuente (monstruo, NPC, receta, quest).
- **Costo en el tick:** el loop solo agrega la entrada (un struct por valor, sin punteros
  nuevos) a un buffer que reutiliza; en el flush le pone la hora del tick y la entrega por
  canal a su goroutine (`app/economy.go`), sin esperar. Si la cola está llena, la guarda en
  orden para el próximo tick, hasta 65536; después las descarta con log y alerta
  `log_dropped`. La goroutine junta lotes de hasta `economy.log.batch_size` filas o
  `flush_ms`, une las entradas seguidas que solo difieren en la hora (flecha tras flecha,
  sin cambiar el orden del log) y escribe con COPY a una tabla temporal y luego `INSERT …
  ON CONFLICT DO NOTHING`. Cada fila lleva el id de su lote y su índice (índice único), y
  un reintento usa el mismo id: si el COPY llegó a confirmarse pero la respuesta se perdió
  (timeout), el reintento no duplica filas, que parecerían una duplicación de items. Un
  error de la base se reintenta con backoff; al apagar se drena, y si vence el plazo del apagado lo que queda se abandona
  (con log) sin intentarlo, así el apagado no se alarga con la base colgada.
- **Decisión: el log puede perder entradas, con límite y aviso.** A diferencia de
  `audit_log`, no es el registro de verdad (el estado de cada personaje está en su
  guardado) sino un dato para investigar. Mientras la base no responde, la cola del canal
  (16384) y la del loop (65536) dan unos minutos con mucha actividad. Después se descarta y
  se avisa, antes que dejar crecer la memoria del loop sin límite.
- **Cuadratura:** cada personaje en línea tiene un libro con lo que llevaba al entrar más
  lo que el log dice que ganó y perdió, más lo que pasó del suelo a su inventario y al
  revés (eso no se registra: sigue en el mundo). Cada `economy.check_every_ms`
  (escalonado por id de criatura) su oro y sus unidades de items tienen que dar lo mismo.
  Si no dan, un camino del código creó o destruyó algo sin decirlo (posible duplicación):
  log de error con lo esperado y lo real, alerta `mismatch`, y el libro se vuelve a
  alinear. También se cuadra al salir del mundo, así no se escapa una duplicación justo
  antes del logout. En los tests de `session` la cuadratura corre en cada tick y una diferencia
  hace fallar el test, así cada test de la suite también prueba el log.
- **Atípicos:** lo que un personaje crea en una ventana de `outlier.window_ms` (oro de
  botín, ventas y recompensas; items de botín, recolección, oficios, conjuros, recompensas y
  GM; las compras no cuentan) se compara con `base + per_level × nivel` por hora. Si lo
  pasa: log de aviso y alerta `gold_outlier` o `items_outlier`, una vez por ventana. Lo
  comprado a un NPC descuenta del oro (vender y recomprar no suma). La ventana es del
  personaje, no de la sesión: volver a entrar no la reinicia. Es para que un GM mire; no
  sanciona nada.

### Reportes de jugadores (T4.1)
- Reglas en `02-game-design.md` ("Moderación"). El cliente manda solo el motivo; el
  contexto lo arma el servidor con lo que sabe: posiciones, nivel y los últimos eventos de
  cada jugador, en dos anillos fijos de 32: uno para el chat y otro para lo demás
  (objetivo nuevo, muertes, economía). El reporte lleva hasta la mitad de líneas de chat y
  completa con lo demás, en orden de tiempo, así el reportado no puede sacar del contexto lo
  que dijo con una ráfaga de otros eventos. Volver a elegir el mismo objetivo no es un
  evento nuevo. Agregar un evento cuesta lo mismo siempre y no asigna memoria.
- El rate limit (GCRA por cuenta y un mapa cuenta→personaje) vive en el loop; los mapas
  se podan solos. El reporte va a la goroutine de admin como un trabajo más
  (`AdminReport`), que lo inserta en `player_reports` junto con su entrada de
  `audit_log` en una transacción. Listar y cerrar (`AdminListReports`,
  `AdminCloseReport`) también se auditan en la misma transacción y la respuesta vuelve al
  loop con `World.AdminDone`. Si la base rechaza un reporte, queda entero en el log
  estructurado.
- `/report Nombre` confirma si un nombre está conectado (`report.offline`), y a cambio cuesta
  un reporte de la cuota de la cuenta: cada intento que pasa el uso se cobra antes de
  resolver el nombre, así que pasada la ráfaga todos responden `report.too_fast` sin decir
  nada. Un invisible que el jugador no ve figura como desconectado. El botón no revela nada
  (solo alcanza a jugadores a la vista), así que cobra solo el reporte que se archiva.

### Auditoría de información (T4.1)
`internal/session/info_audit_test.go` recorre con reflexión de protobuf cada mensaje que
recibe un observador y comprueba que toda posición, área de mapa y piso esté dentro de lo
que ve: criaturas, items y restos fuera de la ventana, pisos de arriba y de abajo bajo
tierra, pisos subterráneos desde la superficie, un grito desde lejos y un proyectil con
una punta fuera (tirador o blanco, también fuera de su columna). También pide: acciones
sobre items del suelo y hechizos y runas apuntados a casillas que no ve (lejos o en otro
piso) responden igual haya algo o no, sin gastar maná ni cargas. También que de otro jugador no llegue nada privado (`PlayerStats`, skills,
inventario, contenedores, condiciones) y que los mensajes sobre criaturas no tengan campos
de vida exacta, maná, skills ni inventario (solo `health_percent`). Invisibilidad y grupos
siguen en sus tests (ver arriba).

### Detección de bots (T4.1)
Reglas para el jugador en `02-game-design.md` ("Anti-bot y anti-AFK"); números en
`balance.yaml → antibot` (esquema en `balance.schema.json`).
- **Dónde corre:** `internal/antibot` es puro (sin reloj, sin azar, sin mundo). El loop
  alimenta un `Tracker` por personaje con tiempos de juego en ms (tick × 50): acciones
  reales, pasos, golpes recibidos y curas. Cada actualización cuesta lo mismo, sin importar
  el historial: medias y varianzas móviles exponenciales (unas 100 muestras), un anillo de
  32 pasos y una tabla fija de 128 hashes de segmentos de ruta. Cada `eval_every_ms` (60 s,
  escalonado por id de criatura) se leen las señales y se actualiza el puntaje. Las
  medianas de ingreso por banda de nivel se calculan una vez por ronda.
- **Señales** (cada una entre 0 y 1):

| Señal | Qué mide | 1 cuando… | Peso |
|---|---|---|---|
| `regularity` | Variación del tiempo entre acciones del **mismo tipo** (hechizo/runa, uso de item, chat, otra; mover items es "otra"). Tiene que ser baja en relación (coeficiente de variación) **y** en absoluto (desvío estándar): el error de una persona no se achica con el intervalo, así que un ritmo largo que pone un recurso del servidor (lanzar al llenarse el maná, con la regeneración fija) da un CV bajo pero un desvío de segundos. No cuentan los pasos ni las acciones cuyo ritmo puso el servidor: las que llegan justo al vencer su cooldown (≤ 100 ms) y las que siguen a un intento rechazado por cooldown o por falta de maná (quien machaca un hotkey: el cliente manda una acción por pulsación, sin repetición automática, y el servidor acepta la primera que puede). | CV ≤ `cv_low` (0,05) y desvío ≤ `std_ms` (60 ms); 0 desde `cv_high` (0,25) o desde 2 × `std_ms`; con ≥ 300 muestras | 3 |
| `reaction` | Tiempo desde un golpe recibido hasta la cura (hechizo propio o consumible) que lo contesta, dentro de `window_ms`. | Las curas llegan en ≤ `fast_ms` (200 ms; una persona reacciona en unos 300 ms con la latencia) y con desvío ≤ `std_ms` (60 ms), con ≥ 15 muestras | 3 |
| `route` | Parte de los segmentos de `segment` (12) pasos exactos (casilla y dirección) ya caminados. | ≥ `repeat_high` (90 %) repetidos; 0 bajo `repeat_low` (50 %), con ≥ 300 pasos | 2 |
| `session` | Juego sin una pausa de `pause_ms` (3 min). | 16 h seguidas; 0 hasta 8 h | 1 |
| `income` | Experiencia u oro por hora (la ventana de atípicos del log de economía) sobre la mediana de su banda de 10 niveles, cada serie por separado: cuentan solo los pares que juegan (activos) y ganaron algo en esa serie (≥ 5). La mediana nunca cuenta como menos que el ritmo esperado del nivel del personaje: de experiencia, el objetivo de ritmo `experience.pace` (horas para llegar a cada nivel, una ley de potencia entre anclas: unos 3 niveles por hora al 9, 1 al 20, 0,3 al 45) por la experiencia de un nivel; de oro, un cuarto de `economy.outlier.gold_per_hour`. | 8 veces la mediana; 0 hasta 4 veces | 2 |

- **Cada señal envejece con su propia evidencia:** cuando la última muestra de una señal
  (acciones de ese tipo, curas, pasos) tiene más de `pause_ms`, la señal vale 0, y la
  próxima muestra empieza la estadística de cero. Así una caza terminada no sigue sumando
  mientras el personaje solo chatea, ni al volver a entrar. Inactivo, todas valen 0. Las
  primeras muestras usan la media simple (no un primer valor que domine la media móvil).
- **Puntaje:** en cada evaluación, `puntaje × 0,5^(Δt / half_life_ms) + Σ peso × señal`.
  Con media vida de 1 h y una evaluación por minuto, una señal sostenida de peso `w` se
  estabiliza cerca de `w × 87`. Un minuto raro se desvanece; solo un patrón sostenido suma.
  El estado vive en el `World` por personaje: volver a entrar no lo reinicia. Se olvida
  cuando el personaje está desconectado y el puntaje decayó a menos de 1.
- **Respuestas graduales**, una vez por episodio (un nivel vuelve a armarse cuando el
  puntaje baja de la mitad de su umbral):
  1. `log` (100): log estructurado y `audit_log` (`bot_suspect`, actor `system:antibot`,
     con el puntaje y las señales).
  2. `notify` (300): mensaje a los GM en línea (`gm.bot_suspect`), auditado. Ninguna
     señal sola llega: la mayor pesa 3 y se estabiliza en ~261. La carga del balance lo
     exige (un peso × 87 tiene que quedar por debajo de `notify`).
  3. `presence` (400): un chequeo de presencia (ver abajo).
  4. `suspend` (600): suspensión de `suspend_ms` (24 h, motivo `antibot`), por la goroutine
     de admin como un `/ban` de GM (solo alcanza a cuentas de jugador; auditada en la misma
     transacción; si no se aplica, queda en el log). Necesita, en este episodio, **un
     chequeo fallado o uno hecho hace al menos `confirm_ms` (1 h)** con el puntaje todavía
     ahí; si no, se pide un chequeo. El ban largo o permanente lo decide siempre un GM.
- **Chequeo de presencia** (`PresenceCheck`/`PresenceAnswer`): una pregunta simple (elegir
  un color entre cuatro, textos i18n `presence.*`) en un momento al azar de los próximos
  `delay_ms`. **Nunca en combate, sobre una casilla sin logout ni a alguien inactivo:** se
  espera a que se pueda. No bloquea el juego. Plazo generoso (`timeout_ms`, 10 min) que
  corre **solo mientras el personaje juega** (conectado y activo), así que estar ausente
  nunca es un fallo: al volver se manda otra vez con el tiempo que le queda, y el servidor
  no vence antes de ese tiempo jugado. El cliente lo cierra solo 3 s antes de su hora (al
  vencer, el servidor no le dice nada al jugador y descarta una respuesta tardía); un click
  en la ventana se manda siempre, porque si el jugador estuvo ausente el chequeo puede
  seguir pendiente en el servidor. La respuesta, correcta o no, recibe siempre
  `presence.thanks`.
- **Qué prueba y qué no:** un chequeo prueba que algo contestó, no que no haya un bot: las
  preguntas y sus textos son públicos y un script las puede contestar. Por eso **acertar no
  baja el puntaje** (solo queda auditado) y la suspensión no depende de fallar: también llega
  si el patrón sigue una hora después del chequeo. Fallar (mala respuesta o fuera de plazo)
  suma `fail_points` y avisa a los GM, pero **nunca lleva el puntaje al umbral de
  suspensión por sí solo** (queda justo debajo): solo suspende un puntaje que ya estaba ahí.
- **No es un oráculo de sospecha:** con `random_per_hour` (2 % por hora de juego) cualquier
  jugador activo recibe a veces un chequeo al azar, idéntico, que no tiene efecto si se
  falla (auditado como `random_*`). Un GM puede pedir uno con `/presence Nombre`: si ya había
  uno de respuesta pendiente solo lo adelanta; si no, es como uno al azar. Si el puntaje
  pasa `presence` mientras hay uno al azar abierto, al cerrarse viene el de respuesta.
- **Fin de un episodio:** si el puntaje baja de la mitad de `presence`, un chequeo de
  respuesta todavía pendiente pasa a ser uno al azar (se pregunta igual, así que salir del
  juego no lo esquiva, pero ya no tiene efecto).
- **Esquivarlo no sirve:** si un chequeo debido no se puede hacer durante `defer_alert_ms`
  (30 min) **de juego** porque el personaje vive en combate o en una casilla sin logout, se
  avisa a los GM y se audita (`deferred`): lo decide una persona. El tiempo inactivo o
  desconectado no cuenta, y al volver a entrar el puntaje se evalúa (con su decaimiento)
  antes de cualquier chequeo.
- **Staff:** los personajes de GM y admin no se evalúan ni cuentan para las medianas.
- **Pruebas** (`internal/session/antibot_sim_test.go`, simulación determinista con
  `data/balance.yaml`; ~3 s en total):
  - `TestAntiBotFlagsMechanicalNotHuman`: `bot.Mechanical()` de `server/pkg/bot` (el mismo
    de `tools/bots -profile`) pasa por log, aviso, chequeo, fallo y suspensión en ~1 h 40
    de juego. `bot.Human()` no recibe ninguna marca, pero es solo un control de cordura: por
    construcción no dispara ninguna señal.
  - **La evidencia contra falsos positivos** es `TestAntiBotHumanHabitsNeverNotify`:
    hábitos que un jugador real tiene con el cliente (click de ida y vuelta entre dos
    casillas, que da la misma ruta A*; machacar un hotkey con cooldown cada 150–300 ms;
    curarse a velocidad humana, N(250, 50) ms más 50 ms de latencia), solos y de a pares,
    con pausas y sin ellas, 6 h cada caso. Y 8 h sin pausas de: entrenar magia a mano
    (lanzar 0,3–3 s después de llenarse el maná, sin moverse, un chat cada 1–4 min), apretar
    un hotkey parejo a la señal del cooldown (listo + N(300, 50) ms, nunca antes) y curarse
    más rápido, N(220, 35) ms, yendo y viniendo por click. Ninguno de esos casos llega a
    `notify`, a un chequeo ni a una suspensión: el peor queda en `log` (~260 puntos, el
    hotkey parejo, que solo marca `regularity`). Dos señales completas sí avisan, a
    propósito: apretar parejo y además ir y venir por click llega a `notify` (y sin pausas
    a un chequeo). Con el contenido real nadie lo sostiene: el maná se acaba, y lo que se
    rechaza por falta de maná cuenta como ritmo del servidor.
  - `TestAntiBotPastHuntStopsScoring`: 30 min de caza mecánica y después 5 h solo
    chateando y acertando los chequeos terminan en el nivel 0, sin suspensión.
- **Límite conocido:** un script puede esconder su ritmo de `regularity` mandando un
  intento rechazado justo después de cada acción (así cada una cuenta como "ritmo del
  servidor"). Es el precio de no marcar a quien machaca un hotkey; lo cubren las demás
  señales (reacción, ruta, sesión, ingreso), y un GM puede pedir un chequeo cuando quiera.
