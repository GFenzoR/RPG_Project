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
| Logs de economía (trades, drops raros) | Postgres, tabla append-only | Asíncrono por lotes |
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

## Observabilidad mínima
- `/healthz` en la API pública. `/metrics` (Prometheus, `internal/metrics`) va en un
  listener aparte, `-metrics-addr` (por defecto `127.0.0.1:9100`, vacío lo apaga), para
  que el proxy de la API nunca lo exponga.
- Logs JSON con `slog`. Métricas que hay (T1.17): `tick_duration_ms` (histograma),
  `tick_overruns_total`, `tick_commands_total`, `command_queue_pending`, `ws_connections`,
  `ws_sent_bytes_total`, `ws_sent_batches_total`, más las estándar `process_*` (CPU, RSS) y
  `go_*`. Pendientes: errores de persistencia.

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
     No alcanza con que el cliente no lo dibuje.
   - **No viaja** lo que está fuera de la ventana: jugadores, botín ni restos.
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
(el menor entre ese y el del login), así un GM degradado pierde los bans al instante. El resultado vuelve al loop (`World.AdminDone`), que
  desconecta a los personajes de la cuenta con `BANNED` y recuerda el ban en memoria: así
  frena también un login que leyó la base antes del ban. Además, las consultas de sesión,
  de canje del token de juego y de carga del personaje excluyen a las cuentas con un ban
  activo, y el login responde `account_banned` (solo si la contraseña es correcta).
- **El resultado de un ban no se pierde:** si la cola del loop está llena, la goroutine de
  admin reintenta encolarlo hasta que haya lugar o el loop pare. Un trabajo que la base
  rechaza por valores inválidos se responde como fallido y se audita con una entrada
  reducida. Si al apagar la base no responde, lo que queda va completo al log estructurado.
- **`audit_log`** es append-only (triggers como `economy_log`) y no tiene claves foráneas:
  sobrevive al borrado de cuentas. El operador lo lee con `make audit-log`.

### Lo que falta
La detección de bots, los reportes, el log de economía y la auditoría de lo que se envía
quedan en T4.1. Ver `10-roadmap.md`.
