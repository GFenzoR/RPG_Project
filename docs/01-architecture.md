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

Transacciones: el trade entre jugadores se resuelve atómicamente en el loop (estado en
memoria) y se persiste ambos personajes en una sola transacción de base de datos.

## Autenticación y cuentas
- Email + contraseña (argon2id), verificación de email, reset de contraseña.
- OAuth 2.0 con Google y Discord vinculados a la misma cuenta.
- Una cuenta tiene varios personajes. Cosméticos pertenecen a la cuenta.
- Tokens de sesión opacos en Postgres (fácil de revocar); cookie `HttpOnly` en web,
  almacenamiento seguro en Tauri.

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
- `/healthz` y `/metrics` (Prometheus) internos.
- Logs JSON con `slog`. Métricas clave: jugadores online, duración del tick (p50/p99),
  comandos/segundo, bytes enviados/segundo, errores de persistencia.

## Seguridad básica
- Rate limit por IP en login y por conexión en comandos.
- Validación de forma de cada mensaje (tamaño máximo, rangos).
- Nada del cliente se usa sin validar contra el estado del servidor.
- Secretos por variables de entorno, nunca en el repo.
