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
| `/api/*`, `/ws`, `/healthz` | gameserver: API HTTP (cuentas, personajes, `play`, la tienda `shop` y el webhook `payments/webhook/<proveedor>` (T5.7), y los públicos `status`, `highscores`, `guilds` y `houses`; docs/05), WebSocket del juego y health |
| `/play`, `/play/*` | página del juego del build del cliente (`client/play/index.html`) |
| todo lo demás | sitio público (`client/index.html`): landing en `/`, `/highscores`, `/guilds[/<id>]` (T5.1), `/houses` (T5.4), `/news` y `/news/<fecha>-<slug>`; primero los archivos estáticos del build (`/assets`, `/atlas`, `/audio`) |

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
| Estado del mundo (items en el suelo) | Memoria | Se pierde al reiniciar (como Tibia en sus inicios), salvo el suelo de las casas |
| Log de economía (T4.1: creación y destrucción de oro e items por fuente) | Postgres, `economy_log` append-only | Asíncrono por lotes (COPY), goroutine propia |
| Reportes de jugadores (T4.1) | Postgres, `player_reports` | Asíncrono, goroutine de admin |
| Mapa y contenido | Repo git (world/, data/) | Se despliegan con cada versión |
| Roles, bans y log de auditoría (T2.6) | Postgres (`audit_log` append-only) | Asíncrono, goroutine de admin |
| Gremios: `guilds`, `guild_members`, `guild_invites` (T5.1) | Postgres; el loop tiene todos en memoria | Se cargan una vez al arrancar; cada cambio, asíncrono y en orden por la goroutine de admin |
| Guerras de gremios: `guild_wars` (T5.2) | Postgres; el loop tiene las abiertas en memoria | Como los gremios: se cargan con ellos y cada cambio va en orden por la goroutine de admin |
| Marca PvP, contador y muertes injustificadas (T5.2): `characters.skull`, `skull_until`, `pvp_kills`, `pvp_unjust_kills` | Postgres | Con el snapshot del personaje (la misma transacción) |
| Casas (T5.4): `house_owners`, `house_guests`, `house_items` | Postgres; el loop tiene dueños, invitados y los items del suelo de cada casa en memoria | Se cargan una vez al arrancar, como el mercado; cada cambio es un `Transfer` del Saver con `HouseOp`, en la misma transacción que los snapshots de quienes movieron items u oro |
| Mercado (T5.3): `market_offers`, `market_mail_items`, `market_mail_gold`, `market_history`, `market_id_high` | Postgres; el loop tiene ofertas, buzones e historial reciente en memoria | Se cargan una vez al arrancar; cada cambio es un `Transfer` del Saver, en la misma transacción que los snapshots de los personajes que tocó |

**Gremios (T5.1).** El game loop es el dueño de los gremios, como del resto del mundo:
`app` lee todos (gremios, miembros e invitaciones vigentes) antes de arrancar el loop y se
los pasa al `World` (`session.Config.Guilds`). Cada comando se valida y se aplica en
memoria en el tick, y el cambio (`session.GuildChange`) se encola como trabajo de la
goroutine de admin (`AdminGuild`), que lo escribe en orden con reintentos, igual que el
log de auditoría; nada vuelve al loop. Por eso el id de un gremio lo asigna el servidor:
el siguiente al mayor emitido alguna vez (`guild_id_high`, que sube con cada fundación),
para que el id de un gremio disuelto no se reuse. Las restricciones de la base (un personaje en un solo
gremio, un líder por gremio, nombre único sin mayúsculas) son la red de seguridad: un
cambio que las rompe es un bug y queda en el log (`persistence_errors_total{writer="audit",
outcome="rejected"}`); el próximo arranque carga lo que tiene la base. Costo en el tick:
cada comando toca un solo gremio (a lo sumo `max_members` miembros y `max_invites`
invitaciones) y los nombres se buscan en un mapa; entrar o salir del mundo marca el gremio
para mandar un `GuildUpdate` a sus miembros conectados en el flush.

**PvP (T5.2).** El loop es el único dueño del estado PvP (`session/pvp.go`,
`session/guildwar.go`). La marca de cada jugador, su contador y sus muertes injustificadas
viajan en el `Snapshot` y se escriben con el resto del personaje (las filas de
`pvp_unjust_kills` se reemplazan enteras, como `quest_state`); un relogueo rápido las toma
del snapshot sin guardar. Las guerras siguen el camino de los gremios: se cargan con
`LoadGuilds` (solo las abiertas) y cada cambio (`GuildWarDeclare`, `GuildWarStart`,
`GuildWarKills`, `GuildWarEnd`) sale como `AdminGuild`; su id también lo asigna el loop
(`guild_id_high.war_high`). Los tiempos de las marcas y las guerras son del reloj
inyectable (`ctx.Now`); los bloqueos, en ticks. Costo en el tick: cada chequeo lee unas
pocas banderas de casilla y como mucho 8 atacantes recientes por víctima; un barrido por
segundo recorre solo a los jugadores con marca y las guerras abiertas (como mucho
`max_wars` por gremio), nunca a todos los jugadores. Un jugador que pierde la conexión con
el bloqueo PvP activo sigue en el mundo (link-dead: su lote se descarta en el flush) hasta
que el bloqueo vence; el mismo barrido lo saca y guarda su snapshot final. Vale igual si
la conexión la corta el servidor (cliente lento, `KickAccount` de un reseteo de
contraseña): `World.disconnect` llama a `Client.Close` una sola vez y deja al jugador
link-dead; los comandos que todavía lleguen de esa conexión y el `Leave` del gateway se
ignoran, y `remove` ya no le manda ni cierra nada. Los kicks y bans de staff, el logout y
un transfer que no se guardó sacan al jugador en el acto con `remove`. Una condición de
otro jugador se guarda con la hora del tick del snapshot (`Scheduler.Time`, el
`TickContext.Now` del tick en curso, para código del loop sin contexto) y al entrar se
descuenta el tiempo que la víctima estuvo fuera.

**Casas (T5.4).** Las casas son datos del mapa (`world.House` en `world.bin` v4); quién
alquila cada una, sus invitados y los items de su suelo los tiene el loop, que los carga
una vez antes de arrancar (`app` → `HouseStore.LoadHouses` → `session.Config.Houses`) y es
su único dueño. Todo cambio sale como `Transfer` (ver "Transacciones") con `HouseOp`:
- alquilar, pagar, dejar, transferir, invitados y gremio: en el tick del comando, con el
  snapshot del personaje que pagó (si el inventario cambió) y, si corresponde, las filas
  del buzón del mercado (precio de una transferencia, items de una casa liberada);
- los **items del suelo**: todo cambio de una casilla de casa (`tileChanged`) o de un
  contenedor apoyado en ella (`containerChanged`) marca la casa como sucia y anota al
  jugador cuyo comando la cambió (`World.cmdPlayer`). Las casas sucias de un tick salen en
  **un solo transfer** (`flushHouses`) con la lista entera de items de cada una (se
  reemplaza en la base: idempotente) y los snapshots de esos jugadores. Se vacía al final
  de cada comando (`Input`), antes de numerar cualquier otro transfer (`transfer`,
  `houseTransfer`), antes de tomar cualquier snapshot (`snapshot`), al liberar o
  transferir una casa, al sacar a un jugador del mundo y al final del tick (también después
  de `questRecheck`, que puede dejar una recompensa en el suelo de una casa cuando
  `checkHouses` ya vació las de ese tick): los ids de los
  transfers crecen en el orden en que se encolan, un lote nunca lleva un snapshot a mitad
  de otra operación y un autoguardado nunca escribe un inventario sin la casa que lo
  explica. `SaveTransfer` acepta un id igual al último escrito como reintento (no aplica
  nada) y rechaza uno menor (`ErrTransferOrder`, permanente): un error de orden activa la
  falla segura en vez de perder un transfer en silencio.
  Así mover un item del inventario al suelo de la casa, o al revés, no duplica ni pierde
  nada si el servidor se cae: o están los dos lados nuevos o los dos viejos.
- Cobro del alquiler: un barrido por segundo de a lo sumo 32 casas (round robin) con el
  reloj inyectable; renovar descuenta el oro del buzón (`MarketGoldAdd` negativo, con
  guarda en la base) y liberar mueve los items al buzón (`MarketMailAdd`, aplanados: cada
  item en su fila) en el mismo transfer que borra al dueño. Nada de esto corre en la base desde el loop.
- La base es la red de seguridad: `house_owners` tiene una fila por casa (PK), un dueño
  por personaje y una casa por cuenta (UNIQUE), y cada cambio de dueño, pago o acceso
  lleva el dueño que el loop cree (`... AND character_id = $old`): si no coincide, el
  transfer falla entero (`ErrHouseConflict`, permanente) y rige la falla segura.
- Falla segura: con `w.readOnly` las casas no aceptan acciones, movimientos ni usos de
  items, `flushHouses` no escribe nada y el barrido se detiene. Los cadáveres que caen en una casa no se guardan (se pudren).

### Transacciones (T5.3)
El inventario vive en el loop y se guarda con el snapshot de cada personaje. Todo lo que
mueve items u oro **entre personajes, o entre un personaje y el mercado**, se decide en un
tick (atómico en memoria: las instancias se mueven, nunca se copian) y sale del loop como
**un solo trabajo de persistencia**, un `session.Transfer`:
- lleva los snapshots de los personajes en línea cuyo inventario cambió (los dos del
  intercambio; quien crea, acepta o retira en el mercado) y los cambios del mercado en
  orden (`MarketOp`: insertar, llenar o borrar una oferta, agregar o sacar del buzón,
  historial) con las marcas de ids;
- entra en **la misma cola del Saver** que los autoguardados (`Job`: snapshot o transfer).
  El Saver es una goroutine que escribe en orden, así un transfer queda detrás de los
  guardados anteriores de sus personajes y delante de los siguientes. Si la cola está
  llena, el `World` lo guarda y todo trabajo posterior espera detrás de él
  (`submitJob`): un autoguardado con el inventario nuevo nunca llega antes que el
  transfer que lo explica;
- `store.SaveTransfer` lo escribe en **una transacción**: los snapshots (con
  `saveCharacterState`, como un guardado normal) y luego cada cambio del mercado. Una
  caída antes del commit deja todo como estaba (el inventario viejo y el mercado viejo);
  después, todo nuevo. Un error transitorio se reintenta entero con backoff.
- **Idempotente:** cada transfer tiene un id creciente que asigna el loop (sigue desde
  `market_id_high.transfer_high` tras reiniciar). La transacción lo reclama primero
  (`ClaimTransfer`); si ya está tomado, es el reintento de uno que sí se confirmó pero cuya
  respuesta se perdió (timeout en el COMMIT), y no aplica nada otra vez.
- **Falla segura (sin mitades).** Un transfer que no se guarda (error permanente como
  `ErrMarketConflict` o una restricción, abandonado al apagar con la base caída, o uno
  pendiente del apagado que falla) deja la base con el estado de antes en **todos** sus
  lados, mientras el loop ya va por delante. Desde ahí:
  - **Marca** a sus personajes en el Saver: ningún trabajo posterior que toque a un
    personaje marcado se escribe en ese proceso, y saltar un transfer marca también a sus
    otros personajes (punto fijo: un intercambio con un marcado no llega a la base por el
    próximo guardado del otro). La misma regla rige los pendientes del apagado
    (`Saver.WritePending`, que usa `app` en "final saves").
  - **Avisa al loop** (`SaverConfig.Tainted` → `World.Tainted`): saca del mundo a los
    marcados (`Disconnect{SAVE_FAILED}`), descarta su estado sin guardar y rechaza su
    login (`Disconnect{CHARACTER_LOCKED}`) hasta reiniciar; el mercado queda en **solo
    lectura** (se puede buscar; crear, aceptar, cancelar, retirar y el vencimiento se
    detienen; `MarketUpdate.read_only`) y se cancelan los intercambios abiertos y no se
    abren otros. Así nadie más construye sobre una oferta o un buzón que la base no
    tiene. Un transfer solo de mercado (un vencimiento, una cancelación) que no se guarda
    no marca a nadie, pero también pone el mercado en solo lectura.
  - **El operador se entera:** log de error, `persistence_errors_total{writer="character",
    outcome="rejected|abandoned|skipped"}` y la alerta `PersistenceDataLost`
    (tabla de alertas de este doc). Al reiniciar se carga lo que tiene la base: los
    marcados pierden todo lo jugado desde su **último guardado escrito** (no solo desde el
    transfer), que no es anterior a lo que dieron al suelo público salvo en una caída o
    con la base caída al apagar (ver "Guardado antes del transfer" más abajo).
  - **Bajas con guarda:** cerrar una oferta (cancelar, vencer, `/marketcancel`) lleva las
    unidades que el loop cree que quedan (`DeleteMarketOffer ... AND amount = $units`). Si
    un llenado de esa oferta no se guardó, la base tiene más: el cierre falla entero
    (`ErrMarketConflict`) y pone el mercado en solo lectura, en vez de devolver al buzón
    menos de lo depositado.
  - **Apagado con semántica de caída:** si un transfer se abandona o falla durante el
    apagado (el plazo de `Stop` o en `WritePending`), ningún trabajo posterior se escribe,
    de ningún personaje (se cuentan como `abandoned`), como si el proceso se hubiera caído
    en ese punto.
  - **Espera hasta la confirmación (en ejecución, `session/hold.go`).** Entre el
    transfer que se va a descartar y `World.Tainted` (un tick más lo que tenga la cola
    del Saver) el personaje sigue jugando. El intercambio y el mercado ya están cubiertos
    (la marca del Saver y las bajas con guarda), pero el suelo público y los cadáveres no
    se guardan: lo que soltara ahí lo levantaría otro, cuyo guardado normal sí se
    escribe, y eso duplicaría lo recibido. Por eso cada snapshot de un transfer
    (`transferSnapshot`) deja a su personaje **en espera** (`World.inFlight`, con el `Seq`
    de ese snapshot) hasta que la base lo confirma:
    - `SaverConfig.Saved` → `World.Saved` acusa **todo** snapshot guardado (no solo el
      final), también los de un transfer. Uno con `Seq` mayor o igual al del último
      transfer termina la espera: el Saver escribe en orden y salta todo lo de un
      personaje marcado, así que si llegó ese guardado, el transfer está en la base.
      Por lo mismo, un acuse vale por todos los anteriores de su personaje.
    - Cada **reserva** de abajo (cadáver, lo que cae a sus pies, lo que sale de una casa)
      es una entrada de `World.heldGround` con el personaje y el `Seq` que la cubre, y la
      libera un acuse de ese `Seq` o mayor (`World.confirmed`), aunque el personaje siga
      en espera por transfers más nuevos. Quien encadena transfers más rápido de lo que
      el Saver los confirma sigue sin poder soltar nada, pero lo reservado para un
      transfer ya confirmado vuelve a ser de cualquiera.
    - Mientras espera, `MoveItem` rechaza (`inventory.saving`) llevar algo que el
      personaje carga, o que está en su propio cadáver, a una casilla que no es de una
      casa (directo o dentro de un contenedor apoyado ahí). Entre sus propios
      contenedores, a su equipo o a una casa, se mueve como siempre.
    - El cadáver que deja **mientras espera** queda reservado para él (`holdCorpse`, con
      el `Seq` de su espera al morir) aunque pase `corpse_owner_only_ms`, hasta que la
      base confirma esos transfers, y para siempre si uno se descartó (`World.reserved`):
      lo que tiene puede salir del estado descartado, y se pudre. Un cadáver de **antes**
      de la espera no: sus items salen de un estado que la base tiene (la muerte se guarda
      al instante, detrás de transfers ya confirmados), así que pasado
      `corpse_owner_only_ms` es de cualquiera aunque después se descarte un transfer de su
      dueño. Nadie mete nada en un cadáver reservado a otro (`death.corpse_not_owner`,
      también dentro de `corpse_owner_only_ms`): quedaría atrapado con él.
    - El **suelo de las casas** sí se guarda, con el transfer de quien lo movió (detrás
      del suyo en la cola). Lo cuida el Saver: un transfer saltado o rechazado marca
      también las casas cuyos items reemplazaba (`HouseItems`), y ningún transfer
      posterior escribe los items de una casa marcada (lo salta y marca a sus
      personajes, como en el punto fijo). Así lo que un marcado dejó en su casa no llega
      a la base por el invitado que lo levanta. Los demás cambios de esa casa (alquiler,
      dueño) se siguen escribiendo: tienen su propia guarda. Con las casas apagadas
      (`houses.enabled: false`) nada de eso se escribe, y una casilla de casa cuenta
      como suelo público.
    - Lo que **sale de una casa al suelo público** (directo, sumado a una pila o dentro
      de un contenedor apoyado ahí) queda **reservado** para quien lo sacó
      (`leftHouse`, en `World.heldGround`, sobre lo que lo contiene en el suelo) hasta
      que la base confirma la escritura de la casa que lo sacó. Esa escritura lleva el
      snapshot de quien lo movió (`flushHouses` al final de su comando), así que es su
      espera; y el Saver solo la escribe si entraron todas las anteriores de esa casa
      (una descartada la marca). Sin esto, algo que un transfer descartado dejó en una
      casa (lo que trajo un invitado en espera y el dueño sacó a la calle), o algo que la
      base todavía tiene en la casa porque se descartó la escritura que lo sacó (el dueño
      en espera lo tira a la calle), llegaría al guardado de otro desde la calle:
      duplicado. Mientras dura, nadie más lo levanta ni lo usa (`inventory.not_yours`) y
      quien lo sacó solo puede volver a tomarlo o devolverlo a la casa (llevarlo a otra
      casilla pública es `inventory.saving`). Nadie mete nada en un contenedor del suelo
      reservado a otro (`inventory.not_yours`): quedaría atrapado con él.
      Lo que sale de una casa queda como **pila propia** en la casilla, o se suma a una
      pila o entra en un contenedor que **ya** está reservado a quien lo saca. Nunca se
      suma a una pila ajena de la calle (cae como pila aparte) ni entra en un contenedor
      ajeno del suelo, sea una mochila o un cadáver (`MoveItem` lo rechaza con
      `inventory.floor_first`: primero al suelo). Si no, la reserva se quedaría con lo de
      otro: el dueño de la pila, la mochila o el cadáver no podría tomar lo suyo mientras
      dure la espera, y nunca si la escritura de la casa se descarta (quien sacó el item
      queda marcado aunque sea inocente, por ejemplo si la casa quedó marcada por el
      transfer descartado de un invitado).
    - Normalmente la espera dura uno o dos ticks y no se nota. Con la base caída dura
      hasta que el transfer se escribe (correcto: no está guardado). Con la cola del loop
      llena, el `app` guarda el acuse para **una sola** goroutine de reintento
      (`app/acks.go`) que conserva el `Seq` más alto de cada personaje (vale por los
      anteriores) y los entrega cada tick hasta vaciarse: no se pierde ninguno, cuesta una
      entrada por personaje y no una goroutine por acuse, y uno que llega tarde no hace
      daño (`Saved` compara números de secuencia; también olvida el snapshot final en
      memoria con un acuse de ese `Seq` o mayor). Un relogueo conserva la espera (es del
      personaje, no de la conexión).
    - Lo que el **servidor** deja a sus pies porque no le entra no pasa por `MoveItem`
      (`giveItem`: una fabricación, una recolección o una recompensa, las monedas de una
      venta a un NPC; y el equipo que no cabe en su cadáver al morir). Si cae fuera de
      una casa queda **reservado** para él (`World.heldGround`, `holdGround`) mientras
      espera: nadie más lo levanta ni lo usa (`inventory.not_yours`), lo que otro suelta
      encima no se suma a esa pila (queda en una propia) y él solo puede volver a
      tomarlo (llevarlo a otra casilla pública también es `inventory.saving`). Si cae en
      una casa, se escribe con su snapshot (`houseActor`) aunque no lo haya puesto un
      comando suyo (una recompensa que llega por un evento): si un transfer suyo se
      descartó, el Saver salta esa escritura y marca la casa en vez de guardar ahí lo
      que salió del estado descartado.
      Una reserva termina con el acuse que la cubre (`World.Saved`) o cuando el item deja
      el suelo (`detach`); si el transfer quedó marcado, dura hasta reiniciar (un cadáver,
      hasta que se pudre). Las compras del mercado, el retiro del buzón y las compras a un
      NPC ya exigen que todo entre, así que nunca caen al suelo.
    - **Límite del modo degradado:** en solo lectura (`World.Tainted`) nada de las casas
      se escribe (`flushHouses` lo descarta) y nadie mueve ni usa nada en una casa. Lo que
      el servidor deja entonces a los pies de un jugador sobre el piso de una casa (una
      fabricación, una recompensa, las monedas de una venta a un NPC) no se reserva ni se
      guarda: queda en memoria, nadie puede sacarlo, y se pierde al reiniciar. No duplica
      nada; es una pérdida que se acepta mientras el servidor espera el reinicio.
    - **Qué no cubre, y por qué no duplica:** lo que el personaje gasta en ese instante
      (comer, cargas de una runa, materiales de una fabricación) desaparece igual en la
      base, y lo que gana jugando (botín de un monstruo, experiencia) es juego nuevo que
      el relogueo al último guardado pierde, como en cualquier caída. Fuera de eso, los
      caminos de hoy por los que algo suyo llega a otro personaje (intercambio, mercado,
      casas, suelo, cadáver) están cubiertos, mientras espera por la espera y antes por el
      guardado de abajo; uno nuevo tiene que respetar los dos (server/CLAUDE.md), y las
      alertas de economía (T4.1) siguen como red.
  - **Guardado antes del transfer (`session/hold.go`, `gaveAway`).** La espera cubre lo
    que pasa mientras un transfer no está confirmado, pero un marcado vuelve a su
    **último guardado escrito**, que puede ser anterior. Lo que dio **antes** del
    transfer sin estar en espera (lo tiró a la calle o a un contenedor de la calle, o el
    servidor se lo dejó a los pies fuera de una casa: las monedas de una venta a un NPC,
    una fabricación o una recompensa que no entró) estaría entonces en esa fila y en la
    de quien lo levantó y se guardó: duplicado. Por eso cuando algo suyo llega al suelo
    público (`MoveItem` de algo que carga; `holdGround` fuera de una casa, también
    estando en espera) queda marcado (`gaveAway`) y el loop toma su snapshot **al final de
    ese comando** (`Input`), o del tick si lo soltó el servidor fuera de un comando (una
    recompensa de quest por una muerte de monstruo): `settleGivers`, en memoria
    (`Player.pre`). Ahí su estado está entero: las demás acciones del diálogo, el paso de
    quest que completa al llegar al nodo siguiente, las demás pilas del mismo regalo (si
    se tomara cuando cae la primera pila, un marcado podría volver a un estado con la
    quest sin terminar y cobrar dos veces la misma recompensa). Lo que soltó un comando
    que no es un `Input` (la recompensa del tutorial en un `Join`) y sigue pendiente se
    asienta también **al principio** del próximo `Input` (`playerCommand`), antes de que
    ese comando cambie una casa: así ese snapshot nunca lleva lo que el comando saca de
    una casa. Su **próximo transfer** lo encola primero (`transferSnapshot`, delante del
    trabajo del transfer): el Saver lo escribe antes, así un transfer descartado o
    saltado no lo devuelve a un guardado anterior a lo que dio. Lo que garantiza eso es el
    asentamiento del principio de cada comando del jugador (asienta a todos los que
    soltaron algo, no solo al que manda el comando) y el de `transferSnapshot`; el del
    final del comando y el del final del tick solo lo toman antes, así es el estado justo
    después de lo que dio (lo fija `TestSaveBeforeTransferIsFromTheGiftsCommandOrTick`).
    - Si el transfer se descarta o se salta (también el intercambio de un compañero
      marcado, por el punto fijo), el personaje vuelve a ese estado: sin lo que dio y sin
      el transfer. Si ya estaba marcado de antes, ese snapshot se salta como cualquier
      otro trabajo suyo (la espera no lo dejó soltar nada desde entonces).
    - Una sola vez: cualquier snapshot posterior del personaje (un autoguardado, el final
      al salir o al apagar, el de su muerte, el de un transfer) lo reemplaza, porque ya
      entra en la cola detrás de lo que dio. Un relogueo, el link-dead y el reinicio no
      cambian nada: el snapshot final lo reemplaza y el login nuevo arranca sin él.
    - Se numera al tomarlo, no al encolarlo: su acuse vale solo por lo anterior. No
      termina la espera del transfer que va detrás ni libera lo que sacó de una casa a la
      calle: esa reserva (`leftHouse`) toma el `Seq` del snapshot del personaje en la
      escritura de la casa misma (`numberLeft`, en `transferSnapshot`), no el del próximo
      snapshot, así que sigue hasta el acuse de esa escritura aunque el guardado de antes
      se numere entre el movimiento y la escritura.
    - Ningún transfer deja nada en el suelo público en su propio comando: comprueba antes
      que todo entra (`canBuy`, `canReceive`, `moneyThatFits`). Si lo hiciera, el
      snapshot (que `transferSnapshot` tomaría en el acto) llevaría medio transfer y se
      escribiría fuera de su transacción. `transferSnapshot` registra con nivel error un
      transfer que encuentra algo soltado sin asentar fuera de la escritura de una casa
      (solo los comandos del jugador hacen transfers de jugadores, y cada uno asienta antes
      a todos).
    - Un mismo comando **sí** puede soltar algo a la calle y cambiar una casa: el dueño,
      parado en la calle, usa una runa que dejó en el suelo de su casa; el monstruo muere,
      la recompensa de la quest no entra y cae a sus pies; después la runa pierde la carga
      en el suelo de la casa. Un snapshot de lo que dio saldría con la escritura de la casa
      y se escribiría aparte, antes: si esa escritura se descarta, el dueño vuelve a ese
      snapshot (con la muerte hecha) y la casa a su última escritura (con la carga): una
      carga gratis; y algo sacado de la casa a la mochila quedaría en dos filas. Por eso
      ahí no se guarda ese snapshot: lo que soltó a la calle queda **reservado** al
      personaje como lo que sale de una casa (`reserveGiven`, con el `Seq` de su snapshot
      en esa escritura, `numberLeft`). Si la escritura se descarta, vuelve a su guardado de
      antes del comando y la reserva no se libera nunca (nadie más lo levanta). Solo si lo
      soltó en algo que no se le puede reservar (una pila o bolsa ajena de la calle, y eso
      solo lo hace un `MoveItem`, que no cambia una casa salvo por la recompensa del
      tutorial) se toma el snapshot como antes y `settleGave` lo registra con nivel error.
    - En el suelo de una casa no hace falta: lo que se deja ahí se escribe con el
      snapshot de quien lo movió (`flushHouses`, un transfer que también encola antes el
      snapshot pendiente de ese personaje).
    - Costo: una escritura más solo en el primer transfer de un personaje después de
      soltar algo al suelo público, y un snapshot en memoria por comando (o tick) en que
      soltó algo, no por pila (docs/07).
    - **Límite: una caída no es un transfer.** Con la base caída al apagar, el apagado es
      una caída (ver arriba): ese snapshot falla con el transfer de atrás (el Saver lo
      abandona y después marca al personaje por el transfer). Tampoco cubre que la base
      rechace ese snapshot mismo (`ErrPermanent` en un guardado no marca a nadie). Como en
      cualquier caída, lo que alguien tiró a la calle y otro levantó puede quedar en las
      dos filas si el guardado de quien lo levantó entró y el de quien lo tiró no: es el
      límite general de guardar por personaje con el suelo en memoria (docs/14).
- Una oferta de un item retirado de `data/` se cierra al arrancar (un transfer: borrar la
  oferta y, si era de compra, devolver el oro al buzón).
- **Presupuesto de escritura:** cada transfer escribe a sus personajes enteros (como un
  autoguardado), más el guardado de antes de quien soltó algo al suelo público desde su
  último snapshot (como mucho uno por personaje y transfer); por eso el intercambio no se
  confirma vacío y tiene anti-flood, y el mercado también (docs/07).
- La otra parte de una operación del mercado no necesita snapshot: lo que recibe va a su
  buzón, que es una fila del mercado. Por eso funciona aunque esté desconectada.

**Ofertas en memoria, como los gremios.** `app` carga el mercado entero antes de arrancar
el loop (`LoadMarket`: ofertas, buzones, marcas de ids, historial reciente por personaje,
ventas de los últimos días para el precio de referencia y suspensiones vigentes de los
dueños de ofertas) y el loop es su único dueño: buscar, aceptar o cancelar nunca toca la
base. Elegimos esto y no una reserva asíncrona en la base porque (1) dos compradores de la
última unidad son dos comandos en orden en el mismo loop: el primero la lleva y el
segundo ve la oferta agotada, sin estados intermedios ni locks; (2) aceptar es inmediato
y en el mismo tick que el pago, como el intercambio; (3) el tamaño está acotado
(`max_offers` por personaje). La red de seguridad está en la base: llenar más unidades de
las que quedan (`FillMarketOffer` exige `amount > units`, o borra exactamente las últimas)
falla toda la transacción, así que dos escrituras de la misma unidad nunca confirman las
dos (probado con dos transacciones concurrentes en `store`). Los ids de ofertas y del buzón
los asigna el loop (el siguiente al mayor emitido, `market_id_high`), así un id no se
reusa tras reiniciar.

**Costo en el tick.** Cada acción toca una oferta, un libro (búsqueda binaria en una lista
ordenada por precio) y un buzón; listar recorre a lo sumo `list_size` ofertas visibles por
lado. El vencimiento barre una vez por segundo la lista ordenada por vencimiento, como
mucho 64 por barrido. Los intercambios abiertos se revisan cada tick (pocos, con a lo sumo
`max_items` por lado).

**Ventanas en vivo.** El loop sabe quién mira cada libro: `World.mkWatch` (item → ventanas
abiertas que lo muestran), que se mantiene al buscar, abrir, cerrar, alejarse o salir del
mundo. Una acción que cambia un libro encola a sus espectadores (`bookChanged`); una que
cambia las ofertas propias o el buzón de alguien, a ese jugador si tiene la ventana
abierta (`marketOwnerChanged`; también el alquiler, el traspaso o la liberación de una
casa); una suspensión, a los espectadores de los libros donde esa cuenta tiene ofertas
(`marketAccountChanged` junta esos items de las listas de ofertas por personaje, sin
recorrer libros); un intercambio completo, a los dos; el paso a solo lectura, a todas
(una vez: otra marca después no reenvía nada). `flushMarket` (en `flushSystem`, una vez
por tick) manda a cada ventana encolada una `MarketUpdate` completa con `refresh: true`,
como mucho una cada `market.push_every_ms` de `balance.yaml` (500 ms; la que cae antes
espera, no se pierde). La respuesta a un comando propio también deja la ventana al día y
descarta el refresco pendiente. Nada de esto toca la base: todo sale de lo que el loop ya
tiene en memoria. Costo: encolar es recorrer los espectadores del libro (o uno); mandar
cuesta lo que una respuesta normal (`list_size` por lado, ofertas propias, buzón e
historial: la ventana entera, no un delta), y como mucho una por `push_every_ms` por
ventana abierta.

## Autenticación y cuentas
- Email + contraseña (argon2id), verificación de email, reset de contraseña.
- Emails de la cuenta (T2.1, `server/internal/mail`): `auth` arma el mensaje (plantillas de
  `i18n/<idioma>/email.yaml`, texto plano + HTML escapado con `html/template`) y lo pone en
  una cola acotada; una goroutine propia lo manda por SMTP (STARTTLS obligatorio, o TLS
  implícito) con reintentos. Nunca corre en el game loop ni bloquea un handler. Sin SMTP
  configurado todo queda apagado y se comporta como antes.
- Los enlaces llevan un token aleatorio de 256 bits **en el fragmento** (`/verify#token=…`,
  `/reset-password#token=…`): el navegador no lo manda a ningún servidor, así que no queda
  en logs; la página del sitio lo canjea con un `POST`. En la base (`account_tokens`) va
  solo su SHA-256, un uso, vencimiento (24 h verificar, 1 h reset) y un enlace nuevo anula
  los anteriores del mismo tipo. La búsqueda es por el hash: nunca se compara el secreto.
- Reset de contraseña: en una transacción cambia el hash, borra los otros enlaces de reset,
  revoca **todas** las sesiones (cuenta y juego) y escribe `audit_log` (`password_reset`,
  fuente `web`). Verificar escribe `email_verified`. Sin SMTP, el operador genera un enlace
  con `gameserver admin reset-link` (auditado como `reset_link_issued`, el enlace no se
  registra).
- OAuth 2.0 con Google y Discord vinculados a la misma cuenta (T2.1, `server/internal/oauth`
  + `auth/oauth.go` + `httpapi/oauth.go`): Authorization Code con PKCE S256, `state` de un
  solo uso atado a una cookie corta del navegador que empezó, y en Google OpenID Connect
  con `nonce` y el `id_token` verificado contra sus JWKS (firma RS256, `iss`, `aud`, `exp`).
  La cache de JWKS nunca tiene el lock tomado durante el pedido HTTP: un solo pedido en
  vuelo a la vez (con su propio timeout de 10 s: cancelar el login que lo empezó no lo
  corta), los que buscan un `kid` desconocido esperan ese mismo, y una clave ya
  conocida se sigue usando mientras tanto.
  Discord se valida con `GET /users/@me`. Las identidades viven en `account_identities`
  (proveedor + id del sujeto + email informado). Un login por OAuth emite la misma sesión y
  cookie que el de contraseña. Nunca se vincula una identidad a una cuenta existente solo
  porque el email coincide (ver docs/02, "Cuentas"). Vincular y desvincular va a
  `audit_log` (fuente `web`, solo el proveedor: nunca el email).
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
| `antibot_suspects{level}` | gauge | T4.1 | personajes seguidos por la detección de bots (conectados o no) en cada nivel de respuesta: `log`, `notify`, `presence`, `suspend`. Se recuenta una vez por ronda de evaluación |
| `antibot_presence_checks_total{result}` | contador | T4.1 | chequeos de presencia: `sent`, `passed` (respuesta correcta), `failed` (equivocada), `expired` (sin respuesta a tiempo). Incluye los aleatorios y los pedidos por un GM |
| `antibot_suspensions_total` | contador | T4.1 | suspensiones automáticas de la detección de bots |
| `process_*`, `go_*` | estándar | T1.17 | CPU, RSS, goroutines, GC |

Las etiquetas son conjuntos fijos: patrones de rutas del `ServeMux` (nunca la URL), códigos
HTTP, escritores, resultados y niveles. Ninguna lleva datos del jugador (nombre, cuenta, IP).
Las de la detección de bots salen de `antibot.Stats` (atomics que el loop escribe a costo
constante y el handler de `/metrics` lee al hacer scrape); el puntaje de cada personaje
sigue solo en la base y en `/reports`.

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
| `PersistenceBacklog` | warning | `persistence_backlog` > 1000 durante 5 min: la base escribe más lento de lo que el juego produce guardados (T5.3, docs/07) |
| `PersistenceDataLost` | critical | cualquier escritura `rejected`, `abandoned` o `skipped` (T5.3) en 15 min (`abandoned` es best effort, ver abajo) |
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

## Pagos y tienda cosmética (T5.7)
La monetización es solo cosmética (`00-vision.md`): la moneda premium se compra con
dinero real, se gasta en cosméticos y nada más. Piezas:

- `internal/payments`: la interfaz `Provider` (`CreateCheckout`, `ParseWebhook`) con dos
  implementaciones. `Fake` (tests, e2e y desarrollo) no tiene red: su "checkout" es una
  ruta del propio servidor (`POST /api/shop/fake-checkout/<sesión>`, solo con la sesión de
  la cuenta que lo inició; el sitio la postea y vuelve a `/shop?checkout=success`) que paga
  mandándose un webhook firmado con HMAC; **se niega a arrancar si `RPG_ENV` no es
  `development` o `test`** (vacío = producción). Nunca se usa en un servidor que alcance
  otra gente (tampoco el de casa con túneles): regala moneda premium.
  `MercadoPago` es Checkout Pro en modo prueba: crea una preferencia
  (`POST /checkout/preferences`, `X-Idempotency-Key`) con `external_reference` firmada
  (cuenta + paquete + nonce, HMAC con `PAYMENTS_REF_SECRET`, un secreto nuestro aparte del
  del webhook: rotar el secreto del webhook en el panel no invalida los checkouts ya
  pagados; `PAYMENTS_REF_SECRET_PREVIOUS` sigue verificando mientras se rota el propio),
  `notification_url` y `back_urls` (con `RPG_ENV=production`, `PUBLIC_URL` tiene que ser
  https); el título del ítem es `cosmetic_pack.<id>.name` de `i18n/<idioma>/cosmetics.yaml`
  en el idioma del sitio (español si no hay). El jugador paga en la página de Mercado Pago
  (el servidor nunca ve datos de tarjeta). Todo el HTTP pasa por un `*http.Client`
  inyectable.
- Webhook (`POST /api/payments/webhook/<proveedor>`): Mercado Pago firma `x-signature`
  (`ts=…,v1=…`) sobre `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` con HMAC-SHA256;
  se compara en tiempo constante y se rechaza un `ts` de más de 10 minutos
  (`payments.MaxWebhookAge`). Después se lee el pago con `MP_ACCESS_TOKEN`
  (`GET /v1/payments/<id>`) y solo cuenta ese estado: `approved` = pagado (con
  `transaction_amount_refunded > 0`, reembolso parcial), `refunded`, `charged_back` =
  contracargo, `in_mediation` = disputa; el resto se ignora. Un 404 o 400 de esa lectura
  se ignora con un warning (reintentar no lo arregla: se contesta 200); cualquier otra
  respuesta (5xx, 429, y también 401/403, que indican un access token mal configurado o
  revocado) o la red caída contestan 502 con un log de nivel error para que Mercado Pago
  reintente: un error de configuración nunca descarta pagos. El monto y la moneda tienen
  que ser los del paquete en `data/cosmetics.yaml`; la moneda premium que vale un paquete
  la decide el servidor, nunca el proveedor.
- Pagos que no se pueden acreditar: un pago `approved` con referencia que no verifica,
  moneda desconocida, paquete que ya no existe, monto distinto del precio o cuenta borrada
  se registra con nivel error (con el id del pago) y se guarda en `payment_events` con
  `result = 'unmatched'` y el motivo en `note` (`bad_reference`, `unknown_currency`,
  `unknown_pack`, `amount_mismatch`, `account_gone`; id de evento `<pago>:unmatched` para
  los dos primeros, el del propio evento para el resto). Solo se exige el paquete donde se
  acreditaría: un reembolso o contracargo siempre llega al store y descuenta lo que el
  ledger dice que se acreditó, aunque el paquete haya salido del catálogo o cambiado de
  precio. El staff los
  concilia a mano (`SELECT … WHERE result = 'unmatched'`, índice parcial) y acredita con
  `/premium` si corresponde. Nunca se descarta dinero real en silencio.
- Idempotencia: el id de evento es `<id del pago>:<estado>` (un reembolso parcial agrega
  el total reembolsado: `<pago>:refunded:<monto>`) y `payment_events` tiene
  `UNIQUE (provider, event_id)`; un webhook repetido no hace nada. Además un pago acredita
  una sola vez y sus reversiones nunca descuentan más de lo que acreditó (se suma en
  `premium_ledger`).
- Orden y carreras: `ApplyPayment` **bloquea primero la fila de la cuenta** (la cuenta va
  firmada en la referencia, así que todos los eventos de un pago tienen la misma), después
  inserta el evento y recién entonces lee el crédito y las reversiones del pago. Un pagado
  y un reembolso del mismo pago que llegan juntos corren uno después del otro. Si el
  reembolso o el contracargo llega **antes** que el pagado (o le gana la carrera), no se
  descarta: queda en `payment_events` como `pending_reversal`, y el crédito, cuando llega,
  se revierte en la misma transacción (el evento pasa a `debited`), venga ese crédito de un
  pagado o de un reembolso parcial. Elegimos esto y no
  "no consumir el id y devolver un error reintentable" porque no depende de que el
  proveedor reintente a tiempo (Mercado Pago deja de reintentar, y el pagado puede no
  volver a llegar nunca): el reembolso queda guardado y se aplica con el crédito.
- Saldo: `accounts.premium_balance` (nunca negativo). Todo cambio es **una transacción**
  que bloquea la fila de la cuenta (`SELECT … FOR UPDATE`), cambia el saldo y agrega su
  fila en `premium_ledger` (append-only con triggers, como `economy_log`): acreditar un
  paquete, comprar un cosmético (`account_cosmetics`), revertir un pago y los `/premium`
  del staff (estos además en `audit_log`). Dos compras simultáneas de una cuenta corren una
  después de la otra.
- Reembolso o contracargo: se descuenta lo que el pago acreditó (un reembolso parcial,
  `floor(crédito × reembolsado / monto)` en total, una vez por cada nuevo monto
  reembolsado; un reembolso parcial de un pago que nunca se acreditó acredita primero, porque
  el resto del pago sigue en pie). Una disputa (`in_mediation`) marca la cuenta y no
  descuenta nada; como su id es `<pago>:dispute`, una segunda mediación del mismo pago no
  vuelve a marcar la cuenta si el staff ya la limpió (raro; el staff revisa el pago en el
  panel). Si el saldo ya no alcanza, se descuenta lo que hay (queda en 0), la fila guarda el faltante (`shortfall`) y
  la cuenta queda marcada (`accounts.shop_flagged_at`): no puede iniciar pagos ni comprar
  hasta que el staff la limpie (`/premium Nombre +0 clear nota`). Lo ya comprado no se
  quita. Las cuentas deshabilitadas o baneadas tampoco compran.
- Límite: `limits.daily_premium` de `data/cosmetics.yaml` (5000) de moneda comprada por
  cuenta en 24 h; se revisa al iniciar el checkout, antes de pagar. Un pago que llega igual (dos checkouts
  pagados juntos) se acredita: el jugador ya pagó.
- El juego: el catálogo (`data/cosmetics.yaml`, `content.LoadCosmetics`) se sincroniza a
  la tabla `cosmetics` al arrancar (upsert; lo que sale del archivo queda `on_sale =
  false`). Lo que la cuenta tiene y su saldo se cargan con el login (`PlayCharacter`) y el
  loop no lee la base. Tras un cambio por HTTP, el `app` relee el estado de la cuenta en su
  propia goroutine y encola `World.CosmeticsChanged` (con el id de la última fila del
  ledger, para descartar una actualización vieja que llegue tarde; si la cuenta no está en
  línea, se guarda 2 minutos por si un login leyó la base justo antes). Lo equipado viaja
  en `Creature.cosmetics` y se guarda con el snapshot del personaje.
- Variables: `RPG_ENV`, `PAYMENTS_PROVIDER` (`fake` | `mercadopago`), `MP_ACCESS_TOKEN`,
  `MP_WEBHOOK_SECRET`, `PAYMENTS_REF_SECRET` (+ `PAYMENTS_REF_SECRET_PREVIOUS` al rotarlo),
  `PUBLIC_URL`, `PAYMENTS_FAKE_SECRET` (opcional; si falta, uno al azar por proceso). Paso a paso en `09-deployment-aws.md` ("Tienda y pagos").

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
  items de quest, bendiciones), `quest` (recompensas), `tutorial` (premio del tutorial, T4.2), `travel` (pasaje y ticket), `guild` (costo de fundar un gremio, T5.1),
  `gather` (pesca, minería, tala), `craft` (ingredientes y resultado), `death` (lo que cae
  en los restos al morir), `gm` (`/item`), `consume` (comida, pociones, la última carga
  de una runa, munición; también lo usado del suelo, a nombre de quien lo usó), `conjure`
  (hechizos que crean items) y `decay` (lo que quedaba en unos restos al pudrirse, a nombre
  del muerto si era un jugador). `trade` (ventana de
  intercambio, T5.3: lo que sale y entra de cada uno, con el otro personaje) y `market`
  (mercado, T5.3: depósitos al crear con ref `offer`, la comisión con ref `fee`,
  compras y ventas con ref `buy` / `sell` y el otro personaje, retiros del buzón con ref
  `mailbox`). `count` (unidades) y `amount`
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
