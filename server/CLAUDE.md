# server/ — servidor de juego en Go

Lee `docs/01-architecture.md` y `docs/07-performance-budget.md` antes de cambiar el game loop,
la red o la persistencia.

## Estructura
```
server/
  cmd/gameserver/      main: carga config, contenido, mapa compilado; arranca loop + HTTP + WS
  cmd/mapcompile/      compila world/ (JSON) a binario world.bin para carga rápida
  cmd/gameserver admin herramienta del operador: roles y log de auditoría (T2.6)
  internal/game/       game loop, tick, cola de comandos, scheduler de eventos
  internal/world/      tiles, pisos, sectores, islas, pathfinding (A* por casillas)
  internal/entity/     jugadores, monstruos, NPCs; IDs estables (uint32)
  internal/antibot/    señales de comportamiento y puntaje de sospecha (T4.1, puro)
  internal/combat/     daño y fórmulas (las condiciones viven en session/condition.go:
                       necesitan el scheduler, el AOI y los monstruos)
  internal/skills/     progreso de skills por uso, niveles, experiencia
  internal/ai/         (aún no existe: la IA de monstruos vive en session/monster.go porque
                       depende del índice de sectores y del AOI; separarla cuando crezca)
  internal/dialog/     motor de diálogos de NPC dirigido por YAML (puro: condiciones, costos)
  internal/quest/      estado de quests, flags (storage values) por personaje
                       (los NPCs en el mundo, tiendas y dinero viven en session/npc.go)
  internal/content/    carga y validación de data/*.yaml
  internal/net/        WebSocket, framing, (de)serialización protobuf, rate limits
  internal/session/    sesión de jugador: AOI, caminar, envío de deltas, ping, guardado
  internal/net/gateway/ WebSocket /ws: Hello, lector/escritor por conexión, rate limit
  internal/app/        ensambla loop + session + persistencia + gateway + API (main y tests);
                       admin.go: goroutine de auditoría y bans (T2.6)
  pkg/bot/             cliente sin UI para tests de integración y tools/bots (fuera de
                       internal/ para que otro módulo lo importe)
  internal/store/      PostgreSQL: repositorios generados con sqlc, migraciones goose
  internal/guild/      reglas puras de gremios: rangos, permisos y nombres (T5.1)
  internal/auth/       cuentas, contraseñas (argon2id), OAuth Google/Discord, tokens
  internal/httpapi/    API HTTP: login, lista de personajes, health; public.go: status y
                       ranking públicos con cache (T4.3)
  internal/mappatch/   chequeo de un map patch subido como entrada no confiable (T4.5, puro)
  internal/metrics/    métricas Prometheus (tick, red, proceso); /metrics en -metrics-addr
  internal/clock/      reloj inyectable (real y falso para tests)
  internal/sim/        harness de simulación determinista para tests
  migrations/          SQL de goose
  queries/             SQL de sqlc
```

## Reglas del servidor
- **Solo la goroutine del game loop muta el mundo.** Las goroutines de red envían
  `Command` por un canal con buffer y reciben `[]Event` ya serializables.
- Un panic dentro de un comando, evento o sistema se recupera en `game.Loop`, se registra
  con su stack y se descarta esa unidad; el tick sigue. No es licencia para usar `panic`.
- Todo lo temporal usa `clock.Clock` y el número de tick, nunca `time.Now()`.
- Aleatoriedad con un `*rand.Rand` sembrado e inyectado (deterministas en tests).
- Sin asignaciones en el hot path del tick cuando sea razonable: reutiliza slices,
  usa pools para buffers de red.
- El cliente nunca decide resultados: el servidor valida rango, línea de visión,
  cooldowns, capacidad, distancia de movimiento y velocidad.
- Rate limit por conexión (comandos por segundo) y desconexión ante abuso.
- Guardado de jugador: al salir y autoguardado escalonado cada 5 minutos fuera del tick
  (snapshot inmutable → goroutine de persistencia).
- Logs estructurados con `log/slog`. Métricas Prometheus en `/metrics` (solo interno).
- **Economía (T4.1):** todo camino que crea, destruye o saca de un personaje oro o items
  lo dice con `econItem`/`econGold` (fuente `Econ*` de `session/economy.go`), y lo que pasa
  entre un personaje y el suelo con `Player.ground`. Los tests de `session` reconcilian en
  cada tick: si te olvidas, falla `economy mismatch`.
- **Tutorial (T4.2):** `session/tutorial.go`. Un evento nuevo del tutorial necesita una
  constante `content.Trigger*`, su caso en `Tutorial.Check`, el enum del esquema y una
  llamada `w.tutorialEvent(p, evento, ref)` donde el evento ya ocurrió y fue validado.
  `tutorialEvent` cuesta una comparación para quien no está en el tutorial (`Player.tut`).
- **Sitio público (T4.3):** `GET /api/status` lee `session.World.PublishedOnline` (un
  `atomic` que el loop actualiza al entrar o salir un jugador) y `App.running`; nunca
  llames a métodos "Loop goroutine only" desde un handler. `GET /api/highscores` usa
  `queries/highscores.sql` vía `store.Highscores` (el `app` la conecta si el `Store` la
  implementa) con una cache de 60 s por filtros en `httpapi`. Ninguna query del ranking
  puede ordenar todos los personajes: cada una lee un índice y corta en la página (costos
  en docs/07); si cambias una, mírala con `EXPLAIN ANALYZE` sobre muchos personajes. Las
  exclusiones (staff, deshabilitadas, baneadas) viven en las queries: si agregas borrado
  de personajes, filtra ahí.
- **Portal de mapas (T4.5):** `httpapi/mapsubmit.go` + `store/mapsubmissions.go` +
  `mappatch`. El patch es entrada no confiable: `mappatch.Validate` sigue las reglas de
  `parsePatch` (rutas con el fixture compartido `packages/map-format/src/patch/testdata/
  paths.json`) y es más estricto donde Go y JS leerían distinto. Sus errores son códigos
  fijos, nunca texto del patch. El merge y las parcelas no se hacen en Go: los hace el
  check del PR (TS). El rol de moderación se lee en cada pedido y otra vez en la
  transacción de la decisión; toda acción va a `audit_log` con fuente `web`. La cola del
  worker es la tabla (contrato en la migración 00010 y en docs/04).

- **Emails de la cuenta (T2.1):** `internal/mail` (Mailer SMTP/log, `Queue` con su propia
  goroutine, plantillas de `i18n/<idioma>/email.yaml`) + `auth/email.go` + `httpapi/email.go`
  + `store/accounttokens.go`. Un token de enlace nunca va a un log, a una URL que vea el
  servidor ni a la base en claro (solo SHA-256). Sin `Config.Mail` todo se comporta como
  antes: cualquier chequeo nuevo de "email verificado" pasa por `Service.RequireVerified`.
  `forgot` contesta igual para cualquier email y trabaja en segundo plano: no agregues
  respuestas ni tiempos que dependan de la cuenta.

- **OAuth (T2.1 2/2):** `internal/oauth` (protocolo: URL con PKCE, canje del code, `id_token`
  de Google contra JWKS, `/users/@me` de Discord; `oauthtest` es el proveedor falso de los
  tests y de `cmd/fakeoauth`) + `auth/oauth.go` (reglas de cuentas) + `httpapi/oauth.go` +
  `store/oauth.go`. Nunca vincules una identidad por coincidencia de email; todo login
  emite la sesión con `Service.loginAccount`; toda ruta de vuelta pasa por
  `auth.SafeReturn`; el `redirect_uri` sale de `PUBLIC_URL`.

- **Límites de la API (lote 16, `httpapi/abuse.go`, docs/05 "Límites de la API"):** toda
  ruta con sesión pasa por `authed` (límite de búsquedas de token por cliente **antes** de
  `Authenticate`, plazo `httpDBTimeout`, límite por cuenta); una que busque un token sin
  `authed` usa `tokenLimited`. Un handler nuevo que calcule una contraseña va en
  `rateLimited(hashing(...))`; uno que cree filas por cuenta, en `accountLimited`. Los
  tokens se validan con `plausibleToken` antes de cualquier consulta (`auth`). Un log que
  un cliente pueda disparar a voluntad va por `sampledLog` (o `a.fail`, que ya muestrea).
  Una acción de cuenta sensible re-autentica como `StartLink`/`Unlink` (`Service.reauth`).

- **Gremios (T5.1):** `session/guild.go` + `guild` (puro) + `store/guilds.go` +
  `httpapi/guilds.go`. El loop es dueño de todos los gremios: `app` los carga una vez
  (`GuildStore.LoadGuilds`) antes de arrancar y cada cambio sale como `AdminJob{Kind:
  AdminGuild}` por `queueAdmin` (en orden, nunca se pierde); nada vuelve al loop. No leas
  gremios de la base desde el loop ni desde un handler del juego. Un cambio nuevo necesita
  su `GuildOp` en `session` y en `store` (mismos valores) y su caso en `applyGuild`. Todo
  comando de gremio pasa por `chatAllowed`. Si un jugador recibe o pierde un gremio,
  llama a `announceGuild` (el nombre bajo el personaje) y `queueGuildSend`. Lo que sale
  por `/api/guilds` es público: nunca el mensaje del día ni quién está en línea, y con las
  exclusiones del ranking (staff, deshabilitadas, baneadas) en `queries/guilds.sql`.

- **PvP (T5.2):** `session/pvp.go` (reglas, marcas, bloqueos, muertes) + `session/
  guildwar.go` + `content.PvP` (`balance.yaml pvp`; sin bloque o `enabled: false` = todo
  apagado, como antes). Todo daño de un jugador a otro pasa por `hurtPlayer` (que juzga la
  agresión con `aggress` y escala con `damage_pct`) y ningún camino nuevo puede saltarse
  `pvpPlace`/`canAttack`. El objetivo de un jugador es `Player.ptarget` (excluyente con
  `target`, que sigue siendo `*Monster`); `foe` une ambos en el combate. Las marcas usan
  `ctx.Now` (persisten en el snapshot) y los bloqueos ticks; `checkPvP` barre una vez por
  segundo solo `World.skulled` y las guerras abiertas. Las guerras son cambios de gremio
  (`GuildWar*` en `session` y `store`, mismos valores) y su id lo asigna el loop
  (`war_high`). Pegarle a jugadores no entrena ni alimenta `abHurt` (anti-bot). Una
  condición de un jugador pasa por `conditionMayHurt` (nunca empieza un ataque
  injustificado); su autor es un **personaje** (`condition.author`, por `byChar`, nunca el
  id de criatura) y se guarda con la condición junto con el recuerdo de su ataque
  (`ConditionState.Author*`, `recallHit` al entrar) y la hora del guardado
  (`ConditionState.SavedAt`, `World.nowTime`); un autor fuera del mundo no daña. Al
  entrar, una condición con autor descuenta sin daño el tiempo que su víctima estuvo fuera
  (`awayTicks` + `condition.elapse`; termina si esa hora no se puede ubicar en el reloj de
  este servidor; el recuerdo del ataque vuelve igual); una sin autor sigue congelada. Un
  hechizo de condición a distancia sobre un jugador pasa por `conditionPlayer`
  (`canAttack` + `aggress`, como un golpe). El bloqueo PvP es un caso del bloqueo de
  logout en combate (abajo). `kill_credit_ms <= lock_ms` lo valida el balance: quien cobra
  una muerte sigue en el mundo.

- **Bloqueo de logout en combate y link-dead (`session/linkdead.go`, docs/02 "Bloqueo de
  logout en combate"):** "en combate" es `inCombat` (`travel.combat_block_ms` desde
  `Player.fightAt`, que pone `markFight` al pegar, recibir daño o ser atacado por un
  monstruo, o el bloqueo PvP); un camino nuevo de daño o de ataque llama a `markFight`.
  `Logout` en combate se rechaza (`logoutBlock`: `pvp.logout_locked` o
  `combat.logout_locked`, con `seconds` de `logoutWaitSeconds`). Cada salida en combate
  tiene su test en `combat_exit_test.go` (tabla en docs/02). `Leave` en combate deja al jugador link-dead
  (`linkDeadOnLeave`, sin enviarle nada) hasta que `checkLinkDead` (cada tick, solo sobre
  `World.linkDead`) lo saca: cuando `holdsLinkDead` deja de valer (la pelea terminó o pasó
  `travel.link_dead_max_ms` desde `Player.linkDeadAt`; el bloqueo PvP no tiene tope). Un
  link-dead no entrena (`trainBy`) ni aporta al grupo (`contribute`): un camino nuevo que
  entrene o cuente aporte tiene que pasar por ellos. Un login nuevo lo retoma con `carryFight` (`fightAt` y
  `pvpCarry`). Un corte de la conexión que decide el servidor (cliente lento,
  `KickAccount`) pasa por `disconnect`, que en combate cierra la conexión una vez
  (`Player.dropped`) y lo deja link-dead; un camino nuevo que corte conexiones tiene que
  usarlo salvo que sea una sanción de staff o un guardado que falló. `Input` ignora a un
  link-dead y un `Leave` de un link-dead no cambia nada. El cliente ve el bloqueo como el
  estado `in_combat` (y el del atacante como `pvp_locked`; la zona de protección como
  `protection_zone`): `session/status.go` los lee del jugador en `sendConditions`, al final
  de cada tick, sin eventos ni nada guardado (`combatEnd` tiene que seguir a `inCombat`). La muerte termina la pelea
  (`wakeAtTemple` pone `fightAt` en 0) y guarda con `deathSave`: un link-dead sin bloqueo
  PvP no se guarda ahí, sino que sale al final del tick (`Player.diedLinkDead`,
  `checkLinkDead`) y ese es su único guardado. Nunca saques a un jugador del mundo
  (`remove`) desde un camino de daño: el sistema de combate puede estar recorriendo
  `World.players`. Un camino nuevo que guarde una muerte usa `deathSave`, no `save`. El
  `death.died` de una muerte link-dead (o el `pvp.arena_defeat` de una derrota en la arena,
  que nunca reemplaza al de una muerte) queda en `World.diedAway` (`diedLinkDeadNotice`) y
  lo recibe el próximo login (`tellDiedAway` en `join`); una entrada por personaje hasta
  que vuelva o se reinicie el servidor (aceptado así: acotado por los personajes).

- **Mercado e intercambio (T5.3):** `session/trade.go` + `session/market.go` +
  `store/market.go` + `app/market.go` (`balance.yaml trade` / `market`; sin bloque, o sin
  `Config.Transfer`, apagados). Todo lo que mueve items u oro entre personajes o con el
  mercado termina en `w.transfer(jugadores, ops...)`: un `Transfer` con los snapshots de
  los jugadores en línea cuyo inventario cambió y los `MarketOp`, por la misma cola que los
  guardados (`submitJob`; nunca llames `cfg.Save` directo). `store.SaveTransfer` lo escribe
  en una transacción. Un `MarketOp` nuevo necesita su valor en `session` y en `store`
  (mismos números) y su caso en `applyMarketOp`. El loop tiene todo el mercado en memoria:
  no leas ofertas de la base en el loop. Toda acción del mercado pasa por `atMarket` y
  `marketFlood`; todo lo que entra o sale de un personaje se registra con
  `econItemWith`/`econGoldWith` (fuente `EconMarket` / `EconTrade`). El staff no comercia.
  Un transfer que no se guarda **marca** a sus personajes en el Saver (punto fijo: lo que
  los toque después no se escribe, tampoco en `WritePending` del apagado) y avisa al loop
  (`World.Tainted`): los saca, rechaza su login y deja el mercado y el intercambio en solo
  lectura (`w.readOnly`) hasta reiniciar. Toda acción nueva que escriba un transfer tiene
  que respetar `w.readOnly`. Los ids de transfer crecen entre reinicios (`transfer_high`)
  y `SaveTransfer` los reclama: un reintento de uno ya confirmado no aplica nada. Cerrar
  una oferta lleva sus unidades (`MarketOfferRemove.Units`, baja con guarda). Un transfer
  que falla al apagar abandona todo lo de atrás (semántica de caída). `persistence_backlog`
  mide la cola del Saver más `World.PendingJobs`. Todo snapshot de un transfer sale por
  `transferSnapshot` (deja al personaje en espera hasta `World.Saved`, `session/hold.go`,
  y encola antes el guardado de `gaveAway` que espera su ventana): un camino nuevo que
  lleve algo de un personaje al suelo público tiene que respetar `heldDrop` y, ya hecho,
  llamar a `gaveAway` con la pila o el contenedor de la calle donde cayó (marca al
  personaje; `settleGivers` toma su estado al principio y al final de cada comando del
  jugador, `playerCommand`, y al final del tick, lo encola en el acto o al final de su
  ventana de 2 s, y lo soltado queda reservado a él hasta el acuse, lote 16: ni un
  transfer descartado ni una caída lo dejan en dos filas; `holdGround` ya lo llama). Un comando nuevo del jugador que pueda
  cambiar una casa corre por `playerCommand`, como `Input`. Ningún transfer puede dejar
  nada en el suelo público en su propio comando (comprueba antes que todo entra:
  `canBuy`, `canReceive`, `moneyThatFits`; `transferSnapshot` lo registra con nivel
  error). Si un mismo comando suelta algo a la calle y cambia una casa (una runa del suelo
  de la casa usada desde la calle que mata a un monstruo de quest; lo juega con la runa
  real `TestHouseRuneKillsAQuestMonsterFromTheStreet`), lo que soltó queda
  reservado con el `Seq` de la escritura de la casa (`reserveGiven`, como `leftHouse`) y
  no se guarda snapshot aparte; registra (nivel error) solo lo que no se puede reservar
  (una pila o bolsa no reservada a él). `gaveAway` recibe dónde cayó: la pila nueva o
  la pila o contenedor ya reservado a él (`heldFor`), o nil si no se le puede reservar. Uno
  que saque algo del suelo de una casa al suelo público llama a `leftHouse` (la reserva toma el `Seq` del
  snapshot del que lo movió en la escritura de la casa, `numberLeft`) y solo lo deja
  como pila propia o en una pila o contenedor ya reservado a él (`heldFor`; nunca en algo
  ajeno, que la reserva se quedaría), uno en que el servidor le deje algo a sus pies
  llama a `holdGround`, uno que tome o use algo del suelo (o meta algo en un contenedor
  del suelo) mira `groundHeld` y `reserved` (cadáveres), y uno que reemplace los items
  de una casa va como `HouseItems` (el Saver marca la casa si se descarta). Cada reserva
  de `heldGround` guarda el `Seq` que la cubre y la libera el acuse de ese `Seq` o mayor
  (`confirmed`), no el fin de la espera. Los `Seq` de los snapshots son del `World`
  (crecen entre sesiones del personaje): no los reinicies por jugador; un acuse vale por
  todos los anteriores de su personaje (el `app` reintenta solo el más alto,
  `app/acks.go`). Una acción que
  cambie lo que muestra la ventana del mercado de otro llama a `bookChanged` /
  `marketOwnerChanged` / `queueMarket` (refresco en vivo, `flushMarket`, como mucho uno
  por ventana cada `market.push_every_ms`).

- **Baúl de la cuenta (`session/stash.go`, `store/stash.go`, docs/01 "Baúl de la cuenta"):**
  una copia por cuenta en `World.stashes`, cargada con el primer login (`Character.Stash`) y
  soltada por `releaseStash` (nadie de la cuenta en el mundo, ningún login leyendo,
  `loadingAcc`, y la última escritura confirmada, `stashPend`). Todo movimiento sale por
  `stashWrite` (transfer con `transferSnapshot` + `StashOp`, casas vaciadas antes de
  numerar) y respeta `w.readOnly`; el Saver marca el baúl de un transfer descartado
  (`taintedStashes`). Lo que entra o sale de un personaje se registra con `EconStash`.

- **Casas (T5.4):** `session/house.go` + `store/houses.go` + `app/houses.go` +
  `httpapi/houses.go` (`balance.yaml houses`; necesita el mercado). Las casas son datos del
  mapa (`world.House`, en `world.bin` desde la v4; `Map.HouseAt` y el bit `FlagHouse`, que `NewMap`
  pone con `FlagProtection`). El loop es dueño de dueños, invitados e items de las casas
  (cargados con `LoadHouses`). Todo cambio es un `Transfer` con `HouseOp` (mismos números en
  `session` y `store`, caso en `applyHouseOp`). Los items del suelo de una casa: cualquier
  camino que cambie una casilla tiene que pasar por `tileChanged` (o `containerChanged`
  para un contenedor en el suelo), que marca la casa sucia; `flushHouses` la escribe
  entera, con los snapshots de los jugadores cuyos comandos la tocaron
  (`World.cmdPlayer`, puesto en `Input`), al final de cada comando, al principio de
  `transfer`/`houseTransfer` (**antes de numerar**) y de `snapshot`, y al final del tick
  (también después de `questRecheck`).
  Todo sitio nuevo que numere un transfer tiene que vaciar las casas antes de
  `nextTransfer++`: `SaveTransfer` rechaza un id menor que el último escrito
  (`ErrTransferOrder`). Un movimiento de items desde o hacia una casa pasa por
  `checkHouseMove` (acceso, solo el dueño saca, límite, anti-flood, `w.readOnly`) y un
  uso por `mayUseInHouse`; un paso por `mayEnter`. Quien pierde el acceso sale por
  `expel`/`expelIntruders`. Al liberar una casa, `mailHouseItems` manda los items
  aplanados (`mailFlat`) al buzón del mercado en el mismo transfer. `/api/houses` es público: solo el
  nombre del dueño, con las exclusiones del ranking (`queries/houses.sql`).

- **Restos (`Mods.RemainsOf`, `BodyOf`, `Facing`, `BodySex`; docs/05 "Restos", docs/17 "Un
  cadáver por dirección"):** quien crea restos (`combat.go` para un monstruo, `death.go`
  para un jugador) marca el item con de quién son, hacia dónde miraba la criatura al morir
  (`fallFacing(dir)`: norte, este, sur u oeste, una diagonal al este o al oeste) y, en el
  cuerpo de un jugador, su sexo (`p.look.Sex`). Son del `Item`, así que viajan en todo
  `ItemStack` de los restos (`Mods.msg`) y unos restos arrastrados (`dragCorpse`) los
  conservan. No se guardan (los restos no se guardan). Un camino nuevo que deje restos de
  una criatura tiene que poner `Facing`; sin él, el cliente los dibuja caídos al sur.
  Tests: `session/corpse_facing_test.go`.

- **Atributos de items (`session/attributes.go`, `content/attributes.go`, docs/02
  "Atributos de items"):** cada instancia lleva `Item.mods` (atributo, valor, refinado). Todo
  camino que **crea** un equipable lo hace con `w.created` o `giveItem` (tira el atributo
  con `World.rng`, el `Config.Rand` del loop; nunca `newItem` para algo que la gente
  lleva); uno que lo **recrea** desde lo guardado o desde una oferta usa `w.instance(def,
  count, mods)` o `giveMods` (conserva los `mods`; uno sin atributo tira el suyo). Un camino
  que **mueve** una instancia la mueve entera (nunca la copia) y, si la registra en la
  economía, con `econInstance` / `econMade` / `econTaken` (una fila por instancia con sus
  `mods`). Uno que se **lleva** un equipable sin que el jugador elija cuál (NPC, `take_item`,
  receta) cuenta con `countItem` y pasa por `takeItem`, que ordena con `spareFirst` (la
  tirada más floja de los contenedores primero, lo puesto al final); los dos usan
  `spareable`, que nunca toma una pieza refinada (sale solo por el selector del mercado, el
  intercambio o el suelo). Los `mods` que vienen de la base pasan por `app.sessionMods`,
  que acota el refinado a `0..content.MaxRefineLevel` y el valor a
  `0..content.MaxAttributeValue`. En el listado del mercado, las ventas de un equipable
  suman la más barata de cada clase de pieza (atributo y refinado, `listing`). Un `ItemState` nuevo lleva `Mods`, y un formato guardado nuevo de items los
  guarda (`store.ItemMods`). Una fórmula nueva que deba sumar un atributo puesto lee
  `Player.gear` (lo recalcula `equipmentChanged` → `applyGear`, solo si cambiaron las
  instancias puestas con atributo, `Player.gearFrom`: un camino que cambie los `mods` de una
  pieza puesta sin moverla, como la forja, limpia `gearFrom` y llama a `equipmentChanged`; una
  pieza ofrecida en un intercambio cuyos `mods` cambian sale sola de la oferta, `checkTrade`); un efecto nuevo necesita su
  `content.Effect*`, su caso en `wornGear` y en el esquema `attributes.schema.json`.

- **Pasos `reach` y diario de misiones (`session/questlog.go`, `quest`, docs/06 "Quest",
  docs/05 "Diario de misiones"):** `initReach` resuelve al arrancar el lugar de cada paso
  `reach` (una zona de `world.bin` v7, `Map.Zone`, o un punto en una isla, `Map.IslandAt`;
  si no, no arranca; tampoco si el lugar no tiene una casilla caminable que no sea entrada
  de escalera, agujero o teletransporte, `standable`) y después corre
  `content.CheckRepeatable` con el mapa (`reachNear`: una tarea repetible no puede empezar
  con un `reach` a `TalkRange` de quien la da; las reglas sin mapa ya las corrió
  `CheckRefs`). Cada jugador guarda los lugares de sus pasos
  `reach` actuales (`Player.reach`) y un bit por piso (`reachFloors`); `move`, `relocate` y
  `join` llaman a `checkReach`, que con el piso fuera de la máscara no hace nada (`move`
  no lo llama con `through`: el `relocate` que sigue mira donde cae). Un camino nuevo que cambie
  la casilla de un jugador sin pasar por `move` ni `relocate` tiene que llamar a
  `checkReach`. Todo cambio de una quest pasa por el motor con un `questHost` y emite un
  evento (también `SetStep`, con `StepSet`, aunque el paso no se cumpla): su `Notify`
  marca `questsChanged` (los lugares se releen en el próximo `checkReach` y el `QuestLog`
  sale en el `flushQuestLog` del tick, uno por tick; también el del login: `join` solo
  marca `questLogDirty`). Las tareas repetibles guardan
  `quest.<id>.done_at` con `questHost.Now` (`World.nowUnix`, el reloj del loop); nunca
  `time.Now()`. Los tests de `session` con el mapa de 64x64 dejan los pasos `reach` de
  `data/` en una esquina (`parkReachSteps`); los que usan el mapa real piden `realQuests`.

- **Forja (`session/refine.go`, `content/forge.go`, `balance.yaml forge`, docs/02 "Forja"):**
  `Refine` hace todos los chequeos antes de tocar nada (yunque a 1 casilla, la pieza del
  jugador en un slot o un contenedor abierto con todos los `mods` que vio el cliente, no ofrecida en
  el intercambio, piedras, ámbar, oro y su vuelto, el ritmo de los oficios `nextGather`),
  después gasta todo junto, tira con `ctx.Rand` y sube, baja o rompe la pieza en el mismo
  comando, y guarda el personaje (`w.save`) si el intento podía fallar (los niveles seguros
  esperan el guardado periódico). Una pieza en un contenedor que no lleva se rechaza con
  `refine.not_carried`. La skill del bono es dato (`forge.smithing_bonus.skill`, revisada
  contra `skills.base` en `initForge`). "Mirar" suma lo del nivel con `refinedStat`. Un cambio de nivel en el lugar pasa por
  `setRefine` (registra la instancia que sale con sus `mods` viejos y la que entra con los
  nuevos, avisa al lugar que la tiene y, si está puesta, limpia `gearFrom` y llama a
  `equipmentChanged`); una pieza rota, por `econInstance(-1)` + `removeItem`. Lo que suma un
  nivel lo calcula `refineGain` dentro de `wornGear` (ataque solo en la mano derecha, defensa
  en la izquierda, armadura en cualquier slot de armadura, una joya una parte de su
  atributo antes del tope). La fuente del log es `EconForge` (no cuenta como ganancia en
  `earns`). Un material nuevo de la forja va en `balance.yaml forge` (validado por
  `Forge.CheckItems` al arrancar y por `checkForge` de `make validate`); el yunque cuenta
  esos materiales en su `StationOpen` y manda `money`.

- **Bolsillos** (`session/pockets.go`, docs/02 "Bolsillos", lote 13): `Player.pockets` es un
  `*Item` contenedor con `owner` p (slot 0) y una definición sin id (`World.pocketsDef`,
  `inventory.pocket_slots` celdas), fuera de `p.equip`. Nunca se separa ni lo alcanza un
  cliente (`itemAt` solo da lo que hay en una celda, `ItemLocation.pocket`); lo que lleva es
  "un item en un contenedor que p carga". Todo camino que **busque o cuente** lo que lleva
  un jugador pasa por `eachCarried` (que los recorre al final), `carried`, `held` o
  `keyFor`, nunca por `p.equip` solo; uno que **dé** algo usa `giveItem`/`giveMods` o, si
  lo pone a mano, `packWithRoom`/`packStack` (la mochila primero, después los bolsillos), y
  sus chequeos de lugar `room`, `freeCells` y `mergeRoom` (nunca `len(bp.items)`). Un cambio
  en ellos llama a `containerChanged` (manda el `Inventory`, no un `ContainerUpdate`). Se
  guardan como `ItemState.Pocket` (filas `inventory_items.pocket`, migración 00020). La
  muerte los vacía en el cuerpo con la tirada de la mochila (`dieBy`), y el cuerpo de un
  jugador entra todo lo que cae (`playerCorpse`: nada suelto en la casilla, fuera de la
  reserva del dueño). Un camino que meta algo en ellos por su cuenta pasa por
  `nestRefusal` (profundidad) como cualquier contenedor.
- **Cofres de recompensa** (`session/chest.go`, `content/chests.go`, docs/02 "Libros y
  cofres"): `useChest` va en la cadena de `useItem` antes de `useStation` (como el tablero
  del mercado). Da todo o nada (`roomForAll`: peso y lugar de la mochila y los bolsillos contando las pilas
  que se suman) y lo marca en el storage (`content.ChestKey`) en el mismo comando que los
  items, así cualquier snapshot tiene los dos o ninguno. Lo que da pasa por `giveItem` (un
  equipable tira su atributo) y `econMade` con `EconChest`. `content.CheckChests` corre al
  cargar los items y otra vez en `initChests` con la protección de la forja: un cofre
  nunca da el ámbar. El `id` de un cofre es la clave guardada: `data/ids.lock.yaml`
  (`chests`) lo fija con su item y `make validate` rechaza renombrarlo o reutilizarlo;
  `mapcli validate` exige cada cofre una vez en el mundo y alcanzable. El bloque `book` de
  un item es solo del cliente.
- **Quests de hito** (`session/sigil.go`, `quest/milestone.go`, docs/02 "Quests de hito"):
  `initSigils` resuelve al arrancar las placas de cada paso `sigils` (items `sigil` en su
  cuadrado, contra `requires`) y su destino; `World.sigilAt` (casilla → sala) es lo único
  que se mira por paso. `move`, `relocate` y `join` llaman a `sigilStep` (marca la sala si
  el jugador quedó sobre una placa; un camino nuevo que cambie la casilla de un jugador
  sin pasar por ellos también), `questRecheck` llama a `sigilRecheck` (la vuelve a marcar
  si cambió lo que cumple quien está parado encima, `Player.sigilMet`), `move` rechaza el
  paso a una placa de quien no tiene la quest en ese paso (`sigilRefuses`, salvo el staff)
  y `checkSigils`, en `flushSystem`, evalúa solo las salas marcadas: `quest.Cooperative`
  decide (vivo, conectado, no staff, la quest en el paso, la vocación, el nivel, el
  equipo). Todos se mueven juntos o ninguno: las casillas se buscan
  antes con `searchRings` (área, sin casas ni portales, `arrivalRadius`) y el bloqueo PvP
  de `portalArrival`; después `relocate` y `CompleteSigils` por cada uno. El diario manda
  los hitos sin empezar (`OPEN`) con `milestoneInfo`, y `questRecheck` lo marca sucio si
  cambia la huella de sus marcas (`milestoneMarks`). Los tests con `dataConfig` aparcan el
  paso `sigils` como un `reach` (`parkReachSteps`); el mapa real lo juega
  `TestMilestonesOnTheMap`.
- **Puertas con llave:** `session/door.go` + `content/doors.go` (`CheckDoors`). Una puerta
  es un par de items del mapa; abrir o cerrar es `Map.ReplaceItem` (el único cambio que
  acepta un `world.Map` después de cargar, en el lugar; si lo rechaza no se manda nada) +
  `tileChanged`. La sala detrás de cada puerta con llave se calcula en `initDoors` (los
  muros no cambian; las demás puertas con llave son muro, así una puerta doble comparte
  sala) con el mismo recorrido que `packages/map-format/src/doors.ts`: si cambias uno,
  cambia el otro y `testdata/door-rooms.json` (lo leen los tests de los dos). Una sala
  que no se puede determinar, compartida por puertas de otra llave o que tiene algo de
  afuera (`checkRooms`: templo, NPC, casa, extremo de portal, llegada de barco, teleport
  de diálogo) no deja arrancar, y tampoco una puerta que abierta no deja pasar a nadie
  (`errDoorBlocked`), una sobre un extremo de un portal (`errDoorOnPortal`) ni una que no
  pasa el **chequeo de escape**
  (`checkEscapes`, igual en `doors.ts`): sobre las **áreas** de `session/area.go`
  (casillas unidas a pie con puertas con llave, casas y entradas de escalera, agujero y
  teletransporte como muro; una sala es un área), cada lado de cada puerta con llave
  llega a un templo (el mundo; una llegada de barco no lo es) yendo de una sala a los
  lados de sus puertas y por los portales de `escapeWay` (escalera, escalera de mano,
  agujero, teletransporte; no `rope_spot` ni `boat`), tomados desde `portalSources`, y
  nadie con todas las llaves menos una, parado fuera de las salas o en una casa, entra a
  una sala de esa llave. Si sumas una forma de moverse entre áreas que un jugador sin
  llaves ni herramientas tiene siempre, súmala como arista en los dos lados (`escapeWay`
  y `ESCAPE_WAYS`); si sumas un lugar donde un jugador puede estar fuera de las áreas
  (como las casas), súmalo como punto de partida del chequeo de llaves. Nada
  recorre el mapa en el tick: `World.roomOf` (casilla → sala), los sectores de cada sala
  y `World.areas` (por sector, `areaOf`; las casillas de casa llevan ahí su **área de
  casa** con id negativo, `tileArea`, que el chequeo de escape no ve). **Toda búsqueda de
  casilla libre por anillos** (`freeNear`, `houseExit`, `fallTo` de los items que caen por
  un portal o una nueva: `searchRings`) pasa por `searchFrom` + `areaAllows`: solo donde
  caminaría un jugador parado en el origen (nunca una sala ajena ni un bolsillo cerrado
  por paredes): su área; desde una casilla de casa,
  su área de casa y el área de la salida de la casa; desde la entrada de una escalera, un
  agujero o un teletransporte, las áreas de al lado; desde una puerta con llave, su
  afuera (las áreas de al lado menos su sala); desde cualquier otra casilla, **ninguna**
  (el que la pidió cae en su último recurso). Si sumas un lugar donde un jugador puede
  estar fuera de las áreas, dale su regla en `searchFrom`. Y por `!Map.MovesOnStep`:
  nunca deja a nadie sobre una escalera, un agujero o un teletransporte. `houseEnter` no
  lo necesita: solo pone al jugador en casillas de la casa, y `checkRooms` no deja
  ninguna casa (ni portal) en una sala. Una llegada de barco o un teleport de diálogo
  sobre una casa o una puerta con llave colocada abierta (y un teleport a una casilla no
  caminable), o la salida de una casa o el templo sobre una puerta (con llave o común,
  abierta o cerrada) o no caminable (y el templo en una casa), no deja arrancar
  (`checkArrivals` en `travel.go`, que `initDoors` corre antes del chequeo de escape;
  igual que `checkArrivals` de `validate.ts`; casos en `testdata/arrivals.json`, que leen
  los tests de los dos). `Teleport` no mira si el destino es caminable: un último recurso
  nuevo (como el templo o la salida) tiene que quedar garantizado por la carga, en
  `checkArrivals` (`badLastResort`). `placement` acepta la posición
  guardada si `searchFrom` le da algún lugar (una puerta cerrada después también).
  Desde la sala una puerta trabada se abre sin llave (nadie queda encerrado, tampoco tras
  un relogueo o un reinicio). Todo uso junto a una puerta, también un rechazo, pasa por
  `doorReady` (`inventory.door_cooldown_ms`). Su estado no se guarda.

- **Mundo vivo** (`session/livingworld.go`, el único archivo que importa el módulo,
  `livingworld/README.md`): sus objetos bloquean desde `initLivingWorld`, que corre antes de
  `initDoors`, así que para las salas, las áreas y el chequeo de escape son muros (igual en
  `doors.ts`, que usa `isPassable` sin atravesarlos). `checkEscapes` exige además que cada
  lado de una compuerta cerrada llegue a un templo sin ella (`errGateNoEscape`). `Free` del
  `Host` nunca da una casilla con puerta, y `closeDoor` no cierra sobre un objeto. Los
  números que no son de un objeto van en `balance.yaml living`.

- **Portales:** `world/portal.go` (`world.Portal`, `world.bin` v5, `Map.PortalAt` y
  `Map.MovesOnStep`, que `NewMap` indexa y valida como `make validate`; `MovesOnStep` lee
  el flag `FlagPortalStep` que pone `NewMap`, porque A* lo pregunta por cada casilla) +
  `session/portal.go` (reglas en `02-game-design.md` "Cambiar de piso"). Escaleras,
  agujeros y teletransportes se pisan (`stepPlayer`: el paso y luego `relocate`, el
  `Teleport` sin su chequeo de "sigue en el mundo": quien camina lo está, y el paso ya se
  saltó la vista del piso que deja); la escalera de mano se usa (`usePortal` en la cadena
  de `useItem`, antes de `useStation`) y el punto de soga pide `UseItemOn` con
  `tool.use: rope` (`useRope`, antes de `gather`); los dos a `reach` y con línea de
  visión. La llegada es `portalArrival` (`freeAround` sin casas, radio
  `travel.arrival_radius`, el bloqueo PvP). Nadie más pisa esas casillas:
  `monsterCanEnter`, la búsqueda A* de los monstruos, `reroute` y `bot.Nav` las esquivan;
  `NewMap` rechaza un NPC, un spawn de radio 0, el templo o la salida de una casa sobre
  una (`houseExit` es `freeAround` con casas excluidas, como la llegada). El paso sobre
  una escalera (`move` con `through`) no le manda al que baja los `MapSlice` del piso que
  deja: el `FullMapView` lo reemplaza. `checkRooms` rechaza un extremo de portal en una
  sala. Un portal nuevo que se use a mano entra por `usePortal`/`useRope`; uno que se
  pise tiene que ser un `kind` con `OnStep`. `Flags` (un byte) ya no tiene bits libres.
  Un `MoveItem` a la entrada de un portal que se pisa deja el item del otro lado
  (`fallTo`: el destino o la casilla con lugar más cercana por `searchRings`, sin casas
  ni entradas de portales que se pisan, a `travel.arrival_radius`) y desde ahí sigue como
  un tirar a esa casilla (`groundMerge`, `heldDrop`, `leftHouse`, `gaveAway`). Toda
  búsqueda nueva por anillos usa `searchRings` (que aplica `searchFrom` + `areaAllows`)
  con su propia prueba de la casilla. Un portal sin el item que lo muestra
  (`content.PortalLook`, bloque `portal` de `data/items`) lo rechazan `make validate` y
  `mapcompile` (`compile.checkPortalLooks`); `initPortals` solo avisa (log), para un
  `world.bin` compilado antes de cambiar `data/items`.

- **Caminar (cola de teclado y época, `session/move.go`, docs/05 "Caminar"):** `Walk`
  encola detrás de los pasos de teclado (`Player.keyWalk`; un camino o un paso de
  persecución se descarta), con tope `movement.max_queued_steps` (uno más reinicia), y
  compacta la cola para que una tecla mantenida no la haga crecer. `Player.walkEpoch`
  (desde 1, nunca 0) numera los reinicios: `reject` y `relocate` llaman a `resetWalk` y
  el `WalkRejected`/`FullMapView` lleva la época nueva; un `Walk` de otra época se
  descarta sin contestar (0 no se revisa: bots y clientes viejos). El desborde rechaza
  con `dir` `UNSPECIFIED` (no hay paso rechazado). `Player.qseq` guarda el `Walk.seq` de
  cada paso de teclado, paralelo a `queue` mientras `keyWalk` (se compacta con ella), y
  `move` lo pone en `walk_seq` del `CreatureMove` del propio jugador (los observadores
  reciben 0): el cliente empareja así cada predicción; el servidor no decide nada con
  él. `Welcome.max_queued_steps` le dice el tope al cliente. El cliente tiene pasos
  predichos esperando respuesta: **ningún camino nuevo puede vaciar la cola de un jugador
  conectado en silencio** (`stopWalk` solo); usa `reject` (o `relocate`, que manda el
  `FullMapView`), o su cliente se queda esperando confirmaciones que no llegan. El ritmo
  sigue siendo del servidor (`readyAt`).

- **Vista (AOI, `session/aoi.go`, `docs/02` "La vista"):** la ventana de cada jugador es
  31x21 + 1 de margen (`ViewTilesW`/`ViewTilesH`, `Sees`, `eachObserver`): lo que se le
  manda y lo que puede elegir como objetivo, mirar o usar (con su `reach`). Lo que **nota y
  persigue un monstruo** es la ventana clásica de 15x11 + 1 (`InSight`, `SightHalfW`/`H`):
  una regla nueva de "ver" de un monstruo usa `InSight`, nunca `Sees`. Los rangos de armas,
  hechizos y ataques salen de `data/`; `content.MaxReach` y `content.MaxRange` (6, el
  alcance de las manos y el rango o radio con que apunta un jugador) siguen a la ventana
  clásica: un monstruo golpeado desde tan lejos como se apunta siempre devuelve el golpe.
  El bloqueo de un respawn (`watched`) mira la ventana **ancha**, no la clásica: usa
  `Sees`/`eachObserver` (la ventana entera con su margen, en los pisos que se ven juntos),
  así que nada reaparece a la vista de un jugador (docs/02 "Respawns", decisión del dueño
  del 2026-11-26; la capacidad del mundo de docs/07 quedó por medir con `make bots`). El
  staff que camina invisible no cuenta (`blocksRespawn`); un GM visible sí. Con jugadores
  mirando el área, un monstruo toma una casilla del área que ninguno ve
  (`spawnWatchers`, `unseenSpawnTile`) o espera. El mundo vivo pregunta lo mismo por
  `Host.Watched`; una roca empujada deja de esperar a las dos veces su `reset_seconds`
  (`resetSightHold`, para no encerrar a nadie). `onScreen` (retirar un monstruo
  extraviado) es la misma ventana sin la excepción del staff. Una respuesta que dependa de dónde está otro jugador
  pide `Sees` **y** `Knows` (un invisible no se ve aunque esté en la ventana).
  Un mensaje que va a todos los observadores de un paso o un golpe se arma una vez y se
  comparte (`observeMove`, `hitEvents`): no modifiques un mensaje después de emitirlo.

- **Quién ataca y por qué sale una criatura (A9, `session/attack.go`, docs/05):** todo
  camino nuevo de ataque llama, cuando el ataque ya ocurre y antes de su `Projectile` y su
  golpe, a `playerAttack` (que termina la invisibilidad primero) o, en un monstruo, a
  `attackEvent` (con `hidden` = el objetivo es un invisible). Un hechizo de área es un
  solo `areaAttack`. Curar, conjurar y el daño de una condición no son ataques. Todo
  `CreatureDisappear` lleva su motivo (`disappearMsg(id, why)`): `removeMonster`,
  `disappearFromObservers` y `relocate` lo piden; un camino nuevo que saque o mueva una
  criatura elige el que corresponde (`goneDeath`, `goneTeleport`, `goneLogout`,
  `goneDespawn`, `goneOutOfView`) sin decir más de lo que quien mira ya ve (volverse
  invisible es `goneTeleport`). Ningún cliente recibe un ataque de o a una criatura que
  no conoce: el `fakeClient` de los tests lleva la cuenta de las que conoce por lo que
  recibe (`follow`) y el harness falla el test si alguno recibió uno así, en todos los
  tests de `session` (los clientes que entran con `join`, `joinChar` o `joinCmd`, o que
  mandan `input`; un login a mano en un test pasa por `h.joinCmd`, no por `w.Join`).

- **Tienda cosmética (T5.7):** `payments` (proveedores: `Fake`, que se niega a arrancar sin
  `RPG_ENV=development|test`, y `MercadoPago`; todo HTTP por un cliente inyectable) +
  `store/shop.go` + `httpapi/shop.go` + `app/shop.go` + `session/cosmetics.go`. Todo cambio
  de saldo es **una** transacción que bloquea la cuenta y escribe su fila en
  `premium_ledger` (append-only); el saldo nunca es negativo. Un webhook se aplica una vez
  (`payment_events`, `UNIQUE (provider, event_id)`); `ApplyPayment` bloquea la cuenta
  **antes** de insertar el evento y de leer crédito y reversiones del pago (todos sus eventos
  traen la misma cuenta firmada). Un reembolso que llega antes del pago queda
  `pending_reversal` y lo revierte el crédito. Un pago aprobado que no se puede acreditar se
  registra con nivel error y queda `unmatched` (nunca se descarta en silencio). La referencia
  se firma con `PAYMENTS_REF_SECRET`, no con el secreto del webhook. Los límites (diario,
  anti-flood de equipar, tope de `/premium`) son `limits` de `data/cosmetics.yaml`. La moneda que vale
  un paquete sale de `data/cosmetics.yaml`, nunca del proveedor. El loop nunca lee la
  tienda: el login trae lo comprado y el saldo, y el `app` empuja los cambios con
  `World.CosmeticsChanged` (con `Seq` = id del ledger). Ninguna regla del juego puede leer
  `Player.cos` (lo vigila `TestCosmeticsDoNotChangeCombat`).

- **Apariencia (`session/look.go`, `content/looks.go`, docs/05 "Apariencia y equipo
  visible"):** el cuerpo de un jugador (`Player.look`, `characters.look_*`) se valida contra
  `data/looks.yaml` (`Looks.PlayerLook`) al crear (auth), al entrar (`loadLook`: uno inválido
  o vacío pasa a `DefaultLook` del id) y en `SetLook` (anti-flood `lookFlood`). Lo que ven los
  demás de su equipo sale de `equipmentChanged` → `showEquipment`, que compara los ids de los
  slots visibles (`shownSlots`) y manda `CreatureLook` por `eachWatcher` si cambiaron y el
  jugador ya está en el mundo: **todo camino que cambie un slot de equipo tiene que terminar
  en `equipmentChanged`** (ya lo hacen mover, usar, la muerte, la forja, el intercambio, el
  mercado y las tiendas). `Player.lookMsg`/`equipMsg` y el `creatureLookMsgs` de cada
  `monsterKind` y NPC se arman una vez y se comparten entre `Creature`s (nunca se modifican
  después de emitidos). Ninguna regla del juego lee el aspecto.

- **Islas y acciones de desarrollo (Thimblewick, `docs/16`):**
  - Una isla `dev_only` de `world.yaml` solo entra a `world.bin` con `mapcompile -dev`, marcada con el bit dev de la isla (`world.bin` v6, `Map.DevIslands`).
  - `loadWorld` (`cmd/gameserver`) no arranca un mundo con islas dev si `RPG_ENV` es de producción, con la misma lectura que el proveedor de pagos falso.
  - Las acciones de diálogo de solo desarrollo (`train_skill`, `restore_mana`; lista `DEV_ONLY_ACTIONS` en `packages/content-schema`), y todas las de un NPC con `dev_only: true` (`content.NPC.DevOnly`, la instructora: su oro y experiencia gratis), tienen tres capas:
    - `make validate`: el NPC tiene que estar colocado solo en islas `dev_only`;
    - el arranque: `content.CheckDevPlacement` en `initNPCs`;
    - la elección: `dialog.Check(npc, ...)` con `Facts.DevIsland()`, que fuera de una isla dev no ejecuta nada de la opción (de un NPC `dev_only` rechaza toda opción salvo la que solo cierra, también una que solo tiene `goto`).
  - Una acción de desarrollo nueva necesita las tres capas; un NPC solo para probar va con `dev_only: true`.

## Tests
- `go test ./...` debe correr sin red ni Postgres (usa fakes).
- Tests de integración con Postgres llevan build tag `integration` (`make test-integration`,
  usa `TEST_DATABASE_URL`, por defecto la base `rpg_test`). Cada paquete abre su propio
  schema con `internal/store/storetest`, así corren en paralelo sin pisarse.
- Para lógica de juego, prefiere tests de simulación con `internal/sim`: crea un mundo
  pequeño, inyecta comandos, avanza N ticks y verifica el estado.
- Benchmarks del tick en `internal/game/bench_test.go` y con N jugadores caminando en
  `internal/session/bench_test.go` (`make bench-tick`); no deben empeorar más de 10%.
- Mapas de prueba chicos con `internal/world/worldtest` (dibujos ASCII).

## Base de datos
- Migraciones goose en `migrations/` (embebidas en el binario; el servidor aplica las
  pendientes al arrancar). Nueva migración: `make migrate-new NAME=...`. Nunca edites una
  migración ya mergeada: crea otra.
- Queries en `queries/*.sql` → `make gen-sqlc` → `internal/store/db` (generado, se
  commitea). `internal/store` envuelve las queries y traduce errores de Postgres a
  errores propios (`store.ErrNameTaken`...); los servicios dependen de interfaces para
  poder testearse sin Postgres (ver `internal/auth/authtest`).

- **Opciones guardadas** (docs/05 "Opciones guardadas" y "Opciones de la cuenta"): las de
  juego de un personaje son `session.GameOptions` (`session/options.go`): el loop es su
  dueño, viajan en `Snapshot.Options` y `Character.Options` (también en `state` y en el
  relogueo desde `unsaved`) y salen en `Welcome.options`; una nueva necesita su columna
  `characters.opt_*`, su validación en el mensaje que la cambia y su entrada en `OPTIONS`
  del cliente. Las de interfaz son el documento de `internal/accountopts` (esquema cerrado:
  un campo nuevo se valida ahí y se declara en `OPTIONS`; el test del cliente compara los
  dos) por `httpapi/options.go`; nunca guardes los bytes del cliente, solo `Canonical()`.
  Un guardado conserva las secciones `devices.<clase>` que no trae (`CanonicalKeeping`),
  dentro de la transacción de `store.UpdateAccountOptions` (bloquea la fila de la cuenta;
  nada de mutex en `httpapi`). Lo leído de la base se valida con `ParseStored`, no con
  `Parse`: JSONB lo devuelve espaciado y más largo que `MaxBytes`.
  El cliente mínimo es 0.2.0 (`gateway.DefaultMinClientVersion`): el primero que lee
  `Welcome.options`.

- **Minimapa** (`session/minimap.go`, `explore`, docs/02 y docs/05 "Minimapa"): lo explorado
  es `Player.explored` (`explore.Map`, bits por sector de 32x32, solo crecen), cargado con
  `Character.Explored` (y `ExploredUnsaved` de un relogueo rápido) y guardado en el snapshot
  (`Snapshot.Explored`: los sectores que ganaron bits en el login, upsert en
  `character_explored`). `move` (sin `through`), `relocate` y `join` llaman a
  `exploreView`: un camino nuevo que cambie la casilla de un jugador sin pasar por ellos
  también. `flushMinimap` manda los deltas (uno por segundo como mucho) y
  `minimapRequest` contesta solo casillas exploradas, con presupuesto por jugador. La pista
  del objetivo (`flushHint`) se recalcula cuando `questsChanged` o `relocate` (`hintMoved`;
  ambos solo **levantan** `hintStale`, nunca lo bajan) y siempre pasa por
  `quest.FuzzHint`: nunca mandes el lugar exacto de un paso. Los lugares de un paso son
  `stepTargets` (todos los objetivos reales, una vez por paso, `World.hintTargets`) y
  `stepPlace` elige el más cercano: un tipo nuevo de `complete_when` necesita su caso ahí
  y en `TestEveryObjectiveMarkHoldsARealTarget` (`hint_data_test.go`), que recorre todos
  los pasos de `data/quests` sobre el mapa real.
