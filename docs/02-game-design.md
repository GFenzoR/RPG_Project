# 02 — Diseño de juego

Todos los números de este documento son **valores iniciales** que viven en
`data/balance.yaml`. El código lee de ahí; nunca hardcodees una constante de balance.

## Movimiento
- Por casillas, 8 direcciones (diagonal más lenta: ×1.5 de costo como en Tibia clásico).
- Duración de un paso = `base_step_ms × terreno / velocidad`. La velocidad crece con el
  nivel y con condiciones (haste, paralyze; ver "Condiciones" en Combate).
- Click-to-walk con pathfinding A* en el servidor (máx. 100 casillas).
- Cambiar de piso: escaleras, rampas, cuerdas, agujeros, escaleras de mano.

## Vocaciones (nombres provisionales)
| Vocación | ID en data/ | Equivale a | Rol | Skills principales |
|---|---|---|---|---|
| **Guardián** | `guardian` | Knight | Tanque cuerpo a cuerpo | Espada/Hacha/Maza, Escudo |
| **Montaraz** | `ranger` | Paladin | Daño a distancia, híbrido | Distancia, Escudo, algo de magia |
| **Arcanista** | `arcanist` | Sorcerer | Daño mágico de área | Nivel mágico |
| **Druida** | `druid` | Druid | Soporte, curación, control | Nivel mágico |

- Se elige al crear el personaje (sin isla de novatos sin vocación).
- Cada vocación define en `data/vocations.yaml`: HP/MP/capacidad por nivel, multiplicadores
  de entrenamiento por skill, regeneración, hechizos disponibles y equipo permitido.
- MVP: Guardián y Arcanista. Montaraz y Druida desde T3.1:
  - **Montaraz:** la distancia es la skill que entrena más rápido de todas las vocaciones, el
    escudo casi como el guardián y algo de magia. Su vida y su maná por nivel quedan entre
    los del tanque y los del mago. Usa arcos (y también armas cuerpo a cuerpo, que entrena
    lento). Sus hechizos de daño escalan con la distancia.
  - **Druida:** tan frágil como el arcanista y con su mismo ritmo de nivel mágico. Usa varas
    (varitas de tierra o hielo). Es el mejor sanador y el único que cura a otro jugador.
  - Las bandas y los roles los fija `packages/content-schema/src/vocations-balance.test.ts`.

## Experiencia y nivel
- Experiencia por matar monstruos (repartida según daño; un grupo puede compartirla, ver
  "Grupos"), por quests y por
  algunos oficios (poca).
- Curva cúbica propia, ajustable: `xp(nivel) = a·n³ + b·n² + c·n` con coeficientes en
  balance.yaml. Objetivo de ritmo: nivel 8 en ~1 h, nivel 20 en ~8 h, nivel 50 en ~80 h.
- Al subir de nivel: +HP, +MP, +capacidad, +velocidad según vocación.

## Skills que suben con el uso
Cada skill tiene nivel y progreso (%). Sube **solo al usarla**, y cada nivel cuesta
exponencialmente más (`tries(n) = base × factor_vocación^(n − 10)`).

| Skill | Sube cuando… |
|---|---|
| Puños | Golpeas sin arma |
| Espada / Hacha / Maza | Atacas con un arma de ese tipo (cada golpe cuenta, acierte o no) |
| Distancia | Atacas con arco, ballesta o arrojadizas |
| Escudo | Bloqueas golpes con escudo equipado (máx. N intentos por ronda, anti-AFK) |
| Nivel mágico | Gastas maná (por maná gastado, no por hechizo) |
| Pesca | Pescas en agua con peces |

Implementado en T1.7 (`server/internal/skills` y `server/internal/session/progress.go`):
- `tries(n)` es lo que cuesta pasar del nivel `n` al `n+1`; el progreso vuelve a cero al
  subir y el sobrante pasa al nivel siguiente. Una vocación sin factor para una skill usa 1.
- Armas y puños: cada ronda de ataque (`combat.attack_interval_ms`) cuenta un intento de
  la skill del arma (`weapon.type` en `data/items`), acierte o no; sin arma, `fist`. El
  daño usa ese nivel de skill en la fórmula de "Combate".
- Escudo: cada ataque físico cuerpo a cuerpo recibido con escudo equipado cuenta un
  intento, hasta `skills.shield_max_tries_per_round` por ronda de ataque (ventanas fijas
  de `attack_interval_ms` contadas desde el tick 0). La fórmula de bloqueo de "Combate" no
  usa la skill de escudo (sin cambios en T1.7).
- Anti-AFK: si el objetivo no te ataca durante `skills.afk.after_ms` (cuenta desde que
  empiezas a pegarle o desde su último intento de ataque contra ti), los intentos valen
  `skills.afk.factor` (se acumulan fracciones). Solo un objetivo distinto reinicia la
  cuenta: volver a elegir el mismo no. Los monstruos cuyos únicos ataques son a distancia
  o hechizos (hasta T1.9) cuentan como que no responden.
- Nivel: el que corresponde a la XP total por la curva, hasta `experience.max_level`. Al
  subir, máximos de vida/maná, capacidad y velocidad pasan a los de la vocación en ese
  nivel, y la vida y el maná actuales suben lo mismo que subió el máximo.
- Regeneración: cada `regen.interval_ms` (evento del scheduler por jugador) recupera
  `regen.health` y `regen.mana` sin pasar del máximo. No depende de comida todavía.
- Persistencia: el snapshot de guardado lleva todas las skills y se escriben en
  `character_skills` en la misma transacción que el personaje. El inventario (T1.8) va en
  el mismo snapshot y reemplaza las filas de `inventory_items` en esa transacción.

### Oficios
| Oficio | Acción | Produce |
|---|---|---|
| Minería | Usar pico sobre vetas | Minerales, piedras preciosas |
| Leñador | Usar hacha de leña sobre árboles talables | Madera |
| Herrería | Usar un yunque con materiales y receta | Armas, armaduras, herramientas |
| Cocina | Usar horno/fogata con ingredientes | Comida con buffs pequeños |
| Alquimia (hito posterior) | Mesa de alquimia | Pociones |

- Recetas en `data/recipes.yaml` con nivel de oficio requerido, materiales y chance de
  éxito que mejora con el nivel.
- Los oficios son **independientes de la vocación**: cualquiera puede ser herrero.
- MVP: Pesca y Minería. Herrería y Cocina en el hito 3.

Implementado en T1.12 (`server/internal/session/gathering.go`, números en `data/`):
- Pescar = usar la caña sobre agua con peces (`water_shoal`); minar = usar el pico sobre
  una veta (`iron_vein`). El agua común no tiene peces. Cada lugar es un item con bloque
  `resource` (`docs/06-content-data.md`): skill, alcance, cargas, regeneración, chance y
  botín.
- Cada intento sobre un recurso no agotado cuenta un intento de la skill (pesca u oficio de
  minería), salga o no. La chance es `min(max, base + per_level × (nivel − nivel inicial))`
  con el nivel de antes del intento. Si sale, se elige un botín por peso entre los que el
  nivel alcanza (`min_level`), p. ej. piedra tosca y mineral de hierro desde el nivel 1 y
  cristal de cuarzo desde el 5.
- **Agotamiento:** cada casilla tiene `charges` cosechas. Solo las casillas cosechadas
  guardan estado; cada cosecha reprograma un único evento del scheduler que la deja llena
  `regen_ms` después de la última. Una casilla agotada no da nada ni entrena.
- **Anti-bot:** como mucho un intento cada `gathering.use_interval_ms`; recolectar sin
  moverse de la casilla durante `gathering.afk.after_ms` deja los intentos de skill en
  `gathering.afk.factor` (igual que `skills.afk`). Dar un paso o pausar más
  de dos intervalos lo reinicia.
- El estado de agotamiento vive en memoria: un reinicio del servidor deja todo lleno.

### Anti-bot y anti-AFK (desde el inicio)
- Entrenar contra un objetivo que no responde da progreso reducido tras X minutos.
- Recursos (vetas, árboles, peces) se agotan y regeneran.
- Rate limit de acciones y detección de patrones en el hito de lanzamiento.
- No hay anticheat en el cliente: todo se valida en el servidor y los bots se detectan
  por comportamiento. Las señales, los reportes y el log de economía están en T4.1, y el
  por qué en `01-architecture.md`, "Trampas y anti-bot".

## Combate
- Seleccionas un objetivo (click o hotkey) y el personaje ataca solo cada **2 s** si está
  en rango. Modos: ofensivo / equilibrado / defensivo, y perseguir / quedarse quieto.
- Daño físico: `skill_arma × ataque_arma × factor_modo × aleatorio` contra
  `armadura` (reducción plana aleatoria) y `defensa` (escudo, bloquea por golpe).
  Fórmula exacta (T1.6, `server/internal/combat`, constantes en `balance.yaml`):
  `golpe_máx = (skill × ataque / skill_attack_divisor + nivel / level_divisor) × modo`,
  `golpe = aleatorio(0, golpe_máx) × (1 − resistencia física %)`; a un monstruo le restan
  `aleatorio(armadura/2, armadura)` y `aleatorio(0, defensa/2)`; a un jugador
  `aleatorio(armadura/2, armadura)` y `aleatorio(0, escudo × modo_defensa /
  shield_block_divisor)` (solo ataques físicos).
- Daño mágico: `nivel_mágico × base_hechizo + nivel × factor` con rango aleatorio.
- Elementos: físico, fuego, hielo, energía, tierra, sagrado, muerte. Monstruos tienen
  resistencias porcentuales en su YAML.
- Hechizos que se lanzan escribiendo sus palabras mágicas o con hotkey, con cooldown
  individual y por grupo (ataque / curación / soporte). Las palabras mágicas son
  inventadas por nosotros: nunca uses las de Tibia.
- Runas: items de uso con carga; las crea el mago gastando maná.
- **Magia (T1.9, `server/internal/session/magic.go`):** un hechizo exige vocación, nivel,
  nivel mágico, que no estén corriendo ni su cooldown ni el de su grupo, y maná. Si además
  encuentra objetivo, rango, línea de visión (los muros la cortan) y no hay zona de
  protección, se aplica; recién ahí se gasta el maná, que suma lo mismo en intentos de
  nivel mágico (`skills.base.magic`), y empiezan ambos cooldowns. Un hechizo fallido no
  cuesta nada.
  - Daño y curación: `base + nivel × per_level + nivel_mágico × per_magic_level`, con un
    valor uniforme en ±`spread`; al monstruo se le aplica `× (1 − resistencia del
    elemento %)` (100 % o más = inmune, negativa = debilidad). Armadura y defensa no frenan
    la magia.
  - Área (`radius`): cada monstruo del círculo (`dx² + dy² ≤ r² + r`) con línea de visión
    desde el que lanza tira su propio daño; lo que queda detrás de un muro no se toca.
  - Varitas: arma a distancia del Arcanista (y las varas del Druida); no entrenan skill ni
    gastan maná.
  - Runas: las conjura un hechizo de soporte; cualquiera con su nivel mágico las usa sobre
    una criatura o tile; comparten el cooldown de grupo de su hechizo, no el propio.
  - Monstruos: sus ataques `distance` y `spell` pegan a su objetivo dentro de `range` y con
    línea de visión, también mientras se acercan (el `radius` de sus hechizos llega más
    adelante).
- **Distancia (T3.1, `server/internal/session/combat.go`):** un arma `weapon.type:
  distance` (arco) dispara a su objetivo dentro de `weapon.range` casillas y con línea de
  visión (los muros la cortan, `03-world-and-maps.md`), una vez por ronda de ataque. Cada
  disparo gasta una munición del slot de munición, que debe ser del `ammo.type` que pide el
  arma (`weapon.ammo`). Sin la munición correcta no dispara y el servidor avisa
  (`combat.no_ammo`). El golpe es físico, con la fórmula del cuerpo a cuerpo: skill de
  distancia y `ataque = arma + munición`, contra la armadura y la defensa del monstruo. Cada
  disparo entrena la distancia, acierte o no, con el mismo anti-AFK. Si persigue, se acerca
  solo hasta tener rango y visión. La flecha se consume: no queda en el suelo.
  - Los arcos son de dos manos. Sin chance de fallo propia: los ceros salen de la tirada y
    de la armadura, como en el cuerpo a cuerpo.
- **Hechizos de T3.1:** el daño o la curación pueden sumar `skill × per_skill` (el montaraz
  escala con la distancia). Una curación con `range` cura a **otro** jugador: el objetivo
  (por id o por casilla) debe estar a la vista, en el mismo piso, dentro del rango y con
  línea de visión, y nunca puede ser el que lanza. Cura según el que lanza y se permite en
  zona de protección. `conjure.count` conjura una pila (flechas). En el cliente, la hotkey
  de una curación a otro pone la mira y el siguiente click elige al jugador (Escape cancela).
- **Condiciones (T3.2, `server/internal/session/condition.go`):** las reglas de cada una
  están en `balance.yaml → conditions`; cada fuente (hechizo, ataque de monstruo) da su
  fuerza y su duración (`06-content-data.md`, "Condiciones"). Valen igual para jugadores y
  monstruos, salvo la invisibilidad, que es solo de jugadores.
  | Condición | Id | Efecto | Apilado | Relogueo |
  |---|---|---|---|---|
  | Veneno | `poison` | tierra cada 2,2 s, hasta 25 golpes | suma golpes | sobrevive |
  | Fuego | `burning` | fuego cada 3,3 s, hasta 7 golpes | refresca | sobrevive |
  | Eléctrico | `shocked` | energía cada 1,7 s, hasta 5 golpes | refresca | sobrevive |
  | Paralyze | `slowed` | velocidad −45 %, hasta 15 s; quita `hasted` | refresca | sobrevive |
  | Haste | `hasted` | velocidad +35 %, hasta 45 s; quita `slowed` | refresca | termina |
  | Invisibilidad | `invisible` | no lo ven jugadores ni monstruos, hasta 90 s | refresca | termina |
  | Puntería | `keen_eye` | +7 de distancia en combate, hasta 45 s | refresca | termina |
  - **Daño periódico:** cada golpe aplica la resistencia del monstruo a su elemento (100 % o
    más = inmune: la condición no se aplica); la armadura no lo frena. En una zona de
    protección el golpe no hace daño (pero cuenta). Al monstruo, el daño suma a la parte
    de experiencia de quien la aplicó; si otro la renueva con un daño mayor, o igual y
    agregando golpes, los golpes que quedan pasan a su parte.
  - **Apilado:** `refresh` = queda el mayor tiempo (o golpes) y el daño mayor; `add` = se
    suman hasta el máximo. Una sola instancia por condición y criatura.
  - **Velocidad:** `velocidad = base × (100 + Σ speed_pct) / 100` (mínimo 1). Cambia
    `StepTicks` desde el paso siguiente; los clientes animan con la `duration_ms` del
    servidor.
  - **Skill:** `keen_eye` sube la skill de distancia que usan los ataques y los hechizos
    (`per_skill`), no la que se entrena ni la del panel. Es la mejora de puntería del
    montaraz que quedó pendiente de T3.1.
  - **Invisibilidad:** se filtra en el servidor (`01-architecture.md`, "Trampas y
    anti-bot"): a quien no puede verla no se le manda la criatura, ni sus golpes, curas,
    vida o proyectiles hacia ella; su chat se oye con el nombre pero sin posición. Los
    monstruos no la eligen ni la mantienen de objetivo, salvo los que tienen
    `behavior.sees_invisible` (el murciélago). Por ahora ningún jugador ve invisibles.
    **Atacar o lanzar cualquier hechizo la rompe** (un golpe del arma o de varita, un
    disparo, una runa o un hechizo, salvo volver a lanzar una invisibilidad, que solo la
    renueva); caminar, hablar o usar items no. Lo que un invisible cambia en el mundo sí
    se ve, porque es estado del mapa: mover o soltar items (`TileUpdate`), recolectar (el
    efecto en la casilla del recurso) o abrir una puerta. Es una pista aceptada, como en
    el género; su criatura, su vida y sus números no viajan. Un invisible sigue ocupando
    su casilla: quien intente pisarla recibe `WalkRejected` (un camino por click lo rodea)
    y los monstruos lo esquivan. Es una pista aceptada.
  - **Relogueo:** las de daño y `slowed` sobreviven a un logout con su tiempo restante
    (`characters.conditions`), para que salir del juego no cure; haste, invisibilidad y
    puntería son ventajas y terminan. **Morir** termina todas.
  - **Fuentes:** `swift_stride` (haste 25 s, las cuatro vocaciones) y `purge_venom` (cura el
    veneno) desde nivel 8-9; `keen_eye` (montaraz), `entangle` (druida, `slowed` a un
    monstruo a 4 casillas), `shroud` (arcanista, invisibilidad). `ember_ring` puede dejar
    ardiendo y `arc_bolt` electrizado. La araña de musgo (escupitajo) y el escarabajo de
    mena (mordida) envenenan al hacer daño.
  - **Pendiente:** campos en el suelo (fuego o veneno) que apliquen condiciones al pisarlos
    (necesitan items con duración, disparar al entrar a la casilla y su render); items
    de cura (antídoto); que un jugador vea invisibles.
- Zonas de protección: no se puede atacar ni ser atacado.

## Items, equipo e inventario
Implementado en T1.8 (`server/internal/session/inventory.go`):
- **Instancias:** cada item es una instancia que vive en un solo lugar: en el suelo (sobre
  los items fijos del mapa), en un slot de equipo o dentro de un contenedor. Mover un
  item mueve la instancia (o parte de la pila); nunca se copia, así que un movimiento no
  puede duplicar items. Es la base transaccional del trade y del mercado futuros.
- **Slots de equipo:** cabeza, cuello, mochila, torso, mano derecha, mano izquierda,
  piernas, pies, anillo y munición. Cada `kind` va en un solo slot: `weapon` en la mano
  derecha, `shield` en la izquierda, `armor` en el de su `armor.slot` (`body` = torso),
  `container` en el de mochila. Un arma de dos manos (`hands: 2`) exige la izquierda
  libre. `requires.level`, `requires.vocations` y los `weapons` de la vocación
  (`data/vocations.yaml`) se validan al equipar. `ammo` (flechas, T3.1) va en el slot de
  munición.
- **Combate:** el arma de la mano derecha da el ataque y la skill (`weapon.type`; una
  varita dispara a distancia desde T1.9), el escudo de la izquierda la defensa y la suma
  de `armor` de todo el equipo la armadura del jugador contra golpes físicos.
- **Contenedores:** una mochila (o los restos de un monstruo) tiene `container.slots`
  lugares. Los contenedores se anidan hasta 8 niveles; no se puede meter uno dentro de sí
  mismo. Soltar un item sobre un slot de equipo con un contenedor, o sobre un lugar de una
  ventana de contenedor que tiene otro contenedor, lo mete adentro (soltarlo sobre un
  contenedor en el mapa lo deja en el tile). Las pilas apilables se juntan hasta
  `max_stack`. Un tile admite hasta 20 items distintos soltados (las pilas iguales se
  juntan).
- **Capacidad:** cada vocación tiene capacidad (gramos) por nivel; el peso es el de los
  items equipados con su contenido (`weight × cantidad`). Solo lo que entra al
  inventario desde afuera consume capacidad. La UI muestra oz = gramos / 100.
- **Alcance:** tomar, soltar, abrir o usar en el suelo exige el mismo piso y distancia
  ≤ `inventory.reach` (1); un contenedor del suelo se cierra al alejarse. Mirar alcanza
  todo lo visible. Los items fijos del mapa (`world.bin`) se pueden mirar pero no mover.
- **Usar:** un contenedor se abre o cierra; un consumible cura (`heal_hp`/`heal_mp`) o se
  come (`food_ms` aún no tiene efecto: no hay hambre) y gasta una unidad, con
  `inventory.use_cooldown_ms` entre usos. Las runas (T1.9) y las herramientas (T1.12) se
  usan sobre una criatura o casilla con `UseItemOn`.
- **Personaje nuevo:** empieza con `inventory.start_container` (una mochila vacía) en el
  slot de mochila. El kit de cada vocación llega con los diálogos (T1.10): al aceptar el
  capítulo 1, el capitán del puerto da un alfanje al guardián, monedas al arcanista, un arco
  corto y monedas para flechas al montaraz, y una vara de retoño al druida. El armero vende
  arcos, flechas y el chaleco de piel; el buzo vende las varas.
- **Límite conocido:** cada personaje guarda su inventario en su propio snapshot. Si A
  suelta un item, B lo levanta y se guarda, y el servidor cae antes del siguiente guardado
  de A, el item vuelve en ambos. Los items del suelo no se guardan ni desaparecen solos
  (salvo los restos). Guardado por item y decay de items soltados quedan para el trade y
  la muerte (T1.11) o un hito posterior.
- **Restos:** el botín de un monstruo queda dentro de sus restos (contenedor que no se
  puede levantar) y desaparece con ellos a los `combat.monster_corpse_ms`.

## Monstruos
- Definidos en `data/monsters/*.yaml`: stats, ataques (melee, a distancia, hechizos con
  área), resistencias, loot con probabilidades, experiencia, comportamiento.
- IA simple por estados: `idle → alerta → perseguir → atacar → huir (con poca vida)`.
  Implementada en T1.6 (`server/internal/session/monster.go`): en idle deambula dentro del
  radio de su spawn; los agresivos eligen al jugador visible más cercano con línea de
  visión (alerta: se gira hacia él), lo persiguen (paso que más acerca; si no hay, A* con
  la cuota de pathfinding del tick) y atacan pegados con los temporizadores de cada
  ataque. Con `flee_at_health_pct` se alejan; acorralados, pelean. Los pasivos solo
  responden si los golpean. No entran en zonas de protección ni atacan dentro de ellas.
  Solo piensan en sectores activos. En T1.6 solo hay ataques `melee`; `distance` y
  `spell` llegan con la magia (T1.9).
- Spawns en el mapa con radio, cantidad y tiempo de respawn. El respawn no ocurre si un
  jugador está mirando el punto (evita aparecer en la cara): se reintenta cada 5 s.

## Muerte
Valores iniciales (balance.yaml):
- Pierdes **10 %** de la experiencia total y **10 %** del progreso de cada skill (sin
  bajar del nivel 1 ni de skills base).
- Cada pieza equipada tiene **10 %** de chance de caer al cuerpo; la mochila cae con
  **100 %** salvo con bendiciones.
- **Bendiciones** (hasta 5, se compran con oro del juego a NPCs en templos):
  cada una reduce la pérdida; con las 5 no pierdes items y la pérdida de XP baja a ~3 %.
  En la Isla del Puerto las vende la hermana Liora (templo del Farol) a 200 monedas cada
  una, precio fijo; las cinco son `shore_light`, `hearth_light`, `keel_light`, `star_light`
  y `deep_light`. Se pierden al morir. Un precio que escale con el nivel queda pendiente
  (hito posterior). Se guardan en `quest_state` como `bless.<id>` (no se vende dos veces
  la misma); la columna `characters.blessings` de T1.3 no se usa.
- **Reglas exactas (T1.11, `server/internal/skills/death.go`):** con `b` bendiciones
  (tope `max_blessings`) y `f = b / max_blessings`:
  - XP perdida: `xp_loss_pct − (xp_loss_pct − xp_loss_pct_all_blessings) × f` % de la
    experiencia total (0 → 10 %, 3 → 5,8 %, 5 → 3 %). Puede bajar de nivel (nunca del 1);
    los máximos de vida, maná, capacidad y velocidad siguen al nuevo nivel.
  - Skills: `skill_loss_pct` escalado igual que la XP, sobre los intentos ganados por
    encima del nivel base de cada skill (puede bajar niveles de skill, nunca del base).
  - Equipo: cada pieza (salvo el slot de mochila) cae al cuerpo con
    `equipment_drop_pct × (1 − f)` %; la mochila (con su contenido) con
    `backpack_drop_pct × (1 − f)` %. Se tira en orden de slot con el `rand` sembrado.
  - Todas las bendiciones `bless.*` se borran al morir (también las de un novato).
- Reapareces en el templo de tu ciudad de residencia (`characters.town`, o la primera isla)
  con vida y maná completos. La muerte se guarda al instante (no espera al autoguardado).
- Niveles 1–`novice_max_level` (8): protección de novato: pagan como si tuvieran las 5
  bendiciones (pérdida mínima de XP y skills, sin drop).
- El cuerpo (`creature_remains`, contenedor) queda `corpse_ms` en el suelo con lo que cayó;
  durante `corpse_owner_only_ms` solo el dueño puede sacar o usar lo que contiene (otros
  pueden abrirlo y mirar). Regla pensada para cuando haya PvP.

## Economía
- Monedas de oro, plata, cobre (100:1).
- NPCs compran y venden con precios en `data/npcs/*.yaml`. Los NPCs compran barato
  para que el comercio entre jugadores tenga sentido.
- **Trade directo**: ventana de intercambio con confirmación doble. Transacción atómica.
- Mercado global: hito posterior. El inventario ya es transaccional para soportarlo.
- Sumideros de oro: bendiciones, viajes en barco, reparaciones, recetas de oficio.
- Log de economía para detectar duplicación y bots.

## Mundo e islas (estructura inicial)
| Isla | Nivel sugerido | Rol |
|---|---|---|
| Isla del Puerto (inicial) | 1–15 | Tutorial, primera ciudad, Capítulo 1 |
| Isla del Bosque | 10–30 | Druidas, bestias, minería básica |
| Isla Volcánica | 25–60 | Herrería avanzada, dragones jóvenes |
| Islas Heladas | 40–80 | Hielo, mazmorras profundas |
| Isla Hundida | 70+ | Ruinas del imperio antiguo, final de la historia actual |

- Viaje entre islas: NPC capitán de barco, cuesta oro, requiere nivel o quest para
  algunas rutas.
- Cada isla tiene superficie (piso 7), subterráneos (8–12) y alturas (6–4).

## Historia (esqueleto)
Un imperio antiguo se hundió en el mar y dejó un archipiélago. Las islas guardan los
fragmentos de lo que pasó. La línea principal tiene capítulos, cada uno con **nivel
mínimo**, para que el jugador explore y grindee entre capítulos:

| Capítulo | Nivel mínimo | Isla | Gancho |
|---|---|---|---|
| 1. Náufrago | 1 | Puerto | Llegas sin nada; el capitán te pide ayuda |
| 2. Raíces | 15 | Bosque | Un druida busca un fragmento robado |
| 3. Fuego bajo la piedra | 30 | Volcánica | La forja antigua despierta |
| 4. Silencio blanco | 50 | Heladas | Una expedición desaparecida |
| 5. Lo que se hundió | 75 | Hundida | La verdad del imperio |

Además: quests secundarias, libros con lore, secretos en el mapa.

## Diálogos de NPC
- Ventana con texto del NPC y opciones clickeables (también seleccionables con 1–9).
  Se habla con click derecho sobre el NPC, a 3 casillas como máximo; alejarse cierra el
  diálogo y su tienda. Los NPCs no aparecen en la lista de batalla.
- Árbol definido en YAML con condiciones (nivel, vocación, flag de quest, item en
  inventario) y acciones (dar/quitar item, set flag, abrir tienda, viajar, curar).
- Ver `06-content-data.md`.

## Chat (T1.13)
Números en `data/balance.yaml` (`chat`), nunca en código.
- **Canal local**, mismo piso, alcance en casillas por eje (x, y) desde quien habla:
  susurrar 1×1, decir 7×5 (la pantalla visible), gritar 18×14. Fuera de ese rectángulo
  no se oye nada. Quien habla siempre recibe su propia línea.
- **Canal global**: lo oyen todos los jugadores conectados; además del anti-flood, cada
  jugador espera `global_interval_ms` (10 s) entre dos mensajes globales
  (`chat.global_wait`).
- **Largo**: hasta `max_length` (255) caracteres tras limpiar el texto (controles y
  caracteres invisibles de formato → espacio, espacios colapsados, sin bordes). Más largo →
  `chat.too_long`; vacío → se ignora.
- **Anti-flood** (todos los canales juntos): una cubeta de `flood.burst` (5) mensajes que
  recupera uno cada `flood.refill_ms` (2 s). Hablar con la cubeta vacía silencia
  `flood.mute_ms` (10 s, `chat.flood`); en silencio todo mensaje se rechaza (`chat.muted`).
- Las palabras de un hechizo dichas en el canal decir lo lanzan (T1.9) y no se muestran
  como chat ni cuentan para el anti-flood (el hechizo ya tiene sus cooldowns).
- Una línea que empieza con `/` nunca es chat: es un comando (ver "Moderación").
- Canal de grupo (T3.3): ver "Grupos". Fuera de este hito: gremio y privados persistentes.

## Grupos (T3.3)
Números en `data/balance.yaml` (`party`), nunca en código. Código:
`server/internal/session/party.go`.
- **Formar:** el líder (o un jugador sin grupo, que pasa a ser líder) invita a un jugador
  que **ve** (lista de batalla, botón "+", o `/invite Nombre`). Invitar a alguien fuera de
  vista o invisible responde igual que un nombre que no existe: el grupo no sirve para
  buscar a nadie. Cada invitación cuenta para el anti-flood del chat y termina la invisibilidad del que
  invita (el invitado recibe su nombre). El invitado acepta o
  rechaza; la invitación vence a los `invite_ms` (45 s, por tick del loop). Hasta
  `max_members` (6) miembros contando al líder.
- **Gestionar:** cualquiera puede salir; el líder expulsa, pasa el liderazgo y prende o
  apaga la experiencia compartida. Pasar el liderazgo y prender o apagar cuentan para el
  anti-flood del chat (cada cambio se anuncia a todos). Un grupo que queda con un solo miembro se disuelve.
- **Desconexión:** salir del mundo (logout, conexión caída, cliente lento, reloguear en
  otro lado, expulsión de staff) es salir del grupo. Si era el líder, el liderazgo pasa al
  miembro más antiguo. Sus invitaciones (enviadas y recibidas) se borran. Los grupos **no
  se guardan**: tras un reinicio o un relogueo hay que volver a formarlo. Morir no saca a
  nadie del grupo.
- **Experiencia compartida** (apagada al formar el grupo). Al morir un monstruo, sus
  shares de daño (incluido el de las condiciones de T3.2) se reparten como siempre,
  salvo los de los miembros de un grupo con la experiencia compartida prendida que
  **comparten** esa muerte. Comparte un miembro que cumple las tres condiciones:
  1. **Cerca:** en el piso del monstruo y a `share_distance` (24) casillas o menos de donde
     murió (Chebyshev). Vivo.
  2. **Contribuyó** en los últimos `contribution_ms` (75 s): hizo daño a un monstruo,
     curó a otro miembro herido, o un monstruo lo atacó (tanquear).
  3. **Nivel:** al menos `level_range_pct` (70 %) del nivel más alto entre los que cumplen
     1 y 2, o a lo sumo `level_gap_always` (3) niveles por debajo.

  Si comparten dos o más, los shares de daño de los que comparten forman un pozo que crece
  `bonus_pct_per_member` (6 %) por cada uno después del primero, hasta `max_bonus_pct`
  (24 %), y se divide en partes iguales entre ellos (también a quien no le pegó, como un
  sanador). Los miembros que no comparten cobran su propio share. Si comparte uno solo, no
  hay pozo: cada uno cobra lo suyo. El share de quien salió del mundo (logout o relogueo)
  se pierde: cuenta en el total pero no lo cobra nadie, así que terminar el monstruo de
  otro no da su experiencia. Quests: cuenta la muerte quien le hizo daño, como antes.
- **Anti-carry.** Un personaje alto no puede subir a uno bajo: el bajo queda fuera por
  nivel (condición 3), así que solo cobra el daño que él mismo hizo, y el alto, sin nadie
  más que comparta, cobra lo suyo sin bonus. Estar al lado sin hacer nada tampoco alcanza
  (condición 2), ni ayudar desde lejos (condición 1). El bonus solo existe entre dos o más
  que cumplen las tres. `TestSharedExperienceAntiCarry` lo fija.
- **Loot:** igual que sin grupo, es de quien hizo más daño.
- **Indicador:** apagada, activa o inactiva. Cada miembro lo calcula solo con los miembros
  que ve (él incluido): activa si al menos dos de ellos cumplen 2 y 3 ahora mismo. Así ni
  el indicador ni la marca "comparte" delatan que un miembro lejos murió o está peleando.
  La distancia se evalúa en cada muerte, no en el indicador.
- **Información (auditoría, `01-architecture.md` "Trampas y anti-bot"):** de cada miembro
  viajan nombre, vocación, nivel e isla. Vida, maná (en %) y la marca "comparte" solo
  mientras está en la vista del que mira (lo que el AOI ya le manda; un invisible no está
  en la vista). Nunca viajan
  la posición, el piso ni la vida de un miembro fuera de vista. Nivel e isla sí viajan, y
  pueden cambiar tras una muerte o una subida lejana: es aceptado. `TestPartyInfoAudit` y
  `TestPartyInfoAuditShared` lo fijan.
- **Chat de grupo:** canal `PARTY`, lo oyen todos los miembros estén donde estén, sin
  posición; mismo largo y anti-flood que el resto del chat.

## Moderación (T2.6)
Roles por cuenta: **jugador** (por defecto), **GM** y **admin**. Los asigna solo el
operador con su herramienta (`make set-role`, docs/09); el juego nunca cambia roles.
Cambiar un rol revoca los tokens de la cuenta. Un rol quitado llega también al personaje
conectado: el servidor vuelve a leer cada 5 s el rol de las cuentas de staff en línea (y
el del autor después de cada comando) y lo baja. Desde ahí sus comandos responden como
desconocidos y otro staff puede expulsarlo. Los bans además usan siempre el rol actual de
la base. Un rol nuevo o más alto vale desde el próximo login.

Los comandos se escriben en la línea de chat, en cualquier canal:

| Comando | Rol mínimo | Qué hace |
|---|---|---|
| `/tp x y z` | GM | Lleva al GM a esa casilla |
| `/tp Nombre` | GM | Lleva al GM al lado de ese jugador |
| `/tp Nombre x y z` | GM | Lleva a ese jugador a esa casilla |
| `/item id [cantidad]` | admin | Crea 1–100 unidades de un item de `data/items` (id de contenido o numérico) en la mochila; lo que no cabe cae al suelo. No crea suelos (`kind: ground`) ni items que no se pueden levantar |
| `/kick Nombre` | GM | Desconecta al jugador (`KICKED`) |
| `/ban Nombre duración motivo` | GM | Suspende la cuenta: `30m`, `12h`, `7d`; GM hasta 30 días, admin hasta 3650 días o `perm` |
| `/unban Nombre` | GM | Levanta las suspensiones activas de la cuenta |
| `/announce texto` | GM | Anuncio a todos los conectados (`[Anuncio] Nombre: texto`) |

- **Destino del teleport:** una casilla caminable de una isla, en un piso que existe. Si
  está ocupada, la libre más cercana (hasta 2 de distancia). Si no, `gm.bad_position`.
- **Jerarquía:** kick, ban, unban y mover a otro con `/tp` solo alcanzan a roles menores
  que el propio (`gm.protected`). Nadie se puede banear a sí mismo. Solo un admin da bans
  de más de 30 días o permanentes, y solo un admin levanta un ban permanente.
- **Ban:** es por cuenta, alcanza a todos sus personajes, conectados o no. Al aplicarse
  revoca todos los tokens de la cuenta y desconecta a sus personajes con `BANNED`. Mientras
  dura, el login responde `account_banned`. Termina solo al vencer o con `/unban`.
- **Sin descubrimiento:** para un jugador, un comando de staff responde igual que uno que
  no existe (`command.unknown`) y pasa por el mismo anti-flood del chat. Un GM ve lo mismo
  con los comandos de admin.
- **Ritmo:** el staff tiene un límite propio de 10 comandos seguidos y luego 1 por segundo
  (`command.too_fast`, no se audita).
- **Auditoría:** todo comando de staff que se ejecuta, también los que fallan por
  argumentos, queda en el log de auditoría con quién, qué, a quién, cuándo, argumentos y
  resultado. Los cambios de rol también.
- Llegan después (T4.1), con lugar en el diseño: reportes de jugadores, detección de bots y
  log de economía. Las sanciones que propongan las aplica siempre un GM con estos comandos.

## Cosméticos (monetización futura)
- Outfits, colores de outfit, monturas (solo visual y velocidad igual para todos),
  efectos de nombre. Se compran con una moneda premium (cuando exista la tienda) y
  algunos se ganan en el juego.
- Regla: **ningún cosmético da ventaja de juego**.

## PvP (futuro, ya contemplado)
- Campos `skull`, `pvp_flags`, zonas `pvp` y `no_pvp` en el modelo.
- Sistema de skulls tipo Tibia y castigo por asesinatos injustificados.
