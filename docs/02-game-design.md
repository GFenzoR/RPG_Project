# 02 — Diseño de juego

Todos los números de este documento son **valores iniciales** que viven en
`data/balance.yaml`. El código lee de ahí; nunca hardcodees una constante de balance.

## Cuentas (T2.1)
- Con emails activados (SMTP configurado), una cuenta sin email verificado **puede jugar**,
  pero no puede enviar mapas al portal (`email_unverified`) ni recibir un enlace de reset
  de contraseña (el pedido responde igual, pero no se manda nada: un email sin verificar
  puede no ser del dueño). El operador puede igual darle un enlace a mano
  (`gameserver admin reset-link`).
- `-require-verified-email` (o `REQUIRE_VERIFIED_EMAIL=true` en el compose) exige el email
  verificado también para jugar (`POST /api/play` → `email_unverified`). Necesita SMTP: el
  servidor no arranca con esa opción y sin emails.
- Sin SMTP no se pide verificar nada y el sitio no ofrece "¿Olvidaste tu contraseña?".
- **Login con Google o Discord (T2.1):** solo aparece el botón de un proveedor con claves.
  - Identidad ya vinculada → entra a esa cuenta.
  - Identidad nueva cuyo email (informado por el proveedor) ya tiene una cuenta → **no** se
    vincula sola (evita el robo de cuentas): se pide la contraseña de esa cuenta para
    vincularla, o se crea una cuenta nueva con otro email.
  - Si no, se crea la cuenta. Su email queda verificado solo si el proveedor dice que lo
    está (`email_verified` en Google, `verified` en Discord). Una cuenta creada así no
    tiene contraseña (puede pedir un reset por email para ponerle una).
  - En "Mi cuenta" (`/account`) se ven los vínculos. Vincular otro pide re-autenticarse: la
    contraseña, o, en una cuenta sin contraseña, haber entrado hace menos de 10 minutos.
    No se puede desvincular la última forma de entrar.
  - Un reset de contraseña (quien controla el buzón recupera la cuenta) también quita las
    identidades que nunca probaron ese email (no verificadas por el proveedor, o con otro
    email): así no se queda adentro quien ocupó la dirección con un proveedor.
    Para que el dueño del buzón llegue a eso, una cuenta nueva cuyo email no probó nadie
    (proveedor que no lo verificó, o email escrito en `/oauth/confirm`) recibe el email de
    verificación: confirma, pide el reset y recupera la dirección.
  - Un vínculo empezado en "Mi cuenta" muere si la sesión que lo empezó termina antes de
    volver del proveedor (logout, reset, ban).
  - Si la cuenta existente con ese email no tiene contraseña, `/oauth/confirm` no la pide:
    explica que se entra con el proveedor que ya usa y se vincula desde "Mi cuenta".
  - La app de escritorio no ofrece OAuth (necesitaría abrir el navegador del sistema y
    volver por deep link o loopback; pendiente): muestra que se haga en el sitio.

## Controles del mouse (docs/17 UI-6)
Desde A4 el click derecho sobre un **objeto** abre su menú con la ficha (tipo, stats,
requisitos, efectos, descripción) y sus acciones: la primera, en negrita, es la acción por
defecto (abrir, usar con, comer, equipar o usar). Para usar al instante: **doble click** o
**Ctrl+click derecho**. Opciones → Controles → "Clic derecho sobre objetos" vuelve al modo
**clásico** (click derecho = usar; Mayús+click derecho abre el menú). En los dos modos:
- el click derecho sobre una **criatura** la ataca, o le habla si es un NPC (un solo click
  para pelear); Mayús+click derecho abre su menú;
- Mayús+click izquierdo mira (el texto del servidor); pasar el mouse sobre un objeto del
  inventario, la tienda o el intercambio muestra su ficha;
- con el mouse sobre el mapa, junto al cursor se lee la acción por defecto de esa
  casilla (apenas pasa por ella, sin esperar a que se quede quieto) ("Atacar a lobo", "Hablar con Tilde", "Trepar", "Abrir mochila"); nada sobre el
  suelo pelado ni sobre un adorno que no hace nada al usarlo (docs/17 MOV-7, UI-5);
- el click izquierdo camina hasta la casilla y el botón izquierdo mantenido camina hacia
  el cursor ("Movimiento");
- con el dedo, el toque largo abre el mismo menú (T5.6).

Donde este doc dice "click derecho" para usar algo del mapa (una escalera de mano, una
estación, una puerta, un tablero), en el modo de menú es la acción por defecto de ese menú,
el doble click o Ctrl+click derecho.

## Movimiento
- Por casillas, 8 direcciones (diagonal más lenta: ×1.5 de costo como en Tibia clásico).
- Duración de un paso = `base_step_ms × terreno / velocidad`. La velocidad crece con el
  nivel y con condiciones (haste, paralyze; ver "Condiciones" en Combate).
- **Click para caminar** (máx. 100 casillas): el cliente arma el camino con A* sobre las
  casillas que conoce (rodea criaturas, muros, escaleras, agujeros y teletransportes salvo
  el destino) y lo camina paso a paso como una tecla mantenida: cada paso sale como `Walk`
  y el servidor lo valida y marca su ritmo (`05-network-protocol.md` "Caminar"). El
  primer paso sale en el acto, al apretar el botón (al soltarlo si en la casilla hay un
  item para arrastrar), aunque haya pasos sin confirmar. Si el servidor rechaza un paso
  (una criatura que el cliente no veía) o una criatura se mete en el camino, el cliente
  vuelve deslizándose y lo rodea; un segundo paso rechazado lo detiene (así una zona en
  la que no puede entrar no repite su aviso casilla por casilla). Un anillo dorado marca
  la casilla 300 ms; rojo si no hay camino, y el personaje se detiene. Un click nuevo,
  como una tecla pulsada de nuevo, vuelve a intentar un paso que el servidor rechazó (una
  vez por click); mientras siga rechazado, el camino lo rodea. Una tecla durante
  el camino lo termina en el próximo borde de casilla. Con el doble click (controles de
  menú) el camino del primer click termina: los pasos ya mandados se dan.
- **Mantener el botón izquierdo sobre el mapa** (más de 200 ms quieto, o arrastrando
  donde no hay un item para mover) camina hacia el cursor, casilla por casilla, como en
  Diablo 2: en cada borde elige la dirección (de 8) por el ángulo del cursor respecto del
  personaje. La cámara lo sigue, así que el cursor quieto en la pantalla sigue apuntando
  igual. Contra un muro se desliza como la tecla; si la dirección está bloqueada, rodea
  hacia la casilla bajo el cursor mientras siga apuntando al mismo lado; sin camino,
  gira. Como el click, no pisa escaleras, agujeros ni teletransportes salvo la casilla
  bajo el cursor. Al soltar se dan los pasos ya mandados. Sobre una casilla con un item, arrastrar
  antes de los 200 ms sigue moviendo el item. Con el dedo no hay mantener: está el pad.
- **Movimiento fluido** (al estilo de Diablo 2, pero por casillas y con el servidor como
  juez). Mantener una tecla camina casilla tras casilla sin detenerse entre ellas: el
  cliente predice hasta `max_queued_steps` pasos (`balance.yaml`, 4) y decide el siguiente
  50 ms antes de que termine el que dibuja; el servidor los encola y empieza cada uno el
  tick en que termina el anterior (`05-network-protocol.md` "Caminar"). La velocidad no
  cambia: cada paso dura lo que dice la fórmula de arriba y el servidor valida cada paso
  y su ritmo. Soltar la tecla en los últimos 50 ms de un paso todavía da el siguiente.
  - Dos flechas perpendiculares a la vez caminan en diagonal (arriba + derecha = noreste,
    con su costo de ×1.5); si la diagonal está bloqueada, se camina por su mitad
    horizontal o vertical libre (se "desliza" junto a un muro).
  - **Girar sin caminar** (docs/17 MOV-2): quieto, una tecla (o el pad) hacia otro lado
    gira al personaje en el acto y camina solo si sigue apretada 80 ms: un toque corto
    solo gira. Mirando ya hacia ese lado, o caminando, camina enseguida. Ctrl+flecha gira
    siempre sin caminar, como en Tibia (Ctrl con WASD no: Ctrl+W cierra la pestaña).
  - Un paso rechazado (una criatura que el cliente todavía no veía, una puerta de casa
    sin acceso) devuelve al personaje a su casilla deslizándose en ~160 ms, sin saltos,
    aunque el cliente ya dibujara los `max_queued_steps` pasos predichos.
  - Las demás criaturas (y los pasos propios que da el servidor, como los de perseguir)
    se dibujan sobre la línea de ticks del servidor con un colchón contra el jitter de la
    red (~40 ms): los pasos seguidos del servidor se ven seguidos, sin pausas ni tirones.
    El click y el mouse mantenido son pasos predichos, como la tecla.
  - La cámara y las criaturas se mueven de a un píxel de pantalla (no de a un píxel del
    sprite, que a escala 3 eran saltos de 3 píxeles cada pocos frames); los sprites siguen
    enteros y a escala entera. Las criaturas sin frames de caminar (monstruos, NPCs) dan
    un saltito de 1 px en medio de cada paso.
- Cambiar de piso: escaleras, escaleras de mano, agujeros, sogas y teletransportes (ver
  "Cambiar de piso"). Rampas no hay por ahora.

### Cambiar de piso (portales)
Los portales son datos del mapa (`world/islands/<id>/portals.yaml`, formato en
`03-world-and-maps.md`); `mapcompile` los lleva a `world.bin` y el servidor
(`server/internal/session/portal.go`) mueve al jugador. Reglas propias, a la manera de
Tibia:
- **Escalera (`stairs`), agujero (`hole`) y teletransporte (`teleport`): se pisan.** Al dar
  el paso sobre su casilla, el jugador aparece en el otro extremo. El paso ocurre y en el
  mismo tick llega al destino, con el mapa del otro piso. Quienes lo veían reciben el paso y
  enseguida su desaparición: el cliente lo borra en el acto, sin dibujar el paso, así que lo
  ven desaparecer de la casilla donde estaba. Cuesta lo que un paso. Un agujero solo baja
  y no tiene vuelta; una escalera tiene su pareja (otra escalera que sale junto al destino y llega junto al origen),
  así que nunca se aparece sobre la escalera de vuelta. Un teletransporte puede quedar en el
  mismo piso o llevar a otra isla.
- **Escalera de mano (`ladder`): se usa.** Click derecho ("Trepar" del menú, o el doble
  click, en los controles de menú; "Trepar" del toque largo) sobre
  su casilla, desde ella o a `inventory.reach` (1) casilla, en el mismo piso y con línea de
  visión (como al recolectar: con un alcance mayor, nunca a través de un muro). Pisarla no
  hace nada. Lo que haya encima (un cadáver, monedas que alguien tiró) no la tapa: el
  click derecho trepa igual. Ese item se abre o se usa con **Ctrl+click derecho** (en
  escritorio) o desde el toque largo ("Abrir" o "Usar", al lado de "Trepar"), o se
  arrastra fuera. Sobre una escalera de mano sin nada encima, Ctrl+click derecho trepa
  igual: no hay otra cosa que usar. El toque largo nunca ofrece "Usar" ni "Mover" para el
  item que muestra un portal (la escalera de mano misma, una escalera, un agujero): solo
  "Trepar" donde corresponde y "Mirar".
- **Punto de soga (`rope_spot`): hace falta una soga.** Se usa una herramienta con
  `tool.use: rope` (la soga, `data/items/tools.yaml`) sobre su casilla, al mismo alcance y
  con línea de visión.
  Usarla sin soga dice "Necesitas una soga para subir por aquí."; otra herramienta no
  encuentra nada. Solo sube.
- **Ritmo:** subir o bajar una escalera de mano o una soga cuesta lo que un paso hasta el
  destino y no se puede en medio de un paso ("Termina de dar el paso antes de subir o
  bajar."). Así nadie sube y baja más rápido de lo que camina.
- **Llegada:** la casilla de destino; si está ocupada, la libre más cercana a
  `travel.arrival_radius` (2) casillas, como la llegada de un barco: solo en el área del
  destino (nunca en la sala de una puerta con llave ni en un bolsillo cerrado por paredes,
  ver "Puertas con llave"), nunca en una casilla de casa y nunca sobre otra escalera,
  agujero o teletransporte. Sin casilla libre, el paso o el uso se rechaza ("Hay algo del otro lado:
  no hay lugar para pasar.") y no cambia nada: el jugador ni siquiera pisa la escalera.
  Esa búsqueda va por anillos, no a pie: `make validate` exige que toda casilla del radio
  donde podría caer se conecte a pie con el destino (nadie cae del otro lado de un muro).
- **PvP:** quien atacó a un jugador y tiene el bloqueo no puede entrar a una zona protegida
  por un portal si no está ya en una, igual que a pie. Cuenta la casilla desde donde toma
  el portal: en una escalera, un agujero o un teletransporte, la casilla del portal que
  pisa (bajar de una zona protegida a una escalera fuera de ella es salir de la zona, y
  aparecer en otra zona protegida es entrar); en una escalera de mano o una soga, donde
  está parado.
- **Barco (`boat`):** el formato lo acepta pero no mueve a nadie: los viajes en barco son
  del capitán (`data/boat_routes.yaml`, "Viajes en barco"). `make validate` lo advierte.
- **Monstruos:** no usan portales. Nunca pisan la casilla de una escalera, un agujero o un
  teletransporte, ni para perseguir; tampoco aparecen ahí (un spawn de radio 0 sobre una
  no es válido). Un jugador que persigue a su objetivo tampoco toma una escalera solo.
- **Nadie se queda parado sobre una escalera:** los caminos por click del cliente y los
  desvíos del servidor rodean las escaleras, agujeros y teletransportes salvo que sean el
  destino, y las búsquedas de casilla libre (entrar al juego, despertar, llegar en barco o
  por un portal, salir de una casa, `/tp` del personal) las saltean. Un NPC no puede estar
  sobre una (la taparía para siempre). Caminar con el teclado sobre una sí la toma: es
  pisarla. Si no queda ninguna casilla libre en el radio, despertar en el templo y salir de
  una casa comparten la casilla de destino como último recurso: el templo o la salida, que
  nunca están sobre una escalera, un agujero o un teletransporte, ni sobre una puerta (con
  llave, ver "Puertas con llave"; ni común, que cualquiera puede cerrar y dejaría a alguien
  dentro de una puerta cerrada), y que son caminables (el templo, además, fuera de toda
  casa): si no, el servidor no arranca y `make validate` no pasa (`checkArrivals`). Quien
  entra al juego con todo lleno y tenía guardada la posición sobre una escalera (de antes
  de los portales) o sobre una puerta (con llave, o común y cerrada desde entonces) va al
  templo.
- **Lo que el cliente ve:** lo mismo que un teletransporte del personal (`FullMapView` del
  piso nuevo, docs/05). Solo se dibuja el piso del jugador.
- **Cómo se ve un portal:** la casilla es el portal, pero el jugador ve un item que lo
  muestra (bloque `portal` de `data/items`, `06-content-data.md`): `stairs_down` /
  `stairs_up` (escaleras, del pack Dungeon Crawl), `ladder_up` (la escalera de mano vista
  desde abajo) / `ladder_down` (la trampilla abierta de arriba), `hole` (agujero),
  `rope_spot` (la luz que entra por un hueco del techo) y `teleport` (un anillo de piedras
  grabadas alrededor de un remolino de luz). Arte propio de `tools/spritegen`; el
  teletransporte está animado (6 frames de 100 ms, `sync: world` en `assets/sprites.yaml`
  `tiles`: el remolino gira, suben chispas y laten las runas; el renderer anima los
  `frame_<n>` de cualquier item desde A10, docs/17 ART-7). Los demás son estáticos.
  `make validate` y `mapcompile` exigen el item en la entrada de
  cada portal (salvo un `boat`), y el servidor avisa en el log al arrancar si falta
  (`03-world-and-maps.md`, "Validación"). El item no mueve a nadie: lo hace `portals.yaml`.
- **Items que caen:** lo que se tira (`MoveItem`) sobre una escalera, un agujero o un
  teletransporte cae al otro extremo, como en Tibia: queda en el destino del portal o, si
  ahí no entra (`maxGroundItems` items distintos y ninguna pila a la que sumarse), en la
  casilla más cercana con lugar a `travel.arrival_radius` con las reglas de la llegada de
  un jugador: solo en el área del destino (nunca en la sala de una puerta con llave ni en
  un bolsillo cerrado por paredes), nunca en una casilla de casa y nunca sobre otra
  escalera, agujero o teletransporte (no cae dos veces). Las criaturas no importan: un item
  queda debajo de ellas. Sin lugar se rechaza ("Del otro lado no hay lugar donde caiga.",
  `portal.no_room`) y nada cambia. Fuera de eso es un tirar al suelo en esa casilla: un
  personaje en espera de un intercambio no tira nada (`inventory.saving`), lo que cae
  nunca se suma a una pila reservada a otro, y lo que el dueño saca de su casa por una
  escalera junto a la puerta queda reservado a él donde cae ("Falla segura", T5.3). Quien
  ve la casilla de donde salió lo ve irse y quien ve el destino lo ve caer. Sobre una
  escalera de mano o un punto de soga lo que se tira queda ahí (se usan a mano).

## La vista (decisión del dueño, 2026-11-17)
El dueño eligió ver más mapa: la vista llega a **31x21 casillas** (antes 15x11, como en
Tibia). Diseño de la pantalla en `17-direccion-de-arte-y-ui.md` (UI-4).
- **Qué manda el servidor.** A cada jugador, la ventana de 31x21 centrada en él más 1
  casilla de margen por lado (33x23): mapa, criaturas, efectos y proyectiles
  (`05-network-protocol.md`, "Formato de mapa"). Es la misma para todos, tenga la pantalla
  que tenga: "A ve a B" sigue siendo simétrico, y nadie ve más por tener un monitor grande
  o un cliente modificado (todo lo que manda el servidor se puede leer: `01-architecture.md`,
  "Trampas y anti-bot").
- **Qué dibuja el cliente.** Siempre a escala entera (pixel-perfect). Por defecto, la
  vista más grande que llena la caja del mapa sin dejar parte vacía (la escala entera más
  chica a la que la ventana de 31x21 cubre la caja). En teléfonos y tablets, nunca menos
  de las 15x11 de siempre: una pantalla chica se queda con la escala de antes. En
  escritorio el mapa es la pantalla entera sobre la barra de abajo (docs/17 UI-4) y
  cubrirla manda, aunque muestre menos filas: 1920x1080 muestra 30x15,5 a 2x, 2560x1440
  26,7x14,1 a 3x, 1280x800 20x11,1 a 2x, 1280x720 20x9,9 a 2x, la app a 960x700 30x19,1 a
  1x, y una pantalla ultra ancha (21:9) unas 10 filas (2560x1080: 26,7x10,3 a 3x).
  Alejando (Ctrl+rueda, el botón − o un pellizco) llega a la ventana entera (31x21 a 1x en
  1920x1080 y 1280x800; a 1280x720, las 19,75 filas que entran), con el resto de la caja
  oscuro; acercando, a 7x5, como antes (`client/CLAUDE.md`, "Zoom del mapa"). La elección
  se recuerda por dispositivo.
- **Depende de la ventana entera** (aunque el cliente dibuje menos): elegir un objetivo
  (monstruo, o jugador con PvP) y conservarlo, mirar una casilla o una criatura, reportar
  a un jugador y la vida y el maná de los miembros del grupo. Un objetivo a 15 casillas
  se conserva; para pegarle hay que llegar a su rango (con "perseguir", el personaje
  camina). Proponer un intercambio sigue pidiendo estar al lado: la ventana solo cambia
  la respuesta ("no es posible" a quien no se ve, también a un invisible aunque esté al
  lado; "muy lejos" a quien se ve y no está al lado).
- **No cambia con la vista:**
  - **Los rangos:** cada arma a distancia, hechizo y ataque de monstruo tiene su `range`
    en `data/`. Ver más lejos no los alarga. El de un arma, un hechizo de daño o de
    curación y una condición a distancia es como mucho 6 (el esquema y
    `content.MaxRange`), el medio alto de la ventana clásica, y el `radius` de un hechizo
    de área también: un monstruo golpeado desde tan lejos como apunta un jugador siempre
    lo nota y devuelve el golpe (si no, se lo mataría gratis desde fuera de lo que nota). El de un ataque de monstruo no tiene ese
    tope: un monstruo solo ataca a un objetivo que nota.
  - **Lo que nota un monstruo:** un agresivo elige objetivo, y lo sigue persiguiendo, solo
    dentro de la ventana clásica: 15x11 + 1 de margen, 8 casillas a los lados y 6 arriba y
    abajo, en su piso (`session.InSight`). Un jugador lo ve desde 15 casillas sin que lo
    note, y quien escapa a más de 8 lo pierde, como antes de la vista ancha.
  - **El alcance de las manos** (`inventory.reach`, `resource.reach`: como mucho 6).
  - **Lo que se oye:** decir llega a 7x5 casillas y gritar a 18x14 (`balance.yaml
    chat.ranges`): a alguien a 12 casillas se lo ve, pero no se lo oye hablar. El sonido
    se oye hasta 8 casillas ("Sonido").
- **PvP:** la visión es la ventana entera, igual para todos. Quien juega con el mapa
  acercado (o en un teléfono, que por defecto muestra menos) tiene en la lista de batalla
  todo lo que su cliente conoce. La cámara va centrada en el jugador, sin "mirar adelante".
- **Respawns:** un monstruo no reaparece en una casilla con algún jugador dentro de su
  ventana clásica (8 casillas a los lados y 6 arriba y abajo, en los pisos que se ven
  juntos; `session.watched`), no de la ventana entera. Si fuera la entera, quien caza en
  un spawn frenaría los respawns de los spawns vecinos (están a unas 12–20 casillas) y la
  capacidad del mundo (`07`, "Capacidad del mundo", medida con 15x11) quedaría corta. A
  cambio, un monstruo puede aparecer dentro de lo que ve un jugador, a 9–16 casillas a
  los lados o 7–11 arriba y abajo. Cada spawn bloqueado reintenta cada 5 s en otra casilla
  de su radio. Es reversible en una línea (`watched` con `eachObserver`) si el dueño
  prefiere que nada aparezca a la vista.

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
    los del tanque y los del mago. Usa arcos de dos manos o ballestas de una mano, que le
    dejan la izquierda para el escudo (auditoría de contenido M4, 2026-11), y también armas
    cuerpo a cuerpo, que entrena lento. Sus hechizos de daño escalan con la distancia.
  - **Druida:** tan frágil como el arcanista y con su mismo ritmo de nivel mágico. Usa varas
    (varitas de tierra o hielo). Es el mejor sanador y el único que cura a otro jugador.
  - Las bandas y los roles los fija `packages/content-schema/src/vocations-balance.test.ts`.
  - **Carrera de cada vocación (auditoría de contenido M2, 2026-11):**
    `server/internal/sim/balance_vocations_test.go` juega del nivel 1 al 50 al arcanista,
    al druida y al montaraz con sus armas, sus hechizos y un presupuesto de maná real
    (regeneración, comida y brebajes de maná que se pagan con el botín), y al guardián como
    vara de medir. Exige: cada franja de niveles en 0,5-1,5 veces el tiempo del guardián;
    que la caza pague brebajes, cataplasmas y munición (como mucho 75 % del botín); que el
    nivel mágico salga del maná que de verdad se gasta (~20 al nivel 30 y ~35 al 49 para
    los magos, ~8 y ~12 para el montaraz) y que cada hechizo tenga su nivel mágico pocos
    niveles después de su nivel; que la ballesta con escudo pierda menos vida por segundo
    que el arco y no tarde más de 1,3 veces; y que las áreas nuevas (`tempest_ring`,
    `rime_burst`) le peguen más que las de antes a los monstruos de su isla.
    `base_tries` de magia (1450) y la regeneración por vocación no cambiaron: el maná que
    faltaba lo ponen la comida y los brebajes.
  - **Progresión de hechizos (2026-11, rama `feat/spells-progression`):** antes el guardián
    no tenía hechizos propios y los demás dejaban de aprender entre el nivel 12 y el 28.
    Ahora cada vocación suma hechizos hasta el ~50 (tabla de abajo): el guardián, una cura
    propia (12) y dos golpes de área alrededor suyo que crecen con el arma que tiene en la
    mano (20 y 35, `skill: weapon`, `06-content-data.md` "Hechizo"); el druida, una cura
    fuerte (30) y un área de radio 2 (40); el montaraz, un área de flechas (25) y un tiro
    pesado (40); el arcanista, un golpe fuerte a un objetivo (40) y el área más ancha del
    juego (radio 3, 48). La carrera simulada ahora también juega al guardián con sus
    hechizos, y exige además que cada hechizo de daño o cura cueste como mucho la mitad del
    maná de su nivel, que su nivel mágico esté a lo sumo 4 niveles después de su nivel (el
    guardián que compra brebajes de maná llega a ~4 al 30 y ~6 al 49) y que las cazas de sus
    primeros niveles lo lancen: cada cura propia, cada ataque a un objetivo y, para quien no
    tiene ataques a un objetivo (el guardián), sus áreas. Las áreas de los magos y del
    montaraz quedan para grupos: en un duelo un área le pega a un solo monstruo y un rayo
    barato hace lo mismo por menos maná, así que la simulación no las necesita y tampoco las
    exige. Por eso `frost_bloom` y `scatter_volley` le pegan a cada monstruo un poco menos que
    `frost_lance` y `sure_shot`: anchas y livianas.
  - **Revisión de la progresión (2026-11):** los roles se miden ahora en cada franja de la
    carrera (niveles 12 a 49, con el nivel mágico que la simulación alcanza en cada uno y
    contando solo los hechizos que ya se pueden lanzar), no solo en el 30. Medido así, el
    primer reparto invertía dos roles: la cura del guardián curaba más por lanzamiento que
    `verdant_mend` del druida del nivel 12 al 29, y `steel_whirl` le pegaba más a cada
    monstruo que `tempest_ring` del arcanista del 35 al 47. Ahora `iron_resolve` cura ~7-9 %
    de la vida del guardián (menos de 0,8 veces la mejor cura del druida en cada nivel) y
    `steel_whirl` escala 1,1 por punto de skill (era 1,4). Además, el nivel mágico de los
    golpes del guardián (1 y 2; eran 2 y 4) es el que alcanza **sin comprar un solo brebaje
    de maná**, solo con su regeneración, la comida y su cura: con factor de magia 2,7, el
    nivel 4 pedía ~44 500 de maná, unos 560 brebajes, y un guardián que no los compra no
    pasa de nivel mágico 3 en toda la carrera. La carrera simulada juega también a ese
    guardián (hábito `dry`) y exige que llegue a cada hechizo a tiempo. Ritmo: las
    vocaciones siguen en 0,5-1,5 veces el tiempo del guardián por franja. El guardián que
    compra brebajes de maná para sus golpes va de 1 a 50 en ~35 h (antes de sus hechizos,
    ~40 h), a la par de los magos (arcanista ~34 h, druida ~32 h) y del montaraz (~35 h);
    sin brebajes de maná tarda ~39 h (el oro de cada uno: "Economía", brebajes de maná).

#### Hechizos por vocación
Nivel / nivel mágico / maná. Las palabras son propias (nunca las de Tibia); los nombres van
en `i18n/*/spells.yaml`. En **negrita**, los de la progresión de 2026-11.

| Vocación | Hechizo | Palabras | Nivel / NM / maná | Qué hace |
|---|---|---|---|---|
| Todas | `swift_stride` | pede celeri | 8 / 0 / 30 | haste 25 s |
| Todas | `purge_venom` | venenum pelle | 9 / 0 / 25 | cura el veneno |
| Guardián | **`iron_resolve`** | sanguis firmus | 12 / 0 / 30 | se cura ~7-9 % de su vida (sobre todo por nivel) |
| Guardián | **`sweeping_blow`** | ferrum gyrus | 20 / 1 / 35 | físico, radio 1, escala con la skill del arma en la mano |
| Guardián | **`steel_whirl`** | turbo chalybis | 35 / 2 / 60 | el anterior más fuerte, cooldown 6 s |
| Arcanista | `arc_bolt` | fulgur iacio | 1 / 0 / 10 | energía a 4 casillas, a veces electriza |
| Arcanista | `conjure_arc_rune` | runa fulguris | 5 / 1 / 60 | conjura una runa de arco |
| Arcanista | `light_heal` | vita lumen | 6 / 0 / 25 | cura |
| Arcanista | `ember_ring` | ignis corona | 10 / 3 / 45 | fuego, radio 2, a veces quema |
| Arcanista | `shroud` | umbra tegit | 14 / 4 / 110 | invisibilidad 40 s |
| Arcanista | `tempest_ring` | tonitrus corona | 28 / 14 / 80 | energía, radio 2, a veces electriza |
| Arcanista | **`storm_spear`** | fulmen telum | 40 / 26 / 90 | energía a 4 casillas, su golpe más fuerte |
| Arcanista | **`dusk_maelstrom`** | vortex noctis | 48 / 30 / 160 | muerte, radio 3: el área más ancha |
| Druida | `frost_lance` | glacies hasta | 1 / 0 / 10 | hielo a 4 casillas |
| Druida | `verdant_mend` | viridis cura | 1 / 0 / 20 | cura |
| Druida | `mend_other` | sana amicum | 8 / 2 / 40 | cura a otro jugador a 5 casillas |
| Druida | `entangle` | radix vincit | 10 / 3 / 40 | `slowed` a 4 casillas |
| Druida | `bramble_burst` | rubus orbis | 12 / 4 / 50 | tierra, radio 1 |
| Druida | `rime_burst` | pruina orbis | 16 / 6 / 55 | hielo, radio 1 |
| Druida | **`sap_surge`** | sucus vitae | 30 / 18 / 45 | cura fuerte (~2 veces `verdant_mend`) |
| Druida | **`frost_bloom`** | hiemis flos | 40 / 25 / 60 | hielo, radio 2: llega a lo que está a 2 casillas |
| Montaraz | `sure_shot` | sagitta certa | 2 / 0 / 15 | físico a 5 casillas, escala con distancia |
| Montaraz | `conjure_arrows` | fabrica sagittas | 3 / 0 / 35 | conjura 25 flechas |
| Montaraz | `ranger_mend` | cura silvae | 4 / 0 / 20 | cura |
| Montaraz | `keen_eye` | oculus acer | 10 / 0 / 50 | +7 de distancia en combate |
| Montaraz | `briar_arrow` | spina volans | 12 / 1 / 35 | tierra a 5 casillas, escala con distancia |
| Montaraz | **`scatter_volley`** | imber sagittarum | 25 / 5 / 40 | físico, radio 2, escala con distancia |
| Montaraz | **`heartwood_shot`** | sagitta gravis | 40 / 9 / 70 | físico a 5 casillas, su golpe más fuerte, cooldown 6 s |

Los números exactos (base, por nivel, por nivel mágico, por skill, cooldowns) están en
`data/spells.yaml`; los límites de rol (el druida cura mejor y el arcanista tiene el área
más fuerte en cada franja de la carrera del 12 al 49, con lo que cada vocación ya puede
lanzar ahí; el arcanista tiene el área más ancha, el montaraz el alcance más largo, los
golpes del guardián escalan con su arma, todo cabe en las 12 teclas de la hotbar) los fija
`packages/content-schema/src/vocations-balance.test.ts`.

## Experiencia y nivel
- Experiencia por matar monstruos (repartida según daño; un grupo puede compartirla, ver
  "Grupos") y por quests. Los oficios y la recolección no dan experiencia de nivel: solo
  suben su propia skill con el uso ("Oficios"; `session/crafting.go` y
  `session/gathering.go`). Darles un poco sería una tarea de balance aparte, si el dueño
  la pide.
- Curva cúbica propia, ajustable: `xp(nivel) = a·n³ + b·n² + c·n` con coeficientes en
  balance.yaml. Objetivo de ritmo: nivel 8 en ~1 h, nivel 20 en ~8 h, nivel 50 en ~80 h
  (`experience.pace` en balance.yaml; la detección de bots lo usa como ritmo esperado).
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
  `regen.health` y `regen.mana` sin pasar del máximo. **Comida** (auditoría de contenido
  m2, 2026-11): con la condición `well_fed` cada tick recupera
  `regen × (100 + regen_pct) / 100` (entero; `regen_pct` = 100, el doble). Sin comer se
  sigue regenerando lo de siempre: nadie pasa hambre.
- Persistencia: el snapshot de guardado lleva todas las skills y se escriben en
  `character_skills` en la misma transacción que el personaje. El inventario (T1.8) va en
  el mismo snapshot y reemplaza las filas de `inventory_items` en esa transacción.

### Oficios
| Oficio | Acción | Produce |
|---|---|---|
| Minería | Usar pico sobre vetas | Minerales, piedras preciosas |
| Leñador | Usar hacha de leña sobre árboles talables | Madera |
| Herrería | Usar un yunque con materiales y receta | Armas, armaduras, herramientas |
| Cocina | Usar horno/fogata con ingredientes | Comida: más tiempo de `well_fed` (regeneración) |
| Alquimia (hito posterior) | Mesa de alquimia | Pociones (hoy los brebajes de maná los venden NPCs) |

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

Implementado en T3.4 (`server/internal/session/crafting.go`, recetas en `data/recipes.yaml`):
- **Leñador** es recolección: el hacha de leñador (`tool.use: woodcutting`) sobre un abedul
  (`birch_tree`, con su bloque `resource`) da troncos y, desde woodcutting 6, algo de resina.
  Mismo motor que pesca y minería (cargas, regeneración, anti-bot); los robles y pinos de
  decoración no se talan.
- **Estaciones:** fragua (`smelting_forge`), yunque (`anvil`) y fogón (`cooking_hearth`) son
  items del mapa. Usarlas (click derecho) a 1 casilla abre la ventana de recetas de esa
  estación, con lo que falta y la chance a tu nivel. Herrería: mineral + tronco → lingote en
  la fragua; lingotes → hacha de leñador, pico o espada corta forjada en el yunque (con el
  martillo de herrero encima). Cocina: pescado crudo, carne de jabalí y algas → pescado a la
  brasa, jabalí asado y guiso del puerto (más `food_ms` que lo crudo; el guiso cura un poco).
- **Intento:** el servidor comprueba receta, estación en esa casilla, distancia (1 casilla,
  mismo piso), nivel mínimo del oficio, herramienta llevada, ingredientes en los
  contenedores (no lo equipado), capacidad (el peso de los ingredientes cuenta como
  liberado) y sitio en la mochila (sin contar los huecos que liberarían los ingredientes).
  Si todo vale, toma los ingredientes de una vez y tira la chance
  `min(max_success, base_success + success_per_level × (nivel − level))` con el nivel de
  antes del intento. Éxito o fallo, los ingredientes se gastan y el oficio gana `xp` intentos.
- **Anti-bot:** comparte el ritmo de la recolección: tras un intento no hay otro (de oficio o
  de recolección) hasta `max(gathering.use_interval_ms, time_ms)`. No hay factor anti-AFK:
  quedarse junto al yunque es lo normal y cada intento ya cuesta sus ingredientes.
- Si la mochila está llena, el intento se rechaza aunque los ingredientes fueran a liberar
  un hueco (el chequeo es conservador). Usar una herramienta sobre una estación (el
  martillo sobre el yunque) también la abre.
- Sin vendedores de recetas todavía: se conocen todas; las herramientas (hacha y martillo)
  las vende el proveedor del Farol.

### Anti-bot y anti-AFK (desde el inicio)
- Entrenar contra un objetivo que no responde da progreso reducido tras X minutos.
- Recursos (vetas, árboles, peces) se agotan y regeneran.
- Rate limit de acciones y detección de patrones en el hito de lanzamiento.
- No hay anticheat en el cliente: todo se valida en el servidor y los bots se detectan
  por comportamiento. Las señales, los reportes y el log de economía están en T4.1, y el
  por qué en `01-architecture.md`, "Trampas y anti-bot".

Revisado en T4.1 (`server/internal/session/idle.go`):
- Los límites que ya había siguen igual y se complementan: `skills.afk` (10 min contra un
  objetivo que no responde → intentos al 25 %), `gathering.afk` (15 min recolectando sin
  moverse → 25 %), el intervalo mínimo de recolección y oficios
  (`gathering.use_interval_ms`) y el agotamiento de los recursos.
- **Desconexión por inactividad:** sin acciones reales durante `idle.kick_after_ms`
  (15 min) el servidor desconecta al jugador (`client.disconnect.idle`), después de avisar
  con un mensaje del sistema `idle.warn_before_ms` antes (1 min). Acciones reales, y solo
  si pasan de verdad: dar un paso, elegir un objetivo, lanzar un hechizo o una runa,
  mover o usar un item, decir algo en el chat, hablar con un NPC o elegir una opción,
  comprar, vender, recolectar y fabricar. No cuentan los pings, girar, mirar, cambiar de
  modo de combate, parar, cerrar ventanas ni una intención rechazada (caminar contra una
  pared, un item que no existe): es lo que mandaría un "keepalive".
- Nunca saca a alguien **en combate** (`travel.combat_block_ms`: le pegaron, recibió daño o
  pegó hace poco) ni sobre una **casilla sin logout**: lo vuelve a intentar cada segundo.
  Quien entrena contra un monstruo sigue en combate y no se desconecta; para eso está
  `skills.afk`.

Detección de bots (T4.1, `server/internal/antibot` y `session/antibot.go`; diseño, pesos y
umbrales en `01-architecture.md`, "Detección de bots"):
- El servidor mira **cómo** se juega, nunca el cliente: tiempos entre acciones del mismo
  tipo demasiado parejos, curas siempre a los pocos ms de un golpe, la misma ruta exacta
  una y otra vez, sesiones muy largas sin pausas, y experiencia u oro por hora muy por
  encima de los jugadores de su nivel conectados. Cada señal suma puntos a un puntaje de
  sospecha que baja solo con el tiempo (media vida de 1 h).
- Las respuestas son graduales: queda registrado, se avisa a los GM, el juego pide un
  **chequeo de presencia** (una pregunta simple, como "elige el color rojo", con 10 min de
  juego para contestar y sin interrumpir nada) y, si el puntaje sigue alto después de un
  chequeo fallado o una hora después de uno, una suspensión de 24 h. Nunca se pregunta en
  combate, en una zona sin logout ni a quien está ausente, y el plazo no corre mientras uno
  no juega. Un chequeo fallado suma puntos, pero no suspende por sí solo. Acertar no borra
  la sospecha (un programa también puede contestar): el chequeo sirve para avisar. A
  cualquiera le puede tocar un chequeo al azar de vez en cuando, sin consecuencias. El ban lo
  decide siempre un GM.
- Los umbrales son conservadores a propósito: un jugador que juega mucho, rápido o con
  macros de teclado legítimas no llega a avisar a los GM con una sola señal (el balance no
  carga si un peso solo lo permitiera). Hace falta un patrón sostenido de varias. En la
  prueba, un script tarda ~1 h 40 en llegar a la suspensión. Hábitos de un jugador real
  durante 6–8 h no pasan de quedar registrados: cada uno solo (ir y venir por click entre
  dos puntos, machacar un hotkey o apretarlo parejo, curarse rápido, entrenar magia a mano)
  y los pares probados (click, machacar y curarse rápido entre sí; click y curarse más
  rápido). Dos señales completas sostenidas sí avisan a los GM, a propósito.

## Combate
- Seleccionas un objetivo (click o hotkey) y el personaje ataca solo cada **2 s** si está
  en rango. Modos: ofensivo / equilibrado / defensivo, y perseguir / quedarse quieto.
- Daño físico: `skill_arma × ataque_arma × factor_modo × aleatorio` contra
  `armadura` (reducción plana aleatoria) y `defensa` (escudo y arma, bloquean por golpe).
  Fórmula exacta (T1.6, `server/internal/combat`, constantes en `balance.yaml`):
  `golpe_máx = (skill × ataque / skill_attack_divisor + nivel / level_divisor) × modo`,
  `golpe = aleatorio(0, golpe_máx) × (1 − resistencia física %)`; a un monstruo le restan
  `aleatorio(armadura/2, armadura)` y `aleatorio(0, defensa/2)`; a un jugador
  `aleatorio(armadura/2, armadura)` y `aleatorio(0, (escudo + arma) × modo_defensa /
  shield_block_divisor)` (solo ataques físicos). **Defensa del arma** (auditoría de
  contenido m3, 2026-11): la `weapon.defense` se mostraba y no hacía nada; ahora se suma a
  la del escudo (con escudo o sin él, contra monstruos y en PvP). Solo el escudo entrena la
  skill de escudo. Para que las primeras peleas sigan costando vida (la simulación de
  Puerto pide 10-40 %), el lobo, el murciélago y la gaviota pegan uno o dos puntos más.
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
  - Segunda área de cada mago (auditoría de contenido M5, 2026-11): la Isla Volcánica
    resiste el fuego (70-100) y el Bosque la tierra (20-80), así que el arcanista suma
    `tempest_ring` (energía, radio 2, nivel 28) a `ember_ring` y el druida `rime_burst`
    (hielo, radio 1, nivel 16) a `bramble_burst`.
  - Área (`radius`): cada monstruo del círculo (`dx² + dy² ≤ r² + r`) con línea de visión
    desde el que lanza tira su propio daño; lo que queda detrás de un muro no se toca.
  - Varitas: arma a distancia del Arcanista (y las varas del Druida); no entrenan skill ni
    gastan maná.
  - Runas: las conjura un hechizo de soporte; cualquiera con su nivel mágico las usa sobre
    una criatura o tile; comparten el cooldown de grupo de su hechizo, no el propio.
  - Monstruos: sus ataques `distance` y `spell` pegan a su objetivo dentro de `range` y con
    línea de visión, también mientras se acercan; con `area` pegan a todo un círculo o un
    rayo ("Monstruos", "Habilidades").
- **Distancia (T3.1, `server/internal/session/combat.go`):** un arma `weapon.type:
  distance` (arco) dispara a su objetivo dentro de `weapon.range` casillas y con línea de
  visión (los muros la cortan, `03-world-and-maps.md`), una vez por ronda de ataque. Cada
  disparo gasta una munición del slot de munición, que debe ser del `ammo.type` que pide el
  arma (`weapon.ammo`). Sin la munición correcta no dispara y el servidor avisa
  (`combat.no_ammo`). El golpe es físico, con la fórmula del cuerpo a cuerpo: skill de
  distancia y `ataque = arma + munición`, contra la armadura y la defensa del monstruo. Cada
  disparo entrena la distancia, acierte o no, con el mismo anti-AFK. Si persigue, se acerca
  solo hasta tener rango y visión. La flecha se consume: no queda en el suelo.
  - Los arcos son de dos manos y disparan flechas; las ballestas (auditoría de contenido
    M4) son de una mano, disparan virotes (`ammo.type: bolt`) y dejan la izquierda para el
    escudo: menos ataque que el arco de su escalón y más defensa. Sin chance de fallo
    propia: los ceros salen de la tirada y de la armadura, como en el cuerpo a cuerpo.
  - `conjure_arrows` ("tejer flechas") conjura 25 flechas por 35 de maná desde el nivel 3:
    un montaraz joven dispara lo que conjura su regeneración y no gasta en flechas más de
    lo que le da la caza. Los virotes se compran o se forjan (hierro y plumas de gaviota).
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
  | Saciado | `well_fed` | regeneración de la vocación +100 %, hasta 20 min | suma | sobrevive |
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
    su casilla: quien intente pisarla recibe `WalkRejected` (un camino por click vuelve y
    lo rodea) y los monstruos lo esquivan. Es una pista aceptada.
  - **Relogueo:** las de daño y `slowed` sobreviven a un logout con su tiempo restante
    (`characters.conditions`), para que salir del juego no cure; haste, invisibilidad y
    puntería son ventajas y terminan. **Morir** termina todas. La de otro jugador guarda
    también a su autor, y su tiempo sigue corriendo mientras la víctima está fuera (ver
    "PvP", "Daño").
  - **Fuentes:** `swift_stride` (haste 25 s, las cuatro vocaciones) y `purge_venom` (cura el
    veneno) desde nivel 8-9; `keen_eye` (montaraz), `entangle` (druida, `slowed` a un
    monstruo, o con PvP a un jugador, a 4 casillas), `shroud` (arcanista,
    invisibilidad). `ember_ring` puede dejar ardiendo y `arc_bolt` y `tempest_ring`
    electrizado. Comer da `well_fed` (el `food_ms` de la comida). La araña
    de musgo (escupitajo) y el escarabajo de mena (mordida) envenenan al hacer daño.
  - **Pendiente:** campos en el suelo (fuego o veneno) que apliquen condiciones al pisarlos
    (necesitan items con duración, disparar al entrar a la casilla y su render); items
    de cura (antídoto); que un jugador vea invisibles.
- Zonas de protección: no se puede atacar ni ser atacado. El PvP está en "PvP (T5.2)".

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
  varita dispara a distancia desde T1.9), el escudo de la izquierda y el arma la defensa
  (se suman, m3) y la suma de `armor` de todo el equipo la armadura del jugador contra
  golpes físicos.
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
  come y gasta una unidad, con `inventory.use_cooldown_ms` entre usos. Comer (auditoría
  de contenido m2) suma su `food_ms` a la condición `well_fed` (regeneración más fuerte,
  ver "Skills" y "Condiciones"), hasta su `max_ms` (20 min): la comida que solo alimenta
  y pasaría de ese tope se rechaza sin comerla ni gastar el cooldown ("Estás lleno"); la
  que además cura se come siempre y su tiempo se recorta. Las runas (T1.9) y las
  herramientas (T1.12) se usan sobre una criatura o casilla con `UseItemOn`.
- **Personaje nuevo:** empieza con `inventory.start_container` (una mochila vacía) en el
  slot de mochila. El kit de cada vocación llega con los diálogos (T1.10): al aceptar el
  capítulo 1, el capitán del puerto da un alfanje al guardián, una varita de chispa al
  arcanista (auditoría de contenido m5; antes, monedas), un arco corto y monedas para
  flechas al montaraz, y una vara de retoño al druida. El armero vende arcos, flechas y el
  chaleco de piel (para cualquier vocación: ninguna pieza de cuero está restringida, m6);
  el buzo vende las varitas, las varas y el brebaje de maná. En el Bosque las varas, las
  varitas y los brebajes los tiene la druida Velia (opción "¿Qué es este lugar?") y el
  resto la curtidora; en Brasal, el herrero y el templo (brebajes, cataplasmas, la varita
  de obsidiana y la vara de escarcha negra).
- **Escalones de equipo (auditoría de contenido M3, 2026-11):** cada línea de arma llega a
  la Isla Volcánica con su fuente (tienda, botín o receta): maza 15 → 23 (Bosque) → 28
  (Brasal), arco 7 → 12 → 17, ballesta 7 → 13, varita y vara 13 → 21 → 30; y cada slot
  crece con las islas: cabeza 1 → 2 (capucha de ciervo) → 3, piernas 1 → 2 → 3 (grebas de
  acero de ascua), pies 1 → 2 (botas de ciervo) → 3 (escarpes).
- **Límite conocido:** cada personaje guarda su inventario en su propio snapshot. Si A
  suelta un item, B lo levanta y se guarda, y el servidor cae antes del siguiente guardado
  de A, el item vuelve en ambos. Los items del suelo no se guardan ni desaparecen solos
  (salvo los restos). Guardado por item y decay de items soltados quedan para el trade y
  la muerte (T1.11) o un hito posterior.
- **Restos:** el botín de un monstruo queda dentro de sus restos (contenedor que no se
  puede levantar) y desaparece con ellos a los `combat.monster_corpse_ms`. Cada familia
  deja su cuerpo caído (`corpse` en `data/monsters`: la bestia de costado, el artrópodo
  panza arriba, el montón de escoria...); sin `corpse`, los restos por defecto
  (`creature_remains`, que es también el cuerpo de un jugador).

## Monstruos
- Definidos en `data/monsters/*.yaml`: stats, ataques (melee, a distancia, hechizos, con
  área o no; curarse e invocar), fases de jefe, resistencias, loot con probabilidades,
  experiencia, comportamiento.
- IA simple por estados: `idle → alerta → perseguir → atacar → huir (con poca vida)`.
  Implementada en T1.6 (`server/internal/session/monster.go`): en idle deambula dentro del
  radio de su spawn; los agresivos eligen al jugador más cercano a su vista (la ventana
  clásica de 15x11 + 1, no la vista ancha de los jugadores: "La vista") con línea de
  visión (alerta: se gira hacia él), lo persiguen (paso que más acerca; si no hay, A* con
  la cuota de pathfinding del tick, y siguen ese rodeo entero mientras el objetivo no se
  aleje más de una casilla de donde estaba: antes tomaban de nuevo el paso que más acerca
  desde la primera casilla del rodeo, que llevaba de vuelta al muro, y frente a un muro en
  U iban y venían para siempre, `TestChaseFollowsItsWayAroundAWall`; seguir el rodeo
  guardado no gasta búsquedas) y atacan pegados con los temporizadores de cada
  ataque. Con `flee_at_health_pct` se alejan; acorralados, pelean. Los pasivos solo
  responden si los golpean. No entran en zonas de protección ni atacan dentro de ellas.
  Solo piensan en sectores activos. En T1.6 solo hay ataques `melee`; `distance` y
  `spell` llegan con la magia (T1.9).
- **Habilidades** (`server/internal/session/abilities.go`, todo dato en
  `data/monsters`, formato en `06-content-data.md` "Monstruo"; 2026-11-18):
  - **Área** (`area` en un ataque `melee`, `distance` o `spell`): un **círculo** de
    `radius` casillas (`dx² + dy² ≤ r² + r`, como un hechizo de área) alrededor del
    monstruo (`center: self`, por defecto) o de su objetivo (`center: target`), cada
    casilla con línea de visión desde el centro (un muro tapa lo de atrás); o un **rayo**
    de `length` casillas en línea recta desde el monstruo hacia su objetivo, en la de las
    8 direcciones más cercana (recta si una diferencia es más del doble de la otra,
    diagonal si no; puede errarle a un objetivo que no está en línea: correrse de la línea
    lo esquiva), que se corta en la primera casilla que tapa la vista. Alcance (a qué
    distancia del objetivo lo usa): el radio de un círculo alrededor de sí, el largo de un
    rayo, y un círculo alrededor del objetivo como el ataque sin área (1 cuerpo a cuerpo,
    `range` si no), siempre con línea de visión al objetivo. Ese alcance, y en un círculo
    alrededor del objetivo ese alcance más el radio, no pasa de 6 (lo que nota un
    monstruo: más lejos dañaría a un jugador que ni lo conoce; `make validate` y el
    arranque lo rechazan). Un rayo o un círculo alrededor de sí no llevan `range` (su largo
    o su radio es su alcance; `make validate` y el arranque lo rechazan). Cuenta además la
    **forma**: un rayo solo alcanza a un objetivo en una de sus 8 líneas y sin una casilla
    que tape la vista antes, y un círculo alrededor de sí solo dentro de su área redonda
    (a radio 2, no la casilla a 2 y 2). Un área que no tendría a su objetivo adentro
    espera: no gasta su ronda ni cuenta como responderle (`TestMonsterAreaWaitsForItsTarget`).
    Y para la correa y la persecución no lo "alcanza" (`session.strikes`): antes, un
    dragoncillo en la esquina de su correa retenía a un montaraz a 4 al este y 2 al sur del
    otro lado de la lava, el rayo nunca le pegaba y cada ronda contaba como responderle, así
    que lo entrenaba a ritmo completo sin recibir daño; ahora lo suelta como cualquier
    monstruo y esos golpes entrenan como contra uno que no responde
    (`TestLeashAreaThatMissesHoldsNoTarget`). Pega a **cada jugador del
    área** que el monstruo ve (a un invisible solo si tiene `sees_invisible`), fuera de
    zonas de protección, cada uno con su tirada, el elemento del ataque (uno físico con
    armadura y defensa, como un golpe) y su condición. Nunca a monstruos ni NPCs. Los
    clientes reciben un `CreatureAttack` con el área (el rayo, como el círculo de su largo
    alrededor del monstruo) y un `Effect` del elemento en cada casilla (docs/05). Un área
    apuntada a un invisible (el círculo en su casilla, el rayo hacia él) solo la ven los
    que lo ven: si no, delataría dónde está.
  - **Bajo cierta vida** (`below_hp_pct` en cualquier ataque): lo usa solo mientras su
    vida está por debajo de ese porcentaje, y solo entonces cuenta su alcance (para la
    correa, "decide si te alcanza"): un lobo con un hechizo de 4 casillas para cuando le
    queda poca vida no "alcanza" antes a un montaraz al otro lado del agua, lo abandona
    como cualquier lobo en vez de quedarse 20 s de muñeco de entrenamiento
    (`TestLeashCountsOnlyTheAttacksInUse`).
  - **Curarse** (`type: heal_self`, `min`–`max`): solo peleando (con objetivo, aunque no
    lo tenga a su alcance) y herido; a vida llena la ronda espera sin gastarse. Efecto de
    curación, número verde y barra de vida para quien lo ve (una curación que sale 0, con
    `min: 0`, muestra el efecto sin número, como la de un jugador).
  - **Invocar** (`type: summon`, `summon: {monster, count, max_alive}`): `count` criaturas
    en casillas libres junto a él (con el efecto de conjurar), nunca más de `max_alive`
    vivas a la vez (si ya están todas, la ronda espera sin gastarse: cuando muere una,
    llama otra en cuanto pasó su `interval_ms` desde el último llamado; al custodio, una
    ronda por minuto, una salamandra muerta se le repone hasta 60 s después).
    Pelean contra su objetivo y comparten su spawn (su correa y su casa), pero **no dan
    experiencia, botín ni restos, no cuentan para quests ni reportes y no reaparecen**: un
    jefe que invoca no es una granja. Se van (`DESPAWN`) cuando muere o se rinde (correa)
    el que las llamó, y también cuando se queda sin objetivo sin rendirse (su objetivo
    murió, salió del juego, se metió en una zona de protección o salió de su vista): no
    esperan en la guarida al próximo que entre; él conserva sus heridas. Una criatura invocada no puede invocar (`make validate` y el
    arranque lo rechazan: no tendría tope).
  - **Fases** (`phases`, para jefes): cada una está activa mientras la vida está por
    debajo de su `below_hp_pct`, todas las alcanzadas a la vez. Sus `attacks_add` se suman
    a los ataques, su `speed_mult` multiplica la velocidad (se avisa con `CreatureSpeed`) y
    su `attack_interval_mult` cada intervalo de ataque. Entrar en una fase muestra el
    efecto de condición sobre el monstruo; curado por encima (o al rendirse) la fase
    termina.
  - **Contenido** (pedido del dueño, auditoría 2026-11-18): el dragoncillo de ascua escupe
    fuego en un rayo de 4; el custodio de escoria golpea el suelo (círculo de 1 alrededor,
    fuego, deja ardiendo), bajo el 60 % llama a dos salamandras de brasa (como mucho dos,
    una ronda por minuto) y bajo el 30 % se enfurece (×1,3 velocidad, ×0,75 intervalos);
    el gólem de escoria y el espinoso estallan alrededor (círculo de 1) y la esquirla del
    minero de obsidiana revienta sobre su objetivo y sus vecinos (círculo de 1 en el
    objetivo). Un grupo pegado sufre las áreas: conviene abrirse. **Ojo (para el dueño):**
    el estallido del gólem y del espinoso reemplazó su hechizo a distancia (`range: 3`):
    ahora su alcance es 1, así que un montaraz o un mago que les pega desde lejos ya no
    recibe ese hechizo (solo los alcanza quien está pegado). Si se quiere que sigan
    castigando a distancia, se vuelve a sumar el hechizo como otro ataque (y se revisa su
    balance: los duelos de `foe_test.go` ponen al cazador pegado y no lo miden).
  - **Balance:** los duelos de los tests de balance (`server/internal/sim/foe_test.go`)
    simulan las habilidades: las fases, `heal_self`, `below_hp_pct` y las invocaciones, que
    el cazador mata primero (no dan nada) mientras le pegan. En un duelo el cazador está
    pegado al monstruo, así que un área le pega como un ataque a él: los números de los
    monstruos comunes no cambian. El custodio pasó a 1800 de vida y 0–60 cuerpo a cuerpo
    para seguir en 30–90 s y 60–200 % de la vida a nivel 44 (71,6 s y 170 %; antes 71,2 s
    y 162 %).
- Spawns en el mapa con radio, cantidad y tiempo de respawn. El respawn no ocurre si un
  jugador está dentro de la ventana clásica de 15x11 + 1 alrededor del punto (evita
  aparecer en la cara; no la vista ancha: "La vista", "Respawns"): se reintenta cada 5 s.
- **Correa** (`balance.yaml combat.monster_leash_tiles`, 6; 0 o sin la clave = sin correa,
  el comportamiento anterior). El **área de casa** de un monstruo es el radio de su spawn
  (distancia Chebyshev al centro); su **área de correa**, ese radio más
  `monster_leash_tiles`. Con correa:
  - Solo elige objetivos dentro de su área de correa, y nunca sale de ella persiguiendo ni
    huyendo (si huyendo llega al borde, acorralado pelea, como siempre).
  - Si su objetivo queda fuera del área de correa y fuera del alcance de sus ataques, lo
    cambia por otro: el más cercano de los que lo hirieron y puede pelear (a la vista,
    dentro de su correa o a su alcance) o, si es agresivo y no hay ninguno, el que
    elegiría. Lo hace sin curarse ni olvidar quién lo hirió: que el que tenía el aggro
    salga del área no le quita la pelea, la experiencia ni el botín de quest al resto del
    grupo, ni sirve para sabotearlo (`TestQuestDropKeptWhenTheHolderStepsOut`). Solo si
    no queda nadie lo suelta: recupera toda la vida, se le terminan las condiciones (una
    quemadura no sigue sumando daño), olvida el daño recibido de todos (nadie cobra
    experiencia por esa pelea) y vuelve caminando a casa. Un objetivo fuera del área pero
    a su alcance (un jugador pegado al borde, o a tiro de un ataque a distancia) se sigue
    peleando desde adentro.
  - Tampoco hay lugares seguros dentro del área. Mientras su objetivo está fuera de su
    alcance, una vez por `combat.monster_path_retry_ms` (1 s), dé pasos o no, el monstruo
    busca un camino a pie hasta él que rodee criaturas y no salga del área de correa. Solo
    encontrarlo (o tener al objetivo a su alcance) reinicia la cuenta: un paso que no lleva
    a ningún lado, como seguir por su orilla a un arquero que camina por la otra, no
    cuenta (`TestLeashGivesUpATargetWalkingAlongTheShore`). Sin camino durante
    `combat.monster_stuck_ms` (2 s):
    - si tampoco lo hay atravesando criaturas (del otro lado de agua, o detrás de un muro
      cuyo rodeo sale del área), lo trata como fuera de la correa: lo cambia por otro o se
      rinde, igual que arriba;
    - si solo criaturas tapan el paso (un NPC, un muñeco o un jugador quieto en la boca de
      un rincón pueden no moverse nunca), se vuelve contra un jugador al que sus ataques
      llegan desde donde está, normalmente el que tapa; si no hay ninguno, lo trata igual
      como inalcanzable (`TestLeashCreatureInTheWay`).
    Un objetivo dejado así cuenta como fuera de la correa para ese monstruo durante
    `combat.monster_shun_ms` (30 s), **solo en esa casilla** y fuera de su alcance: no lo
    elige, cada golpe suyo lo hace soltarlo (y curarse si no queda nadie) y entrena como
    contra un objetivo que no responde (`TestLeashGivesUpATargetItCannotReach`). En otra
    casilla es un objetivo como cualquiera: si tampoco se llega, vuelve a costar los 2 s
    (`TestLeashShunsATile`); a los 30 s vence (`TestLeashShunExpires`). Cuando la
    persecución no encuentra camino, espera 1 s antes de volver a buscar (como el regreso
    a casa): no gasta en cada tick la cuota de búsquedas de los demás monstruos.
  - Sin objetivo (lo soltó, o el jugador murió, salió, entró a una zona de protección o se
    perdió de vista), si está fuera de su área de casa vuelve caminando hacia el centro del
    spawn a su velocidad, en vez de deambular, hasta entrar en ella (sin curarse en ese
    caso; si en el camino ve a alguien dentro de su correa, lo puede atacar). Da el paso
    que más acerca; contra un muro o agua busca un rodeo (A*, con la cuota del tick) y lo
    sigue entero. Si no hay camino, espera ahí (`monster_path_retry_ms` entre búsquedas):
    nunca se teletransporta.
  - Un golpe desde fuera de la correa lo hace responder como siempre, pero enseguida
    suelta a ese objetivo (por otro que lo pelee desde adentro, o se rinde y se cura); una
    condición (quemadura, veneno) cuyo autor está
    fuera de la correa y de su alcance se termina en su siguiente golpe sin hacer daño (solo
    esa: si otro jugador lo está peleando adentro, la pelea sigue igual). No se puede matar
    a un monstruo desde fuera de su correa. Tampoco sirve de muñeco: los golpes de un jugador que
    está fuera de su correa y de su alcance entrenan como contra un objetivo que no
    responde (`skills.afk.factor`).
  - Por qué: en los corrales de la Isla de Pruebas (radio 2, con una abertura al sendero
    común) los lobos, jabalíes y arañas perseguían al jugador por el sendero y nada los
    devolvía: el sendero se llenaba de monstruos que mataban a quien pasaba. La correa los
    deja salir unas casillas por la abertura y los devuelve; vale para todo el mundo, no
    solo para la isla de pruebas.

## Muerte
Valores iniciales (balance.yaml):
- Pierdes **10 %** de la experiencia total y **10 %** del progreso de cada skill (sin
  bajar del nivel 1 ni de skills base).
- Cada pieza equipada tiene **10 %** de chance de caer al cuerpo; la mochila cae con
  **100 %** salvo con bendiciones.
- **Bendiciones** (hasta 5, se compran con oro del juego a NPCs en templos):
  cada una reduce la pérdida; con las 5 no pierdes items y la pérdida de XP baja a ~3 %.
  Las venden los tres templos (la hermana Liora en el Farol, Raigal y Brasal), cada una a
  **50 monedas más 20 por nivel** del que la compra (auditoría de contenido M6: el precio
  fijo de 200 no era nada para un nivel alto; nivel 9: 230, nivel 30: 650, nivel 50: 1050),
  y solo desde el nivel 9 (auditoría de contenido m8: hasta el
  `novice_max_level` ya se muere como con las cinco, así que antes se desperdiciaban); las cinco son `shore_light`, `hearth_light`, `keel_light`, `star_light`
  y `deep_light`. Se pierden al morir. El precio es dato del diálogo (`bless: { price,
  per_level }`, docs/06) y cada opción lo muestra (`{price}`). Se guardan en `quest_state` como `bless.<id>` (no se vende dos veces
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
- **Mochila nueva:** si la mochila cayó al cuerpo, reapareces con una vacía
  (`inventory.start_container`) en su slot; la vieja, con todo lo que llevaba, sigue en el
  cuerpo (se recupera arrastrándola o abriéndolo). Sin un contenedor no se puede tener ni una
  moneda ni levantar nada, así que no habría forma de comprar otra (hallazgo M5 de la
  prueba exploratoria). La nueva entra al log de economía como `death` con ref
  `new_backpack`. Además los proveedores (Puerto y la Isla de Pruebas) venden mochilas
  (20 de cobre) para tener una de repuesto.
- Niveles 1–`novice_max_level` (8): protección de novato: pagan como si tuvieran las 5
  bendiciones (pérdida mínima de XP y skills, sin drop).
- El cuerpo (`creature_remains`, contenedor) queda `corpse_ms` en el suelo con lo que cayó;
  durante `corpse_owner_only_ms` solo el dueño puede sacar, usar o meter algo en él (otros
  pueden abrirlo y mirar), también tras una muerte por PvP. Con marca de asesino o
  proscrito se pierde más ("PvP", "Castigo").
- **La muerte termina el combate:** al despertar en el templo ya no hay bloqueo de logout
  ni de barco (abajo); un bloqueo PvP que tuviera sigue hasta que vence.

### Bloqueo de logout en combate
La muerte es el riesgo del juego (`00-vision.md`, "Muerte como Tibia"): cerrar el juego en
medio de una pelea no la evita. Código: `server/internal/session/linkdead.go`.
- **En combate** quiere decir: durante `travel.combat_block_ms` (12 s) desde la última vez
  que un monstruo atacó al jugador (aunque falle; también su área, "Habilidades", aunque
  el jugador no sea su objetivo), que el jugador recibió daño (también de
  veneno o fuego, de un monstruo o de otro jugador, también en la arena) o que le pegó a un
  monstruo o a un jugador; o mientras dura su bloqueo PvP ("PvP", "Castigo"). Es la misma
  ventana que impide zarpar ("Viajes en barco"), la desconexión por inactividad y los
  chequeos de presencia.
- **Salir del juego en combate** se rechaza con `combat.logout_locked` ("Estás en
  combate: todavía no puedes salir del juego. Espera unos segundos lejos de la pelea.");
  con el bloqueo PvP, con `pvp.logout_locked`, como antes. La conexión sigue y el jugador puede volver a
  intentarlo cuando la pelea termine.
- **Cerrar la conexión en combate** (cerrar la pestaña o el juego, perder la red, un cliente
  lento que el servidor corta, un reseteo de contraseña) no saca al personaje: queda en el
  mundo sin conexión ("link-dead"). No actúa (suelta su objetivo, se para, lo que su
  conexión haya mandado después no se ejecuta y su intercambio se cancela), pero se lo
  puede atacar, los monstruos lo siguen teniendo de objetivo y sus condiciones siguen
  corriendo; cada golpe renueva el bloqueo. Cuando el bloqueo vence, se guarda y sale.
- **Tope de link-dead:** aunque los monstruos sigan peleando con él, sale a los
  `travel.link_dead_max_ms` (2 min) de quedar link-dead, con su guardado final (si no, un
  spawn débil que no le hace daño a un personaje fuerte lo tendría en el mundo para
  siempre). El bloqueo PvP no tiene tope: lo retiene hasta que vence, como antes. `0` en
  el balance quita el tope.
- **Nadie lo juega:** link-dead no sube skills (los golpes que recibe no entrenan escudo)
  ni cuenta como activo para la experiencia compartida del grupo (recibir golpes no es
  ayudar: pasados `party.contribution_ms` de su último aporte con conexión, no cobra parte
  de las muertes de su grupo). Regenera vida y maná como cualquiera.
- **Morir link-dead** paga lo mismo que cualquier muerte (experiencia, skills, equipo al
  cuerpo, bendiciones) y el personaje sale del mundo en ese momento, con un solo guardado
  (el de la muerte, que es su guardado final). Si todavía lo retiene un bloqueo PvP, espera
  en el templo a que venza, como antes. Al volver a entrar, el jugador ve la pantalla de
  muerte con lo que perdió (salvo que el servidor se haya reiniciado entretanto). Una
  derrota en la arena estando link-dead (no cuesta nada) se avisa igual al volver a entrar
  con `pvp.arena_defeat`, sin tapar el aviso de una muerte.
- **Volver a entrar** mientras está link-dead retoma ese mismo personaje, como un relogueo
  (posición, vida, condiciones y la pelea: el logout sigue bloqueado hasta que vence); nunca
  hay dos en el mundo.
- **Lo que saca en el acto igual:** una expulsión o un ban del staff, un guardado que falló
  (T5.3) y el apagado del servidor (que guarda a todos, también a los link-dead).
- Una zona de protección **no** corta el bloqueo (tampoco el PvP): quien se refugia en un
  templo espera ahí a que venza, a salvo.

## Economía
- Monedas de oro, plata, cobre (100:1): `gold_coin` vale 10 000 cobre y `silver_coin` 100
  (T5.5; antes solo existía el cobre). Todo precio, recompensa y saldo se cuenta en cobre
  (`currency.worth`). **Pagar** toma primero las monedas chicas y, si no alcanzan, rompe
  una grande y devuelve el vuelto en la menor cantidad de monedas; **cobrar** (ventas,
  recompensas, retirar del buzón del mercado) da siempre la menor cantidad de monedas.
- **Vuelto:** un pago que rompe una moneda solo se hace si el vuelto entra en la mochila
  (huecos y capacidad, sin contar los que libera el pago: conservador); si no, se rechaza
  sin cambiar nada (`dialog.no_change_room`). Vale para tiendas (que además reservan lugar
  para lo comprado), mercado, intercambio de casas, alquiler, fundar un gremio, viajes,
  bendiciones y todo `take_gold` de un diálogo. El log de economía y la cuadratura de T4.1
  cuentan cada moneda por su valor.
- NPCs compran y venden con precios en `data/npcs/*.yaml`. Los NPCs compran barato
  para que el comercio entre jugadores tenga sentido.
- **Nada lleva a ningún lado** (auditoría de contenido m4, regla de `make validate`): lo
  que un NPC compra se puede conseguir; un arma, armadura o escudo con valor que se puede
  conseguir tiene un NPC que lo compra, y un material con valor, un comprador, una receta
  o una quest que lo pide; un item de quest (no comerciable) cae solo como botín
  `each_player`, así deja de caer como basura cuando la quest terminó. Por eso los
  saqueadores sueltan el garrote de deriva, el armero compra la espada corta forjada, la
  piedra tosca (500 g, 1-2 por golpe de veta) y el cuarzo, el herrero de Brasal la piedra,
  la curtidora la hoja de espino, y la tarja, el cofre sellado y la carta del minero salen
  solo a quien los necesita.
- **Brebajes de maná** (auditoría de contenido M2, 2026-11): el combustible de los magos.
  El brebaje (50 de maná, 22 cobre) lo venden el buzo de Puerto, la druida del Bosque y el
  templo de Brasal (24); el concentrado (125, 50 cobre) solo Brasal. Nadie los compra de
  vuelta. Un mago que caza con brebajes gasta en ellos alrededor del 60 % de su botín
  (`sim/balance_vocations_test.go`). Antes de la progresión de hechizos (2026-11) eso lo
  hacía subir más rápido que el guardián, que juntaba más oro. Ahora el guardián también
  puede comprarlos para sus golpes y su cura: con ellos gasta lo mismo (~60 % del botín
  desde el nivel 20) y sube a la par de los magos (~35 h del 1 al 50, contra ~34 h del
  arcanista y ~32 h del druida; del 30 al 50 hasta un poco más rápido que el arcanista, que
  en un duelo no luce sus áreas). Sin brebajes de maná tarda ~13 % más (~39 h, lo que
  tardaba antes de tener hechizos) y llega igual al nivel mágico de todos sus hechizos
  ("Vocaciones"). La diferencia de oro ya no es de vocación sino de cuánto gasta cada uno en
  brebajes: comprarlos es una elección, no un peaje.
- **Brebajes de vida** (progresión de hechizos, 2026-11): la cataplasma de algas (40 de
  vida, 25 cobre, ~0,6 por punto) servía del nivel 1 al 60. El brebaje de vida (110, 60
  cobre) lo venden la druida y el mercader del Bosque y el templo de Brasal; el concentrado
  (250, 125 cobre) solo Brasal: ~0,5 cobre por punto, entre la cataplasma y el maná. Como
  los de maná, se venden por isla (el Puerto se queda con la cataplasma: un novato no
  compra una cura del doble de su vida) y nadie los compra de vuelta. En la carrera
  simulada, quien baja de un tercio de su vida toma el más grande que no se desperdicia.
  Las carreras que compran brebajes de maná casi nunca llegan ahí: sus curas, alimentadas
  con brebajes de maná, las mantienen arriba y por menos cobre por punto de vida (la cura
  del guardián al nivel 20: ~36 de vida por 30 de maná, ~13 cobre en brebajes, ~0,37 por
  punto). Los brebajes de vida son de quien se cura sin maná: el guardián que no compra
  brebajes de maná toma el de vida del 12 al 29 y el concentrado desde el 30, y su caza los
  paga (como mucho 75 % del botín; entre ellos y la comida gasta del 17 al 59 % según la
  franja). Donde más sirven es en grupos y contra golpes fuertes, cuando una cura por
  segundo no alcanza, y eso la simulación de duelos no lo mide.
- Sumideros de oro: bendiciones, viajes en barco, reparaciones, recetas de oficio, la
  fundación de un gremio, la comisión del mercado y el alquiler de las casas (T5.4).
- Log de economía para detectar duplicación y bots.

Mecánicas de comercio entre jugadores conocidas del género; reglas, números y textos
propios (`balance.yaml → trade` y `→ market`, docs/06).

### Intercambio directo (T5.3)
- Dos jugadores **adyacentes** (misma planta, a una casilla, diagonal incluida). Uno invita
  desde la lista de batalla; el otro acepta o rechaza. La invitación vence a los
  `request_ms` (25 s).
- Cada uno ofrece items de sus contenedores (no lo equipado): solo `tradeable`, la pila
  entera o un contenedor **vacío**, hasta `max_items` (6) por lado. Se puede ofrecer oro
  (las monedas son `tradeable`).
- **Confirmación doble:** el intercambio se hace cuando confirmaron los dos. Cualquier
  cambio en una oferta (agregar, quitar, que un item ofrecido se mueva o cambie de
  cantidad) o un paso de cualquiera de los dos anula las dos confirmaciones.
- Se cancela si se alejan, si uno muere, si uno entra en combate PvP (bloqueo PvP), si uno
  se desconecta o si alguno es del personal del juego. Personal del juego no intercambia.
- No se confirma un intercambio sin nada ofrecido de ningún lado, y las acciones del
  intercambio tienen anti-flood propio (`action_burst` / `action_refill_ms`): cada
  intercambio completo guarda a los dos personajes enteros.
- **Atómico:** el servidor revisa que a cada uno le entre lo que recibe (lugares de la
  mochila y capacidad, contando lo que entrega) y mueve las instancias en el mismo tick;
  si a alguno no le entra, se cancela sin mover nada. Lo recibido va a la mochila.

### Mercado global (T5.3)
- Se usa en un **tablero del mercado** de cada ciudad (Puerto, Raigal y, desde la
  auditoría de contenido m7, Brasal), parado junto a
  él; alejarse cierra la ventana. Es uno solo para todas las islas.
- **Ofertas de venta:** las unidades salen de la mochila y quedan en depósito. **Ofertas de
  compra:** cantidad × precio sale en monedas y queda en depósito. Cada oferta tiene
  cantidad (hasta `max_amount`), precio por unidad (hasta `max_price`) y duración (12, 48
  o 120 horas): al vencer se cierra sola.
- **Comisión:** crear una oferta cuesta el 2 % de cantidad × precio, con mínimo 5 y
  máximo 50 000 monedas (auditoría de contenido m13: el tope de 4000 se alcanzaba con 200k
  de valor, y una venta absurda entre dos cuentas propias salía casi gratis). Se destruye (sumidero) y queda en el log de economía (`market`,
  ref `fee`). No se devuelve al cancelar.
- **Aceptar** una oferta es inmediato y parcial (cualquier cantidad hasta la que queda):
  quien acepta paga o entrega en el momento y recibe en el momento (si le entra; si no,
  no pasa nada). Lo que le toca al dueño de la oferta (oro o items) va a su **buzón del
  mercado**, aunque esté desconectado, y lo retira en cualquier tablero. Cancelar o
  vencer devuelve el depósito al buzón. Retirar entrega primero los items, en orden,
  mientras entren, y después todo el oro que entre; el resto espera en el buzón.
- **Límites:** `max_offers` (15) ofertas activas por personaje; solo items `tradeable`
  que no son moneda; sin contenedores con algo adentro; las runas, solo con todas sus
  cargas; los apilables, por unidades. Un personaje no acepta ofertas de su propia cuenta.
- **Lo que se ve:** al buscar un item, sus mejores `list_size` ofertas de venta (más
  baratas primero) y de compra (mejor pago primero), sus propias ofertas, el buzón, su
  historial (lo que compró y vendió) y un **precio de referencia**: cada cuenta vendedora
  vota una vez por día, con su precio medio por unidad de ese día, y la referencia es la
  mediana de los votos de los últimos `reference_days` días (con un número par, la menor).
  No cuentan las ventas entre dos cuentas que se vendieron una a la otra en la ventana (en
  los dos sentidos) ni las de cuentas suspendidas, como vendedoras o compradoras (también
  después de reiniciar, aunque ya no tengan ofertas: el servidor carga todas las
  suspensiones vigentes). Con menos de `reference_min_votes` (3)
  votos, de `reference_min_sellers` (2) cuentas vendedoras distintas o de
  `reference_min_accounts` (3) cuentas en total (vendedoras y compradoras) no hay
  referencia ("Sin precio de referencia"). Es solo informativo. Por qué así (auditoría de
  contenido m13): con el promedio, una venta absurda entre dos cuentas propias la inflaba;
  con la mediana por unidad, 2000 unidades a 1 moneda vendidas a otra cuenta propia la
  hundían por 40 de comisión; por voto y con mínimos, dos cuentas propias que se venden
  entre sí en días distintos juntaban 3 votos de 2 vendedores por 3 comisiones. Ahora dos
  cuentas no alcanzan nunca: se venden una a la otra (no cuenta) o una sola vende (un
  vendedor). Lo que todavía se puede: con tres cuentas propias en anillo (A le vende a B,
  B a C, C a A) se arma una referencia mientras nadie más venda ese item, y con más
  cuentas se superan los votos de los vendedores reales de un item con poco comercio; por
  eso es solo una guía (el formulario la propone, nadie está obligado a usarla). La
  calcula el loop una vez por item y día; se recalcula con cada venta, con cada suspensión
  o levantamiento y cuando vence la suspensión de una cuenta que dejó afuera. El
  intercambio directo no paga comisión ni cuenta para la referencia.
- **Ventana en vivo:** la ventana abierta se actualiza sola cuando otro jugador cambia lo
  que muestra: una oferta nueva, cancelada, vencida o llenada en el item que se está
  mirando; una oferta propia que otro llenó (y el oro o los items que llegan al buzón);
  el buzón que cambia por una casa (alquiler, traspaso o casa liberada); una suspensión
  que oculta o vuelve a mostrar ofertas; y el dinero y los items propios tras un
  intercambio directo. Un libro muy activo actualiza cada ventana como mucho cada
  `push_every_ms` (500 ms); un cambio dentro de ese tiempo sale al terminar, con el libro
  como esté entonces. Lo que ya escribió el jugador en los formularios no se borra, y el
  precio que propone el formulario (el de referencia cuando se abrió ese item) no cambia
  mientras se mira el mismo item: nadie publica a un precio que no eligió. El vencimiento
  de una suspensión no avisa: se ve en la siguiente acción.
- **Seguridad:** el personal del juego no usa el mercado. Una cuenta suspendida no opera
  y sus ofertas no se listan ni se pueden aceptar mientras dure la suspensión. Anti-flood
  propio (`action_burst` / `action_refill_ms`). Comandos de staff auditados:
  `/marketoffers Nombre` (lista las ofertas de un personaje) y `/marketcancel id` (retira
  una oferta; su depósito va al buzón del dueño). El anti-bot (T4.1) puede leer el log de
  economía (`market`, `trade`), pero esta tarea no lo cambia.
- **Falla segura:** si un cambio del mercado o un intercambio no se pudo guardar (un bug o
  la base caída al apagar), sus personajes salen del juego con un aviso y no pueden
  entrar hasta que el servidor reinicie, y el mercado y el intercambio quedan en solo
  lectura (se puede mirar, no operar) hasta entonces. Al reiniciar, esos personajes
  vuelven a su último guardado escrito (pierden lo jugado desde ahí). Salvo en una caída
  o con la base caída al apagar (docs/01), ese guardado no es anterior a lo que soltaron
  al suelo fuera de una casa: si un personaje tiró algo a la calle (o el servidor se lo
  dejó a los pies) desde su último guardado, su estado del final de esa acción se guarda
  antes de su próximo intercambio, compra, venta, retiro del buzón o cambio en una casa,
  sin que se note.
  Para que nada de lo que recibieron llegue a otro antes del aviso, después de cada
  intercambio, compra, venta, retiro del buzón o cambio en una casa el personaje queda
  **en espera** hasta que la base confirma ese guardado (normalmente uno o dos ticks):
  no puede soltar nada en el suelo fuera de una casa (aviso "Espera un momento…",
  `inventory.saving`), y si muere en ese tiempo, nadie más saca ni mete nada en su
  cadáver hasta la confirmación (ni después, si el guardado falló). Un cadáver de antes
  de la espera sigue las reglas de siempre.
  Lo que en ese instante cae a sus pies porque no le entra (una fabricación, una
  recompensa, las monedas de una venta a un NPC, el equipo que no cupo en su cadáver)
  queda reservado para él de la misma forma: otro jugador recibe "Eso es de otro jugador
  por ahora." (`inventory.not_yours`). El suelo de las casas lo cuida el guardado: lo
  que se movió ahí no llega a la base por otro. Lo que alguien saca de una casa a la
  calle queda reservado para él de la misma forma hasta que la base confirma ese cambio
  de la casa, un momento: solo él puede volver a tomarlo o devolverlo a la casa. Sale
  como una pila aparte: no se suma a la pila de otro ni entra en una mochila o un cadáver
  ajeno de la calle ("Para sacarlo de la casa, déjalo primero en el suelo.",
  `inventory.floor_first`), así la reserva nunca se queda con lo de otro. Las alertas de
  economía (T4.1) siguen como red (docs/01, "Transacciones").
- Una oferta de un item retirado del juego se cierra al arrancar: el oro de una de
  compra vuelve al buzón.
- **Fuera de alcance:** subastas, mercado entre servidores y tienda cosmética (T5.7).

## Casas (T5.4)
Mecánica conocida del género (casas del mapa que se alquilan); reglas, números, nombres y
textos propios. Números en `balance.yaml → houses` (docs/06); cada casa (casillas, puertas,
alquiler) es un dato del mapa, `world/islands/<isla>/houses.yaml` (docs/03).

- **Qué es una casa:** un área del mapa con nombre, pueblo (su isla), casillas por piso,
  una o más **puertas** (casillas de la casa donde se entra) y una **salida** afuera,
  junto a una puerta. Hoy hay 13 (auditoría de contenido M6: eran 6): seis en el Farol
  (Puerto), cuatro en Raigal (Bosque) y tres en Brasal (Volcánica), de 21 a 38 casillas.
  **Alquiler por tamaño y pueblo:** casillas × 60 monedas en Puerto, × 90 en el Bosque y
  × 120 en la Volcánica por semana (de 1260 a 3840; antes 500-1000, unos minutos de caza);
  lo vigila `packages/content-schema/src/house-rent.test.ts`. Las casas son **zona de
  protección**: sin combate y sin PvP (T5.2), y salir del juego adentro es seguro.
- **Alquilar:** se usa la puerta (click derecho) y se abre la ventana de la casa; mirar la
  puerta dice de quién es o que está libre, con su precio. Elegimos la puerta y no un NPC
  o un tablero: es lo más simple (no hay diálogo ni item nuevo) y se ve la casa antes de
  alquilarla; la lista de todas está en el sitio (`/houses`). Pide nivel `min_level` (12)
  y se paga **por adelantado** un período de `period_days` (7 días) con el oro de la
  mochila. Con la ventana se puede pagar más períodos por adelantado, hasta `max_periods`
  (4) por delante.
- **Renovación sin estar conectado:** al vencer, el servidor cobra el período siguiente
  del **oro del buzón del mercado** del dueño (T5.3): ahí llega lo que vende en el
  mercado, y el servidor lo puede cobrar aunque no esté. Si no alcanza, la casa se libera.
  **Dueño ausente** (auditoría de contenido M6): si ningún personaje de la cuenta del dueño
  entró ni salió del juego en `houses.inactive_days` (28) días, al vencer el alquiler la
  casa se libera aunque el buzón tenga oro (los objetos van al buzón, como siempre). Lo
  pagado por adelantado se respeta: la casa se pierde recién al vencer. El aviso: cada vez
  que el dueño entra al juego, un mensaje le recuerda la regla (`house.away_warning`). El
  loop guarda la última entrada o salida de la cuenta; al arrancar la toma del último
  login o guardado de cualquier personaje de la cuenta (`characters.last_login_at` y
  `last_save_at`, que se escribe al salir y en cada autoguardado). Nunca cuenta desde antes
  de `house_owners.away_from`: las casas ya alquiladas cuando llegó la regla (migración
  00018) la tienen en ese momento, así nadie la pierde por una ausencia anterior a la
  regla ni sin haber podido ver el aviso. **El servidor apagado no es ausencia:** al
  arrancar, el tiempo desde el último guardado de cualquier personaje (≈ el apagado, o
  más si el servidor estuvo vacío antes) se suma a la última vez visto de cada dueño, una
  sola vez y sin pasar de ahora. **La base caída tampoco:** el servidor la consulta cada 30 s
  (`app/houses.go` `heartbeat`, `World.StoreAlive`); si faltan tres respuestas, no se
  libera ninguna casa por ausencia (nadie puede entrar), y cuando vuelve a contestar, ese
  hueco se suma igual que un apagado. Un aviso por email antes de perderla queda pendiente.
  No agregamos un "fondo de la casa" aparte: sería un segundo buzón de oro con sus propias
  reglas, y pagar por adelantado desde la ventana ya cubre a quien no usa el mercado.
- **Una casa por cuenta** (no solo por personaje): con pocas casas por pueblo, una cuenta
  con varios personajes no puede acapararlas. La base lo garantiza (`account_id` único).
- **Sumidero:** todo alquiler se destruye y va al log de economía (`house`, ref `rent`).
  Al dejar la casa, lo pagado no se devuelve.
- **Acceso:** pasan la puerta el dueño, los invitados (lista por nombre de personaje, hasta
  `max_guests`, 20) y, si el dueño lo activa, los miembros de su gremio. Los demás no
  entran (el paso a cualquier casilla de la casa se valida en el servidor), y quien queda
  adentro sin permiso (lo sacaron de la lista, dejó el gremio, la casa cambió de dueño o
  se liberó) sale por la puerta a la salida en el acto o, a lo sumo, en un segundo. Quien
  entra al juego dentro de una casa a la que ya no tiene acceso aparece en la salida; con
  acceso, en su casilla o, si está ocupada, en otra de esa casa unida a pie con ella o en
  la calle de la salida (nunca en otra casa ni donde no se llegue caminando desde su
  casilla, ver "Puertas con llave", "Nadie aparece adentro sin pasar la puerta"). El
  personal del juego entra a cualquier casa. Desde la ventana de la casa (que se abre a
  hasta 3 casillas de una puerta) quien tiene acceso puede **entrar** (lo lleva a una
  casilla libre adentro, junto a la puerta) y quien está adentro, **salir** (a la salida):
  nadie puede encerrar al dueño afuera ni a sus invitados adentro parándose en la puerta.
- **Dejar y transferir:** el dueño puede dejar la casa o ofrecerla a otro personaje
  conectado por un precio (puede ser 0); la oferta espera `transfer_minutes` (10) a que el
  otro la acepte en la puerta, con el nivel y la regla de una por cuenta. El que acepta
  manda el precio que vio: si el dueño lo cambió, la aceptación se rechaza. El precio va al
  buzón del dueño; lo pagado del alquiler sigue con la casa; la lista de invitados y el
  gremio se borran.
- **Objetos adentro:** lo que se deja en el suelo de la casa o en contenedores sobre él
  **persiste entre reinicios** (la excepción a "el suelo vive en memoria", docs/01). Límite:
  `items_per_tile` (3) × casillas instancias por casa (una pila cuenta una vez; un
  contenedor, una más cada objeto de adentro). Solo el dueño y los invitados mueven
  objetos adentro; desde afuera nadie alcanza el suelo de la casa. **Los invitados pueden
  traer y acomodar objetos y abrir contenedores, pero no sacarlos** (ni a su mochila ni
  afuera) ni gastarlos (comer, usar runas): así invitar a alguien no le abre el depósito
  del dueño. Lo que un invitado deja es de la casa. Lo que cae al suelo por otra vía (una
  compra con la mochila llena) no cuenta para el límite.
- **Al liberarse** (dejarla, falta de pago, transferencia o staff) todos los objetos van al
  **buzón del mercado** del dueño, en la misma transacción que libera la casa: no se pierde
  nada. Los contenedores van **aplanados** (el contenedor vacío y cada cosa de adentro en
  su propia fila; una runa con sus cargas), así nada es demasiado profundo o pesado para
  retirarlo. Se retiran en cualquier tablero del mercado; lo que no entra (por peso o lugar)
  espera sin trabar lo que viene después.
- **Anti-flood** propio (`action_burst` / `action_refill_ms`) para las acciones de la casa
  y para mover objetos dentro de ella: cada movimiento guarda la casa y al que lo movió.
- **Falla segura (T5.3):** si algo no se pudo guardar, las casas quedan en solo lectura
  hasta reiniciar: no se alquila ni se paga, nada entra ni sale de una casa, no se usan
  sus objetos, nada de las casas se escribe y el cobro automático se detiene.
- **Staff:** `/house`, `/houseevict` y `/housemove` (tabla de Moderación), auditados.
- **Fuera de alcance:** subastas de casas, decoración especial y casas de gremio.

## Mundo e islas (estructura inicial)
| Isla | Nivel sugerido | Rol |
|---|---|---|
| Isla del Puerto (inicial) | 1–15 | Tutorial, primera ciudad, Capítulo 1 |
| Isla del Bosque (T3.6) | 10–30 | Druidas, bestias, leñador (olmo), Capítulo 2 |
| Isla Volcánica (T5.5) | 25–60 | Herrería avanzada (acero de ascua), dragones jóvenes, Capítulo 3; ciudad: Brasal |
| Islas Heladas | 40–80 | Hielo, mazmorras profundas |
| Isla Hundida | 70+ | Ruinas del imperio antiguo, final de la historia actual |

- Viaje entre islas: NPC capitán de barco, cuesta oro, requiere nivel o quest para
  algunas rutas (ver "Viajes en barco").
- Cada isla tiene superficie (piso 7), subterráneos (8–12) y alturas (6–4).

### Tutorial (T4.2)
- **Quién lo ve:** solo un personaje nuevo cuya isla de origen es la del tutorial (Puerto,
  `data/tutorial.yaml → island`): nivel 1, sin experiencia y sin estado de tutorial. Un
  personaje recién creado no tiene `town` y su isla de origen es la de inicio del servidor
  (`-start-town`, o la primera de `world.yaml`), la misma cuyo templo lo recibe; en un
  servidor que hace empezar en otra isla, nadie ve el tutorial. Un
  personaje que existía antes del despliegue ya tiene experiencia o niveles y no lo ve
  nunca. No hay isla de novatos aparte: la vocación se elige al crear el personaje y el
  tutorial ocurre en el pueblo del Farol.
- **Recorrido (original):** caminar unos pasos desde el templo del Farol, hablar con la
  sacerdotisa, abrir la mochila, elegir una criatura del puerto como objetivo, lanzar el
  primer hechizo (solo arcanistas y druidas, que tienen uno de nivel 1), derrotarla y
  aceptar el encargo de Maren Holt, la jefa del puerto: el tutorial termina cuando empieza
  la primera quest del Capítulo 1 (`ch1_shipwreck`). Los pasos se numeran entre los de la
  vocación del personaje.
- **Nunca bloquea:** es un panel de pistas sin teclas ni overlay, que se oculta mientras
  hay un diálogo, una tienda o una estación abiertos; todo lo que pide es juego normal. Un
  paso que ya se cumple cuando le toca (la mochila ya abierta, el objetivo ya elegido, el
  objetivo muerto por el primer hechizo) se salta solo. Se puede saltar en cualquier momento (botón del panel) y no vuelve.
- **Sin ventajas:** al terminarlo da 20 monedas (dato en `rewards`, tope 1000 en el
  esquema); saltarlo no da nada.
- **Autoridad:** el servidor guarda el paso y lo avanza con sus propios eventos (caminar,
  hablar, abrir un contenedor, fijar objetivo, lanzar, matar, empezar una quest...). El
  cliente solo muestra el texto y puede pedir saltarlo.
- No hacen falta NPC guía ni carteles nuevos: la sacerdotisa y Maren Holt ya están en el
  recorrido y Puerto ya tiene carteles en el templo y el muelle.

### Viajes en barco (T3.5)
Rutas en `data/boat_routes.yaml` (formato en `06-content-data.md`); números en
`balance.yaml → travel`.
- Se viaja hablando con el capitán (a ≤ 3 casillas, como todo diálogo): su ventana lista
  cada ruta que vende desde su muelle. El viaje es instantáneo: no hay barco que navegue
  ni tiempo de viaje.
- Al elegir una ruta, el servidor revisa, en este orden, y si algo falla no cambia nada y
  dice por qué: **combate** (`travel.in_combat`), **nivel** mínimo, **quest**
  completada, **item** requerido (o pasaje), **oro** y **llegada libre**.
- **Regla de combate (decidida):** no se zarpa **en combate**, la misma ventana que bloquea
  el logout ("Bloqueo de logout en combate"): durante `combat_block_ms` (12 s) desde la
  última vez que un monstruo atacó al jugador (aunque falle), que el jugador recibió daño
  (también de veneno o fuego, de un monstruo o de otro jugador) o que le pegó a un monstruo
  o a un jugador; o mientras dura su bloqueo PvP.
  La marca no se guarda en la base, pero salir no la borra: en combate no se sale del
  juego, y quien cierra la conexión queda link-dead y al volver la retoma ("Muerte",
  "Bloqueo de logout en combate"). La muerte la termina.
- **Llegada:** la casilla `to` de la ruta; si está ocupada, la libre y caminable más
  cercana a ≤ `arrival_radius` (2) casillas, nunca una casilla de casa (como la llegada por
  un portal; un teleport de diálogo tampoco deja a nadie en una casa). Si no hay ninguna,
  se rechaza (`travel.no_room`) sin cobrar. La casilla `to` misma (y el destino de un
  teleport de diálogo) nunca es de una casa ni una puerta con llave colocada abierta: ni el
  servidor arranca ni pasa `make validate` (docs/03 "Validación"), igual que un extremo de
  portal en una casa.
- **Cobro atómico:** todo se comprueba antes; luego el jugador se mueve, se consume el
  pasaje (si `consume: true`) y se paga el precio. El vuelto de una moneda grande va a la
  mochila: si no entra (huecos o capacidad), el viaje se rechaza antes de zarpar sin cobrar
  nada (`dialog.no_change_room`, como todo pago con vuelto: ver "Economía").
- Quienes lo veían en el muelle lo ven desaparecer y quienes están en la llegada lo ven
  aparecer (mismo movimiento que el teleport de staff). El cliente funde el mapa a oscuro
  con "Zarpaste hacia {isla}…".
- **Grupo:** cada miembro viaja por su cuenta (pagando y cumpliendo los requisitos).
  Viajar todos juntos cuando zarpa el líder queda pendiente: necesita que cada miembro
  acepte el cobro, no es solo una regla.

### Puertas con llave
Servidor en `server/internal/session/door.go`; las puertas y llaves son items
(`data/items/doors.yaml`, formato en `06-content-data.md`).
- **Puertas:** una puerta es un par de items del mapa con bloque `door`. La cerrada
  (`door.open`: el item en que se convierte) bloquea el paso y la vista; la abierta
  (`door.closed`) no bloquea nada. Se usa con click derecho, a `inventory.reach` (1)
  casilla y en el mismo piso: la cerrada se abre y la abierta se cierra, para todos (el
  servidor cambia el item del mapa y manda la casilla a quien la ve; caminar, el
  pathfinding y la línea de visión lo ven en el acto). No se levantan ni se mueven.
- **Con llave:** la cerrada puede llevar `door.key`, un id de llave. Una llave es
  cualquier item con `key: <id>`; varios items pueden compartir un id (por ejemplo, la
  copia que da un NPC). **Decisión:** se abre *usando la puerta con la llave encima*
  (equipada o en cualquier contenedor; no se gasta), no usando la llave sobre la puerta:
  es un click en vez de dos y no obliga a buscar la llave en la mochila. Sin ella, desde
  afuera: "Está cerrada con llave". La llave abre de los dos lados.
- **Abierta, pasa cualquiera:** así un grupo entra detrás de quien tiene la llave.
  **Cerrarla con llave** también pide la llave; sin ella la puerta queda abierta. Nadie
  sin llave puede dejar a otros afuera ni adentro.
- **No cierra sobre algo:** ni con una criatura ni con items en su casilla.
- **La sala de atrás:** al arrancar, el servidor recorre a pie cada lado de cada puerta
  con llave (8 direcciones, mismo piso, sin cruzar esa puerta), hasta 4096 casillas por
  lado. Las **demás puertas con llave cuentan como muro** (aunque estén abiertas en el
  mapa) y las puertas sin llave como abiertas, si su casilla deja pasar (suelo caminable y
  nada más que bloquee el paso salvo puertas). Un lado que no termina es terreno abierto:
  el de afuera. Si todos terminan, el más grande es el de afuera. Los demás son la
  **sala** de la puerta. Así una **puerta doble** (dos puertas con llave juntas en la
  misma pared) comparte una sala: cada una toma a la otra como muro. Como los muros no
  cambian, la sala se calcula una vez; el servidor guarda de cada casilla de una sala a
  qué sala pertenece, así que usar la puerta cuesta una búsqueda en un mapa, no un
  recorrido.
- **Sala que no se puede determinar = error:** el servidor no arranca, y `make validate`
  lo rechaza antes (misma regla, mismo recorrido; los dos leen los casos de
  `packages/map-format/src/testdata/door-rooms.json`), con una puerta con llave
  amurallada (ninguna casilla a su alrededor deja pasar), con un solo lado (está en campo
  abierto: se la rodea), con más de un lado sin terminar (la sala sería más grande que
  4096 casillas) o, si todos terminan, con los dos lados más grandes del mismo tamaño (no
  está claro cuál es el de afuera). También se rechaza una puerta con llave que, abierta,
  no deja pasar a nadie (en su casilla hay algo más que bloquea el paso, como un muro, o
  el suelo no es caminable): su sala solo se dejaría por un camino que el chequeo de
  escape no ve. Y una puerta con llave sobre un extremo de un portal (sale de su casilla o
  llega a ella; una puerta colocada abierta es caminable): pisarla movería a alguien más
  allá de la puerta aunque otro la trabara, y llegar a ella deja a alguien en la puerta.
- **Sala compartida:** varias puertas con llave pueden dar a la misma sala (una puerta
  doble, o un edificio con puerta delantera y trasera), pero solo si tienen **la misma
  llave**: la llave de una abriría las dos desde adentro. Si no, el servidor no arranca y
  `make validate` lo rechaza. Una sala dentro de otra vale cuando la de adentro es más
  chica que la del medio: cada puerta tiene su sala, y sus llaves pueden ser distintas.
- **Chequeo de escape:** con todas las salas calculadas, el servidor (y `make validate`,
  con el mismo cálculo y los mismos casos de `door-rooms.json`) numera las **áreas** del
  mapa: las casillas unidas a pie (8 direcciones, un piso) con las puertas con llave, las
  casas (una casa no es calle) y las entradas de escaleras, agujeros y teletransportes
  como muro (nadie se para ni pasa caminando sobre ellas: quien las pisa se va), y las
  demás puertas abiertas si su casilla deja pasar. Cada sala es un área. Un jugador **sin
  llaves ni herramientas** va de la sala de una puerta a cada lado de esa puerta (se abre
  desde adentro) y, por un portal que no pide nada (escalera, escalera de mano, agujero,
  teletransporte), a la de su destino: desde el área de su casilla si es una escalera de
  mano (se usa parado ahí), y si se pisa, desde las áreas de las casillas de al lado y
  desde la sala de una puerta con llave de al lado (se abre desde adentro y se pisa el
  portal desde la puerta). Un punto de soga no cuenta (pide una soga, que no es del equipo
  inicial) ni un portal `boat` (no mueve a nadie). El **mundo** son las áreas de los
  templos. Una llegada de barco no es mundo: es una entrada, no una salida (zarpar pide
  capitán y lo que pida la ruta: oro, nivel, quest, ticket). Si contara, una bóveda con
  una llegada pasaría, y quien se colara en ella desde la sala de adelante quedaría
  encerrado cuando otro trabara la puerta desde la sala. Es más estricto que el pedido
  original, que contaba las llegadas como mundo; en el mapa de hoy no cambia nada. Se
  exige:
  - **que cada lado de cada puerta con llave llegue al mundo** así. Si no, quien esté ahí
    podría quedar encerrado. Es el caso de una bóveda más grande que la sala que tiene
    delante: la puerta de la bóveda la toma por su afuera, las dos puertas comparten la
    sala del medio (desde el medio se abriría la bóveda sin llave) y la bóveda no está en
    ninguna sala, así que a quien está adentro lo podrían trabar. Lo mismo con una antesala
    entre el mundo y una bóveda de más de 4096 casillas, o con un afuera que solo se une al
    mundo a través de una casa, un barco, un punto de soga o un pasillo de una casilla que
    es la entrada de un teletransporte (o de una escalera) a otro lado. Un teletransporte
    (o una escalera) que sale de la bóveda y lleva al mundo, o un portón propio de la
    bóveda al campo, la arreglan;
  - **que nadie entre a una sala sin su llave.** Un jugador con todas las llaves menos la
    de una sala, que puede estar en cualquier lugar fuera de las salas (un relogueo lo deja
    donde guardó) o dentro de una casa (es su dueño o un invitado) y cruza con sus llaves
    las puertas de otra llave hacia su sala (también la que está junto a una casilla de
    una casa, desde la casa), no tiene que llegar a esa sala. Llegaría si una puerta de
    otra llave da a ella (es su afuera) desde su propia sala y a esa sala se llega: un
    ciclo de puertas de llaves distintas.
    Por ejemplo, un edificio con la puerta delantera al campo y la trasera a un patio con
    su propio portón al campo, el portón con otra llave: con la llave del edificio se
    entra, se abre la trasera desde adentro y se sale al patio, que es la sala del portón,
    y el portón se abre sin su llave. Lo mismo si la sala de una puerta solo se toca desde
    una casa: un invitado con su llave sale de la casa a esa sala, la cruza y llega a la
    sala de una puerta de otra llave.

  Así **los ciclos de puertas de una misma llave valen** (ese edificio con su patio; un
  hall entre el campo y una bóveda con su propio portón al campo) y la cadena sala–puerta–
  hall–puerta–bóveda, con la bóveda más grande que el hall, se sigue rechazando. Las áreas
  cubren el mapa entero, así que no hay cota de distancia entre los afueras de dos puertas
  que comparten sala. Cuesta poco: las áreas se numeran una vez al arrancar (`07`).
- **La sala no guarda nada de afuera:** ni el templo (donde se despierta), ni NPCs, ni
  casas (casillas o salida), ni extremos de portales (escaleras, agujeros...: se llegaría
  detrás de la puerta, o se saldría por un camino que la sala no conoce), ni llegadas de
  barco, ni destinos de un teleport de diálogo. Si una sala tiene algo de eso, o se tomó
  el lado de afuera por la sala, o alguien llegaría detrás de la puerta: ni el servidor
  arranca ni pasa `make validate`. Los spawns sí pueden estar en una sala: la forja guarda
  a su custodio detrás del portón.
- **Nadie queda encerrado:** desde la sala, una puerta trabada se abre siempre, con o sin
  llave ("Descorres el cerrojo desde adentro"). Así sale quien volvió a entrar al juego
  adentro con la puerta trabada (otro la cerró mientras no estaba, o hubo un reinicio) y
  quien perdió la llave adentro. Desde afuera sigue haciendo falta la llave. Además, la
  puerta no se cierra con llave mientras haya en la sala un jugador conectado sin la llave
  ("Alguien sin la llave quedaría encerrado"): encerrar a alguien no es una jugada que
  tenga quien lleva la llave. Para eso el servidor mira solo a los jugadores de los
  sectores de la sala y corta la búsqueda de la llave en cuanto la encuentra.
- **Nadie aparece adentro sin pasar la puerta:** cuando el servidor busca una casilla
  libre por anillos alrededor de un punto (entrar al juego sobre una casilla ocupada,
  despertar en el templo, la llegada de un barco o de un portal, un teleport de diálogo o
  del personal, salir de una casa), solo acepta casillas del **área** del punto (la del
  chequeo de escape). Los anillos no siguen las paredes: sin esto, con unas pocas casillas
  ocupadas junto al portón (en la forja bastaban unas 11), quien guardó su posición afuera
  aparecía adentro y, como desde adentro se abre sin llave, le abría a todos; y un templo
  lleno podía dejar a alguien en un bolsillo cerrado por paredes o del otro lado de una
  escalera. Si el punto no está en ningún área, la búsqueda queda donde podría caminar un
  jugador parado ahí:
  - **la entrada de una escalera, un agujero o un teletransporte:** solo las áreas de al
    lado, las únicas a las que se llega caminando desde ahí;
  - **una casilla de casa** (entrar al juego donde se salió, un `/tp` del personal): las
    casillas de esa casa unidas a pie con el punto (su **área de casa**: las casillas de
    una casa con sus paredes y puertas, numeradas aparte; no son áreas del chequeo de
    escape, donde una casa sigue siendo muro) y el área de la salida de la casa (la calle
    a la que sale quien está adentro). Nunca otra casa, otra parte de la misma casa
    separada por una pared ni un bolsillo cerrado del otro lado de la pared;
  - **una puerta con llave** (abierta o cerrada: quien salió del juego parado en el umbral
    abierto; o un `/tp` del personal a la puerta abierta, porque uno a una puerta cerrada,
    que no es caminable, se rechaza): solo su lado de **afuera**, las áreas de al lado que
    no son su sala. Nunca el umbral (taparía la puerta abierta) ni la sala: quien estaba
    ahí venía de afuera o de la sala, que desde adentro se abre sin llave hacia afuera;
    entrar a la sala pide la llave, así que la búsqueda nunca termina adentro. Quien
    guardó la posición en el umbral entra al juego junto a la puerta, afuera, aunque la
    puerta se haya cerrado después (antes iba al templo). Lo mismo con una puerta común
    cerrada después (al reiniciar, toda puerta vuelve a como la dibuja el mapa): está en
    el área de sus dos lados, así que entra junto a ella, de cualquier lado. La salida de
    una casa y el templo nunca están sobre una puerta con llave, abierta o cerrada (ni el
    servidor arranca ni pasa `make validate`): con todo lleno, quien sale de la casa o
    despierta queda en esa casilla misma, y desde el umbral daría un paso a la sala sin la
    llave. Tampoco sobre una puerta común: cualquiera la puede cerrar, y el último recurso
    lo dejaría dentro de una puerta cerrada;
  - **cualquier otra casilla** (un muro, ninguna casilla): ninguna. La búsqueda no
    encuentra lugar y vale el último recurso de quien la pidió (el templo, la salida de la
    casa, el rechazo del `/tp` o del teleport) en vez de adivinar.
  - **Por qué así y no "el área alcanzable más cercana":** no adivina. Cada punto fuera de
    las áreas que el juego puede pedir (una casa, una puerta, un portal) tiene su regla, y
    el resto no deja a nadie en ningún lado. Un `/tp` a una casilla caminable cae siempre
    en una de las tres primeras (toda otra casilla caminable está en un área).
- **Ritmo:** un jugador usa una puerta como mucho cada `inventory.door_cooldown_ms`
  (500 ms, "Espera un momento"), la abra, la cierre o se lo rechacen: un rechazo también
  cuenta, así sus chequeos (la llave, la sala) corren a ese ritmo y no al del gateway.
  Otros jugadores la pueden usar mientras.
- **Estado:** vive solo en el mapa en memoria. Un reinicio deja todas las puertas como
  están en el mapa: cerradas y trabadas (una puerta colocada abierta queda abierta otra
  vez; `make validate` lo advierte). Los monstruos no abren puertas, pero pasan por una
  abierta.
- **Límites conocidos:**
  - el cálculo de la sala no sigue escaleras ni portales: recorre un solo piso (el chequeo
    de escape sí los sigue). Una puerta cuyo lado de afuera sea un pasillo chico con una
    escalera podría tomar ese pasillo por la sala: el servidor no arranca y `make validate`
    lo rechaza porque la sala tendría un extremo de portal. Igual conviene revisar una
    puerta nueva con un test como `TestForgeGateOnTheMap`;
  - una puerta **sola** con una sala de más de 4096 casillas detrás y un afuera que
    termina antes (más chico) toma el afuera por la sala. Si ese afuera tiene templo,
    NPCs, casas, portales o llegadas, el servidor no arranca y `make validate` falla (la
    sala no guarda nada de afuera); si no, casi siempre lo frena el chequeo de escape: la
    sala de verdad, tomada por afuera, no llega al mundo salvo que tenga un portal de
    salida o un templo. Hoy no pasa (la forja tiene 463 casillas y
    la mina 1729). Marcar el lado de adentro en los datos quedaría para cuando haga falta;
  - el chequeo de llaves supone que un jugador puede estar en cualquier área fuera de las
    salas, también en una bóveda a la que solo se llega por una sala, y en cualquier casa:
    es conservador y podría rechazar algún diseño seguro rebuscado (puertas de otra llave
    dentro de esa bóveda que den a otra sala);
  - una escalera de mano solo cuenta desde el área de su casilla, aunque se use desde más
    lejos (`inventory.reach`, con línea de visión); y un portal cuyo destino es la entrada
    de otro que se pisa no lleva a ningún área en el chequeo (la llegada sí cae en las
    áreas de al lado). Los dos casos son conservadores: a lo sumo rechazan un diseño
    seguro;
  - la llave se puede repetir: quien terminó `ch3_gate` y no la lleva encima pide otra al
    eco, así que tirarla al piso y pedir otra da llaves de más, y una llave tirada la puede
    levantar cualquiera. Lo aceptamos: quien tiene la llave ya puede abrirle la puerta a
    quien quiera, y la llave no se vende ni se comercia (`tradeable: false`). Una llave
    tiene que poder levantarse (el validador lo exige).
- **Mapa:** una puerta se coloca como cualquier item (`place_item`, la paleta del editor,
  que muestra de cada puerta y de cada llave su id de llave). La llave es del tipo de
  item, no de la casilla: el formato de chunks no tiene atributos
  por casilla (`03-world-and-maps.md`), así que una puerta con otra llave es otro par de
  items. Elegimos esto frente a un id por casilla (como hace Tibia) porque mantiene el
  contenido como datos y no cambia el formato de mapas ni `world.bin`. El
  validador de mapas cuenta las puertas como abiertas al medir el alcance desde el templo,
  no deja poner un item de puerta en una casilla de puerta de una casa (usarlo abriría
  la puerta y nunca la ventana de la casa) ni dos items de puerta en una casilla (cada
  uno reclamaría el uso y la llave); el servidor tampoco arranca con eso.
- **Hoy:** la puerta de la forja (`forge_gate` / `forge_gate_open`, piso 8 de la Isla
  Volcánica, 3692,5832) se abre con la llave de ascua (`ember_key`) del Capítulo 3.

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

**Capítulo 2 "Raíces" (T3.6, Isla del Bosque).** Lo da Velia Musgo, la druida de Raigal,
a quien terminó el Capítulo 1. Dos quests encadenadas, todo en datos
(`data/quests/ch2_*.yaml`, `data/npcs/bosque_druid.yaml`):
1. `ch2_roots` (nivel 15): matar 8 sapos de ciénaga, juntar 6 hongos lumbre (botín de sapos
   y espinosos), entregarlos a la druida y preguntarle al barquero dónde atracó el bote sin
   bandera. 3500 XP y 300 monedas.
2. `ch2_coffer` (nivel 20): romper el campamento de contrabandistas (8), entregar 4 tarjas
   de contrabandista y recuperar el cofre sellado del nido de los reptantes huecos, en la
   cueva bajo la costa este. 9000 XP, 600 monedas y el flag `ember_root_found`. El cofre
   guarda una raíz de piedra tallada con las marcas del imperio, tibia: la llave que lleva
   al Capítulo 3 (la forja antigua).
- **Bestiario del Bosque** (nivel objetivo de `TestBosqueBalance`): ciervo de zarza (11,
  pasivo, huye), sapo de ciénaga (13, escupe veneno a distancia), contrabandista del cofre
  (16, cuchillos a distancia), espinoso (20, estallido de espinas alrededor, débil al fuego) y reptante
  hueco (24, cueva, mordida venenosa, ve invisibles). Con el equipo del pueblo un guardián
  pasa de 15 a 20 en ~2,3 h y de 20 a 25 en ~3,1 h.
- **Oficios en el Bosque:** el olmo (`elm_tree`) se tala como el abedul y da troncos de
  olmo (y resina desde woodcutting 4). Recetas: escudo de olmo en el yunque y caldo de
  hongo lumbre en el fogón; la curtidora Gisla vende el equipo de cuero de ciervo y la hoja
  de espino.

**Capítulo 3 "Fuego bajo la piedra" (T5.5, Isla Volcánica).** Lo da Casia Hollín, la
guardiana de los registros de Brasal, solo a quien tiene el flag `ember_root_found` del
Capítulo 2. La raíz de piedra es un item (`ember_root`, no comerciable): Velia Musgo la
entrega en Raigal a quien tiene el flag, una a la vez y hasta abrir la puerta de `ch3_gate`
(si se pierde, se pide otra). Casia y el herrero piden la raíz encima; sin ella, Casia
manda a buscarla a Raigal. Tres quests encadenadas, todo en datos (`data/quests/ch3_*.yaml`,
`data/npcs/volcan_*.yaml`):
1. `ch3_embers` (nivel 30): matar 10 sabuesos de ceniza, juntar 6 escamas de salamandra,
   entregarlas a Casia y mostrarle la raíz a Bram Tizón, el herrero, que reconoce la marca
   de la forja antigua. 14 000 XP y 800 monedas.
2. `ch3_gate` (nivel 35): matar 10 mineros de obsidiana, conseguir un plano de galería
   (botín de los mineros), entregarlo a Casia y bajar hasta la puerta sellada, en lo más
   hondo de la mina, donde el eco de la forja toma la raíz y le devuelve su forma: la
   **llave de ascua** (`ember_key`, no comerciable), que abre la puerta (ir a un lugar y
   abrir = hablar con el eco con la raíz encima). 22 000 XP y 1100 monedas. Quien terminó
   `ch3_gate` y no tiene la llave (la perdió, o terminó antes de que existiera) le pide
   otra al eco, una a la vez.
3. `ch3_warden` (nivel 40, la da el eco): derrotar al custodio de escoria (jefe, sale solo
   en la forja antigua, detrás de la puerta sellada: se entra abriéndola con la llave de
   ascua, ver "Puertas con llave"; en grupo desde el 40, solo desde el 44 y curándose),
   y llevarle a Casia el sello de la forja.
   36 000 XP, 2000 monedas y el flag `lost_expedition_lead`: el sello señala al norte, por
   donde salió la expedición perdida del Capítulo 4 ("Silencio blanco", Heladas; no
   implementado). El sello es botín de quest (`each_player`, auditoría de contenido m9):
   a cada uno de los que le hicieron daño al custodio y tienen la quest en ese paso le
   llega el suyo a la mochila (o a los pies si no entra); quien lo pierde antes de
   entregarlo (al morir, al tirarlo) recibe otro del próximo custodio. Antes salía uno por
   muerte y un grupo de cinco esperaba cinco respawns de 20 minutos. Con la correa
   ("Monstruos"), si el que tiene el aggro sale de su área de correa y de su alcance, el
   custodio pasa a otro del grupo que lo pelee desde adentro sin curarse ni olvidar: el
   sello sigue siendo de todos los que lo hirieron
   (`TestQuestDropKeptWhenTheHolderStepsOut`). Solo si no queda nadie suelta la pelea y
   olvida quién lo hirió: el sello es para los que le hagan daño después
   (`TestQuestDropForgottenWhenTheWardenGivesUp`).
- **Bestiario de la Isla Volcánica** (nivel objetivo de `TestVolcanBalance`): sabueso de
  ceniza (27, velocidad 300: no se le escapa, no huye), salamandra de brasa (31, escupe brasa a distancia y deja
  ardiendo, inmune al fuego), minero de obsidiana (35, mina, lanza esquirlas que revientan sobre su objetivo y sus vecinos), gólem de
  escoria (41, mucha armadura, inmune al fuego, estalla alrededor) y dragoncillo de ascua (50, cráter,
  aliento de fuego en un rayo de 4 que deja ardiendo). Jefe: custodio de escoria (44, 1800
  de vida, golpe de escoria alrededor, dos salamandras bajo el 60 %, furia bajo el 30 %;
  pelea de 30–90 s que pide curarse o ir en grupo; "Monstruos", "Habilidades"). El fuego
  es la norma: todos resisten fuego y
  el hielo los daña más. Con el equipo de Brasal un guardián pasa de 25 a 30 en ~3,8 h, de
  30 a 40 en ~10,4 h y de 40 a 50 en ~15,2 h (el test pide 0,4–1,2 veces el `pace`).
- **Herrería avanzada:** la veta de ascua (`ember_vein`, minería, el mineral de ascua sale
  desde minería 8) y el botín de mineros y gólems dan mineral de ascua. En la fragua, 3
  minerales + 1 lingote de hierro + 1 tronco de olmo (del Bosque: las islas comercian) dan
  un lingote de acero de ascua (herrería 10). En el yunque: yelmo (herrería 12, nivel 30),
  sable (13, nivel 30), hacha (14, nivel 32), coraza (16, nivel 34), escudo (17, nivel 36),
  cota de escamas de dragoncillo (20, nivel 45) y hoja de colmillo de dragoncillo (22,
  nivel 45). El ataque sigue el +4 por escalón de Puerto y Bosque (27–31), así que el PvP
  (escalado a `damage_pct`) no cambia de forma. Bram Tizón vende las primeras piezas de
  acero de ascua y compra los materiales de la isla a un tercio de su valor.
- **En el mapa** (`world/islands/volcan`, T5.5 parte 2): Brasal al oeste (templo de la Llama
  Quieta, plaza con fragua, yunque y fogón, el archivo de Casia y una casa), muelle al oeste
  con Nerea Vado. Se llega desde Raigal (`bosque_to_volcan`, nivel 25, 150 monedas) y se
  vuelve al Bosque (100) o al Puerto (140). Sabuesos en el llano de ceniza al norte,
  salamandras en la ladera de piedra al sureste, dragoncillos en el cráter amurallado al
  noreste; la mina (piso 8, escalera al este del pueblo) tiene la galería de los mineros al
  oeste, la de los gólems al este (con vetas de ascua) y, al sur, la puerta sellada con el
  eco y detrás la forja antigua con el custodio (respawn de 20 min). La puerta sellada
  (`forge_gate`, 3692,5832) cierra el pasillo de la forja y se abre con la llave de ascua
  que da el eco (ver "Puertas con llave"). La isla es PvP abierto (el default de T5.2) salvo el templo y
  la plaza (protección); sin arena. Música y ambiente propios (`music_volcan`: un tambor
  lento, un yunque lejano y una melodía en re frigio dominante; `amb_volcan`: retumbo,
  burbujas de lava, crujidos y vapor). Suelos propios: llano de ceniza, losas de basalto
  en la plaza, caminos de escoria, ladera y cráter de lava enfriada con pozos de lava
  fundida que no se pisan (manchas irregulares, no rectángulos), y tres carteles (templo,
  muelle y mina) que se leen mirándolos; un cuarto, junto a la puerta con llave del piso 8,
  avisa que solo pasa quien trae su llave.
  Los suelos nuevos se caminan como los que reemplazaron, así que el ritmo con que se
  balanceó la caza no cambia: la ceniza (140) como la tierra del llano, la lava enfriada
  (100) como la piedra de la ladera y el cráter, el basalto (100) como piedra; solo los
  caminos de escoria (110) son más rápidos que la ceniza que cruzan.
- **Monedas:** las recompensas y precios de este nivel (miles de cobre) se pagan en plata y
  oro (ver "Economía"), así que caben en una mochila normal.

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
  susurrar 1×1, decir 7×5 (la pantalla clásica de 15x11, no la vista ancha: "La vista"),
  gritar 18×14. Fuera de ese rectángulo no se oye nada. Quien habla siempre recibe su
  propia línea.
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
- Canal de grupo (T3.3): ver "Grupos". Canal de gremio (T5.1): ver "Gremios". Fuera de
  alcance: privados persistentes.

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

## Gremios (T5.1)
Números en `data/balance.yaml` (`guild`), nunca en código. Código:
`server/internal/session/guild.go` (reglas puras en `server/internal/guild`). Los gremios
son pocos y simples a propósito: lo que no está acá no existe.

- **Fundar:** un personaje sin gremio, de nivel `found_min_level` (18) o más, paga
  `found_cost` (2000 en cobre, o sea 20 de plata). Ese oro se destruye: es un sumidero de la economía
  (fuente `guild` del log de economía). El fundador es el líder.
- **Nombre:** de `name_min` a `name_max` caracteres (3–24), de 1 a `name_max_words` (4)
  palabras de letras ASCII (al menos dos por palabra) separadas por un espacio; la primera
  empieza con mayúscula ("Faro del Norte"). Único sin importar mayúsculas. No puede
  contener (sin espacios, en minúsculas) ninguna parte de `reserved_parts` (hacerse pasar
  por el staff o el juego, y palabras ofensivas) ni tener como palabra una de
  `reserved_words`. El staff puede renombrarlo (ver "Moderación").
- **Rangos y permisos.** Tres rangos; los permisos dependen solo del rango:

  | Acción | Líder | Vicelíder | Miembro |
  |---|---|---|---|
  | Invitar y retirar invitaciones | sí | sí | no |
  | Cambiar el mensaje del día | sí | sí | no |
  | Expulsar | a cualquiera | solo a miembros | no |
  | Promover a vicelíder / degradar a miembro | sí | no | no |
  | Pasar el liderazgo | sí | no | no |
  | Disolver | sí | no | no |
  | Salir | no (primero pasa el liderazgo o disuelve) | sí | sí |

  Como mucho `max_vice_leaders` (4) vicelíderes. Al pasar el liderazgo, el líder anterior
  queda como vicelíder si hay lugar, y como miembro si no.
- **Invitaciones:** a un personaje **conectado**, por nombre (no hace falta verlo). Una
  invitación sobrevive al logout y vence a las `invite_hours` (36 h) del reloj del juego.
  Un gremio tiene como mucho `max_invites` (15) pendientes. El invitado acepta o rechaza
  desde el panel (o `/guild accept Gremio`); al entrar a un gremio se borran sus otras
  invitaciones. Invitar dice si alguien está conectado: se acepta, y cada intento cuenta
  para el anti-flood. Un invisible que el que invita no ve cuenta como desconectado (como
  en `/report`). La lista de miembros sí muestra en línea a un miembro invisible: sus
  compañeros de gremio lo saben igual.
- **Límite:** `max_members` (50) miembros contando al líder; lleno, nadie más acepta.
- **Mensaje del día:** hasta `motd_max` (160) caracteres, limpiado como el chat. Solo lo
  ven los miembros (no la página pública).
- **Disolver:** el líder escribe el nombre del gremio para confirmar. Se borran miembros e
  invitaciones; el nombre queda libre.
- **Chat y presencia:** canal `GUILD` ("Gremio"): lo oyen los miembros conectados estén
  donde estén, sin posición; mismo largo y anti-flood que el resto. El panel muestra a
  cada miembro con su rango y si está en línea. El nombre del gremio va bajo el nombre del
  personaje en el mapa y al mirarlo (Mayús+click): "Ves a Ana, Guardián de nivel 20. Es
  Líder del gremio Faro del Norte."
- **Comandos:** `/guild create|invite|revoke|accept|decline|leave|kick|promote|demote|
  motd|transfer|disband ...` hacen lo mismo que el panel. Todo comando de gremio cuenta
  para el anti-flood del chat.
- **Sitio público:** `/guilds` lista los gremios (nombre, líder, miembros, fundación) y
  `/guilds/<id>` sus miembros con rango, vocación y nivel. Nada privado. Con las mismas
  exclusiones que el ranking: los personajes de staff y de cuentas deshabilitadas o
  baneadas no aparecen ni cuentan.
- **Ids:** el id de un gremio disuelto no se vuelve a usar (`guild_id_high`), así el log
  de auditoría y los enlaces públicos siempre nombran al mismo gremio.
- **Guerras (T5.2):** ver "PvP", "Guerras de gremios".

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
| `/reports` | GM | Lista los 10 reportes abiertos más antiguos (T4.1) |
| `/closereport id resolución` | GM | Cierra un reporte abierto con la resolución (T4.1) |
| `/presence Nombre` | GM | Le pide un chequeo de presencia a ese jugador en cuanto se pueda (fuera de combate y activo); no cambia su puntaje (T4.1) |
| `/guildrename Viejo Nombre = Nuevo Nombre` | GM | Renombra un gremio (el nombre nuevo sigue las reglas de siempre); se avisa a sus miembros (T5.1) |
| `/guilddisband Nombre` | GM | Disuelve un gremio (T5.1) |
| `/unskull Nombre` | GM | Quita la marca PvP de un jugador conectado y olvida sus muertes injustificadas (T5.2) |
| `/house id` | GM | Muestra una casa: dueño, pagada hasta, invitados y objetos (T5.4) |
| `/houseevict id` | GM | Libera una casa; sus objetos van al buzón del dueño (T5.4) |
| `/housemove id Nombre` | GM | Da una casa a un personaje conectado, sin pago; los objetos van al buzón del dueño anterior (T5.4) |

Los GM conectados también reciben avisos de sistema: posibles bots y chequeos fallados o
esquivados (T4.1), y cada envío nuevo al portal de mapas con su número y título, sin datos
del autor; si llegan muchos seguidos, un solo aviso por minuto con cuántos fueron (T4.5).

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
- La detección de bots (T4.1, "Anti-bot y anti-AFK") solo suspende por 24 h, y solo si el
  puntaje sigue alto después de un chequeo de presencia fallado o una hora después de uno,
  aunque se haya acertado; cualquier sanción mayor la aplica siempre un GM con estos
  comandos. La entrada de auditoría del ban dice cuál fue (`check`: `failed` o
  `passed_confirm_ms`).

### Reportes de jugadores (T4.1)
- Cualquier jugador reporta a otro con **`/report Nombre motivo`** (cualquier jugador en
  línea) o con el botón **"!"** de la lista de batalla (un jugador a la vista). El motivo es
  texto libre de hasta `reports.max_reason` caracteres.
- El servidor adjunta solo el **contexto**: la posición de los dos, el nivel del reportado y
  sus últimos `reports.events` eventos (lo que dijo en el chat, a qué atacó, qué mató, si
  murió, qué ganó o perdió en la economía), con cuánto antes del reporte pasó cada uno.
- **Rate limit por cuenta** (no por personaje): `reports.burst` reportes seguidos y luego
  uno cada `reports.refill_ms`; la misma cuenta reporta al mismo personaje una vez cada
  `reports.same_target_ms`. Así un reporte no sirve para acosar a alguien. Con el comando
  cada intento cuenta, aunque el nombre no esté conectado: `/report` no sirve para vigilar
  quién juega. Con el botón solo cuenta el reporte que se envía.
- El reporte entra en una **cola** (`player_reports`) y en el log de auditoría. Los GM en
  línea reciben un aviso. Los GM ven la cola con `/reports` (y el operador con
  `make reports`, con el contexto completo) y la cierran con `/closereport`. Ver la cola y
  cerrar un reporte también quedan en la auditoría. Un reporte no sanciona a nadie: las
  sanciones las decide un GM con `/kick` o `/ban`.

## Sonido (T3.7)
El sonido es solo del cliente: el servidor no sabe de él y no manda nada nuevo. Cada
mensaje que ya llega se traduce en un **evento de sonido** con nombre
(`client/src/audio/cues.ts`) y `assets/sounds.yaml` dice qué suena con cada uno. Cambiar
un sonido o asignarle uno a un evento nuevo no requiere tocar código.

| Evento | Sale de | Suena por defecto |
|---|---|---|
| `effect.hit`, `effect.block` | `Effect` 1 y 2 (golpe, bloqueo o fallo) | golpe, fallo |
| `effect.element.<elemento>` | `Effect` 10–16 (golpe mágico o casilla de área) | hechizo del elemento |
| `projectile.<elemento>` | `Projectile` (desde donde sale) | flecha (físico) o hechizo |
| `effect.heal`, `effect.conjure`, `effect.buff` | `Effect` 3, 4 y 7 | curación, conjurar, refuerzo |
| `effect.gather.<tool.use>`, `effect.gather` | `Effect` 5, con la herramienta usada | minería, tala, pesca |
| `effect.gather_miss` | `Effect` 6 | fallo |
| `message.<clave>`, `message.<clave>.<oficio>` | mensaje de sistema (`craft.done` con el oficio de la estación abierta) | level up, muerte, viaje, herrería, cocina, monedas, rechazo |
| `step.self` | `CreatureMove` propio | paso |
| `ui.dialog_open` | `DialogOpen` | campana suave |
| `ui.click` | click en cualquier botón del DOM | click |

- **Canales**: general (master), música, efectos, interfaz y ambiente. Cada uno tiene
  volumen y silencio, que se guardan en el navegador (`rpg.audio`). Se cambian en el
  panel **Opciones**, que está junto al selector de idioma.
- **Posicional**: un evento en una casilla suena más bajo cuanto más lejos está del
  jugador. Se oye hasta 8 casillas (distancia de Chebyshev), con paneo estéreo según la
  diferencia en x. No se oyen los eventos de otro piso. Los sonidos propios (pasos,
  mensajes, UI) no son posicionales.
- **Ambiente**: un loop por isla (`world/world.yaml`): olas en Puerto, bosque en Bosque y
  el volcán en la Isla Volcánica; bajo tierra no hay ambiente. Al cambiar de isla hay un
  fundido cruzado (`ambient.fade_ms`).
- **Música: el director** (pedido del dueño, 2026-11-18; `client/src/audio/director.ts`,
  `sounds.yaml` `music`). Lo que oye el jugador:
  - **Cada lugar tiene una pool de temas enteros** (~3 minutos cada uno): Puerto alterna sus
    tres tomas, las cuevas siete versiones, cada isla la suya, el título la suya y el
    guardián de la forja la suya. Un tema nunca se repite dos veces seguidas y la pool se
    recorre entera antes de repetir.
  - **Ningún tema empieza por el principio:** arranca en uno de sus puntos de entrada (donde
    empieza una frase, medidos al importarlo), al azar. Bajar a una cueva no suena igual dos
    veces.
  - **Volver a una zona** antes de 3 minutos (`resume_ms`) sigue el tema donde iba; después,
    un tema y un punto nuevos. Si vuelve mientras ese tema todavía se apaga (dio la vuelta
    en un borde), el mismo tema vuelve a subir desde donde está: nunca suena dos veces
    encima de sí mismo.
  - **Un tema que no baja** (un corte de red, un deploy, un archivo roto) no deja silencio:
    suena otro de la pool, o sigue la música de antes si la pool no tiene otro, y el
    archivo se vuelve a pedir más tarde (a los 5 s, después 10, 20… hasta cada minuto).
  - **Transiciones de potencia constante** (seno/coseno, sin pozo de volumen ni clics), con
    su largo según qué cambió (`fades`): otra zona o el área de una quest ~5 s, aparece un
    jefe ~1,5 s, se va el jefe ~6 s de vuelta al tema de la zona en un punto nuevo, título y
    mundo ~3 s.
  - **Sin aleteo en los bordes:** una zona nueva manda recién tras 3 s en ella
    (`dwell_ms`); ir y venir por un borde no cambia nada.
  - **Respiro entre temas:** el tema de una zona termina con su propio final y quedan entre
    6 y 15 s de ambiente (`gap_ms`) antes del siguiente, que entra con un fundido de 4 s. El
    del título y el de un jefe pasan al siguiente con un fundido antes del final, sin parar.
  - **Una pelea común no cambia la música** (el dueño, 2026-11-18). La cambia un jefe a la
    vista en el piso propio (`bosses`; hoy el guardián de la forja), que manda sobre todo y
    se sostiene 5 s después de perderlo de vista (`boss_hold_ms`), y el área de una quest
    importante (`music` en su YAML, docs/06), que manda sobre la zona.
- **De dónde sale**: desde el 2026-11-18 la música es la que el dueño eligió entre las
  tomas de Gemini (título, Puerto, Bosque, Volcán, Cuevas y el guardián de la forja;
  `assets/sounds/music/gemini.yaml`). Las seis versiones nuevas de cueva suenan como
  provisionales hasta que el dueño elija (`cave_pool` en `picks.json`). Los temas de
  soundgen siguen en el repo y vuelven a sonar, como loops sin hueco en la vuelta, en el
  lugar que el dueño marque `none`.
- **Volumen y silencio** de la música siguen en Opciones; con la música silenciada no se
  baja ningún tema (el director sigue el tiempo y, al volver a subirla, entra con un fundido
  corto donde va el tema).
- **Autoplay**: nada suena hasta el primer gesto (click, toque o tecla). Así lo exigen los
  navegadores y los webviews de la app de escritorio. Si el navegador igual rechaza la
  música (Safari y los webviews de Apple piden un gesto por elemento), vuelve a intentarlo
  en el gesto siguiente, desde donde va el tema. Mientras el audio esté suspendido,
  los efectos se descartan, para que no suenen todos juntos al reanudarse, y la música no
  avanza (sigue al reanudarse). Con la pestaña en segundo plano todo sigue sonando.
- **Recolección**: el sonido de la herramienta (minería, tala, pesca) solo se oye en la
  casilla donde el jugador la usó. La cosecha de otros jugadores y el efecto de una
  estación al fabricar suenan como recolección genérica.

## Tienda cosmética (T5.7)
Monetización solo cosmética (`00-vision.md`): lo que se compra cambia cómo te ven, nunca
lo que puedes hacer. Contenido en `data/cosmetics.yaml` (formato en `06-content-data.md`),
textos en `i18n/<idioma>/cosmetics.yaml`.

### La moneda: nácar
- **Nácar** (`premium`; en inglés *nacre*) es la moneda premium, nombre propio del juego.
  Es incontable como el oro: "300 de nácar" (`premium.amount`).
- Solo se consigue con dinero real (paquetes) o porque el staff la da (`/premium`,
  auditado). Nunca cae de monstruos, quests ni NPCs.
- **No se intercambia** (ni en el intercambio directo ni por correo), **no pasa por el
  mercado** y **nunca se convierte en oro** ni en items. No hay ningún camino de vuelta al
  juego: así no compra ventaja por la puerta de atrás.
- El saldo es de la **cuenta**, no del personaje. No vence.

### Paquetes
Se pagan en el checkout alojado del proveedor (el servidor nunca toca datos de tarjeta) y
se acreditan cuando el webhook firmado confirma el pago. Precios en pesos chilenos (la
moneda de la pasarela en modo prueba); los paquetes grandes rinden un poco más por peso,
nunca un bonus de juego.

| Paquete | Nácar | Precio |
|---|---|---|
| `pack_small` "Puñado de nácar" | 100 | $1.990 CLP |
| `pack_medium` "Concha de nácar" | 550 | $9.990 CLP |
| `pack_large` "Cofre de nácar" | 1200 | $19.990 CLP |

### Catálogo
Tres tipos (los mismos del `CHECK` de `cosmetics.kind`; `mount` queda reservado):

| Tipo | Qué cambia | Cosméticos (precio en nácar) |
|---|---|---|
| `outfit` | El atuendo del personaje (otro sprite con los mismos frames y paso que `citizen`) | Marinero (300), Batidor (400), Noble (600) |
| `outfit_color` | Un tinte que multiplica los colores del atuendo puesto | Marea, Brasa, Musgo (120 cada uno), Ocaso (150) |
| `name_effect` | Cómo se dibuja el nombre sobre el personaje (color, borde y brillo) | Nombre dorado (200), Nombre escarcha (250) |

- `citizen` es el atuendo gratis de todos y no se vende.
- Los diseños son propios (spritegen, CC0): no copian atuendos de ningún juego.

### Reglas que no se negocian
- **Nada cambia stats, velocidad, experiencia, botín, capacidad, regeneración ni
  tiempos.** Ningún sistema del servidor lee los cosméticos equipados: solo viajan en
  `Creature.cosmetics` para que los clientes dibujen. Un test de simulación lo verifica
  (el mismo combate con y sin cosméticos da el mismo resultado).
- **Sin cajas de botín ni azar:** cada compra es exactamente lo que se ve, con su precio
  fijo. Nada de ruletas, sobres, "compra 10 y gana 1 sorpresa" ni ofertas por tiempo que
  presionen.
- **Sin ventaja de información:** un nombre con efecto se ve igual de legible que uno
  normal; ningún tinte vuelve al personaje más difícil de ver (los tonos son claros, y la
  invisibilidad y las marcas de PvP se dibujan encima, como siempre).
- Los cosméticos no se pueden regalar ni transferir entre cuentas (no son items).

### Propiedad: de la cuenta, equipado por personaje
- Lo comprado es de la cuenta (`account_cosmetics`, `source = 'shop'`) y lo pueden usar
  todos sus personajes.
- Cada personaje equipa como máximo uno de cada tipo (`Cosmetics {outfit, color,
  name_effect}`), desde el panel **Apariencia** del juego. Vacío = el aspecto por
  defecto de ese tipo. Equipar y quitar es inmediato, gratis y lo ven los demás jugadores
  cercanos (`CreatureCosmetics`). Hay anti-flood (el servidor descarta cambios en ráfaga).
- Se compra en el sitio (`/shop`, con sesión): primero nácar con un paquete, después el
  cosmético con nácar. Si un personaje de la cuenta está en línea, el juego recibe el
  saldo y lo comprado al instante (`CosmeticsState`).
- Si un cosmético sale del catálogo, quien lo tiene lo conserva; el cliente que no lo
  conoce dibuja el aspecto por defecto.

### Límites por cuenta
En el bloque `limits` de `data/cosmetics.yaml` (formato en docs/06). Cambiarlos es una
decisión de negocio: pasa por revisión como cualquier cambio de contenido.
- `daily_premium` = **5000 de nácar** comprados con dinero en cualquier ventana de 24
  horas (`payments.LimitWindow`). Un checkout que lo superaría se rechaza antes de pagar
  (`site.shop.error.limit`); un pago que llega igual (dos checkouts pagados juntos) se
  acredita, porque el dinero ya se cobró. Ningún paquete puede valer más que este límite
  (la validación lo rechaza: no se podría comprar nunca).
- `equip_burst` = 5 y `equip_refill_ms` = 500: el anti-flood de equipar en el juego
  (5 cambios de golpe, después uno cada medio segundo).
- `max_premium_grant` = 100 000: el máximo de una corrección de staff con `/premium`.
- Comprar un cosmético que ya se tiene o sin saldo suficiente responde 409 y no descuenta
  nada; dos compras simultáneas nunca dejan el saldo negativo.

### Reembolsos, contracargos y cuentas suspendidas
- **Reembolso** (lo pide el jugador al soporte dentro de 14 días, solo si el nácar de ese
  paquete no se gastó) y **contracargo** (el banco revierte el pago): el webhook del
  proveedor descuenta del saldo el nácar de ese paquete. Si el saldo no alcanza (ya se
  gastó), se descuenta lo que haya, se registra el faltante y la **cuenta queda marcada**:
  no puede comprar paquetes ni cosméticos (`site.shop.error.suspended`) hasta que el
  staff lo revise. Los cosméticos ya comprados no se quitan solos; el staff decide.
- **Reembolso parcial** (el proveedor devuelve solo parte del pago): se descuenta la parte
  proporcional del nácar del paquete, redondeada hacia abajo:
  `floor(nácar del paquete × monto reembolsado / monto pagado)` en total. Cada nuevo monto
  reembolsado descuenta solo la diferencia con lo ya descontado (repetir el aviso no
  descuenta dos veces) y un reembolso total posterior descuenta el resto. Si el saldo no
  alcanza, igual que arriba: faltante registrado y cuenta marcada.
- **Disputa abierta** (`in_mediation`: el jugador reclamó y el proveedor aún no decide): la
  cuenta queda marcada para el staff y **no se descuenta nada** hasta que haya resolución.
  Si la disputa termina en contracargo, se descuenta como cualquier contracargo.
- **Contracargo ganado** (el banco devuelve el dinero al juego después de un contracargo):
  el nácar descontado **no se vuelve a acreditar solo**. El staff lo revisa y, si
  corresponde, lo devuelve con `/premium Nombre +N nota` (y limpia la marca con
  `/premium Nombre +0 clear nota`). Así un error del proveedor nunca crea moneda.
- **Pago que no se puede acreditar** (la referencia no verifica, la moneda o el paquete no
  existen, el monto no es el del paquete o la cuenta se borró): no se acredita nada, queda registrado como
  "unmatched" para que el staff lo concilie y acredite a mano si el pago es legítimo.
- Todo movimiento (paquete, compra, reembolso, contracargo, regalo de staff) queda en un
  registro auditable de solo agregar, y el jugador ve su historial en `/shop`.
- **Cuenta suspendida o baneada:** no puede comprar ni pagar (el checkout se rechaza), y
  conserva su saldo y sus cosméticos. Un ban por fraude de pagos (tarjetas robadas,
  contracargos en serie) no da derecho a reembolso del nácar ya gastado.
- **Cuenta borrada:** el saldo y los cosméticos se pierden con ella (se avisa antes).
- Sin proveedor configurado (`PAYMENTS_PROVIDER` vacío) la tienda está apagada: la API
  responde `enabled: false`, el sitio muestra `site.shop.disabled` y el panel Apariencia
  sigue funcionando con lo que ya se tiene.

## PvP (T5.2)
Números en `data/balance.yaml` (`pvp`), nunca en código. Código:
`server/internal/session/pvp.go` (reglas, marcas, muertes) y `session/guildwar.go`
(guerras). Copiamos la **idea** de las marcas por asesinato del género, no sus números,
nombres ni textos: todo lo de abajo es propio. `pvp.enabled: false` (o sin bloque `pvp`)
apaga todo y el juego queda como antes de T5.2: nadie puede herir a otro jugador.

### Dónde y quién
- **Zonas de protección:** nadie pelea, como siempre.
- **`no_pvp`:** no se puede atacar a jugadores (ni desde ni hacia la zona). La isla inicial
  (`puerto`, también el tutorial) es `no_pvp` entera.
- **`pvp` (arena):** si los dos están adentro se pelea sin marcas, sin bloqueo y sin
  castigo: el derrotado despierta en su templo sin perder experiencia, skills, items ni
  bendiciones. Sus condiciones terminan, salvo la comida (`well_fed`, auditoría de
  contenido m2): estaba pagada y una derrota de arena no cuesta nada. Es una derrota de arena solo si la víctima muere en una casilla `pvp` por el
  golpe de un jugador que también está en la arena; cualquier otra muerte (un monstruo,
  un golpe desde afuera, fuera de la arena) es una muerte normal, y los golpes de arena no
  dan crédito de muerte fuera de ella. Un duelo en la arena no da derecho a defensa propia
  afuera, y perderlo no quita la marca de agresor ni el bloqueo que se traían de afuera. Hay una chica en la arena de Raigal (Isla del Bosque).
- **El resto del mundo:** PvP abierto con marcas.
- **Nivel:** por debajo de `min_level` (20) no se ataca ni se es atacado por jugadores. Es
  más que la protección de novato (8) a propósito: quien llega a 20 ya salió de Puerto y
  conoce el combate.
- **Staff:** GM y admin son inmunes y no pueden atacar a jugadores.
- **Grupos y gremios:** se pueden atacar directamente (un duelo amistoso en la arena),
  pero los hechizos de área nunca dañan a miembros del propio grupo o gremio.

### Justificado o no
Atacar a alguien es **justificado** si: tiene cualquier marca; sus gremios están en guerra
activa; ese jugador te atacó en los últimos `aggressor_ms` (defensa propia); o los dos están
en una arena. Lo demás es **injustificado**.

### Marcas (skulls)
| Marca | Cómo se gana | Cuánto dura |
|---|---|---|
| Agresor (ámbar) | Un ataque injustificado | `aggressor_ms` (7 min) desde el último ataque injustificado |
| Asesino (carmesí) | Alguna ventana de `murderer.windows` llega a su cantidad de muertes injustificadas: 4 en 20 h o 9 en 120 h | `murderer.hours` (60 h) desde la última muerte injustificada |
| Proscrito (violeta) | Igual con `outlaw.windows`: 7 en 20 h o 14 en 120 h | `outlaw.hours` (200 h) |

- Quien se defiende de un agresor no queda marcado. Una muerte nueva renueva el tiempo de
  la marca y nunca la baja.
- Se ve junto al nombre en el mapa y en la lista de batalla. Una muerte quita la marca de
  agresor; la de asesino o proscrito sigue.
- Cada marca tiene su propio icono, de arte propio, con su silueta y su color: espadas
  cruzadas para el agresor (desenvainó contra alguien), una gota de sangre para el asesino
  y un escudo partido para el proscrito (perdió la protección de la ley).
  Detalle en `assets/README.md`, "Iconos de interfaz".
- Las muertes injustificadas se cuentan por ventanas de tiempo con el reloj del juego y se
  guardan con el personaje (solo las que caben en la ventana más larga).

**Por qué estos números:** 7 min alcanza para terminar una pelea y alejarse; 4 muertes en
un día de juego separan al que se defiende o se venga del que caza por deporte; las
ventanas de 20 h y 120 h siguen el ritmo de quien juega a diario sin castigar un mal día.
Las duraciones (60 h y 200 h) obligan a jugar varios días con la marca puesta.

### Castigo
- **Al morir con marca de asesino o proscrito:** cada pieza de equipo cae con al menos
  `equipment_drop_pct` (40 % / 100 %) y la mochila con `backpack_drop_pct` (100 %), con o
  sin bendiciones (que siguen bajando la pérdida de experiencia).
- **Bloqueo de combate PvP:** quien ataca a un jugador no puede salir del juego ni entrar a
  una zona de protección por `lock_ms` (40 s); tras una muerte injustificada,
  `kill_lock_ms` (9 min). `kill_credit_ms` no puede pasar de `lock_ms`: quien se lleva una muerte sigue en
  el mundo para cobrarla. Quien recibe el ataque no puede salir del juego por `lock_ms`,
  pero sí refugiarse en una zona de protección. El bloqueo también cuenta como "en combate"
  para los barcos, la desconexión por inactividad y los chequeos de presencia. Cerrar la
  conexión durante el bloqueo **no** saca al personaje: queda en el mundo sin conexión
  ("link-dead"), sin actuar y atacable, y cada golpe que recibe renueva el bloqueo. Cuando
  vence, se guarda y sale. Si su dueño vuelve a entrar mientras tanto, retoma ese mismo
  personaje (posición, vida, marca y bloqueo incluidos). Lo mismo si es el servidor el que
  corta la conexión: un cliente que no lee lo que se le manda (cliente lento) o un
  reseteo de contraseña la cierran igual (el reseteo, por seguridad, siempre), pero el
  personaje queda link-dead hasta que vence el bloqueo; lo que esa conexión haya mandado
  después no se ejecuta. Solo una expulsión o un ban de staff, o un guardado que falló
  (T5.3), lo sacan en el acto. Es el mismo mecanismo que el bloqueo de logout de cualquier
  pelea ("Muerte", "Bloqueo de logout en combate"), con un plazo más largo y su propio
  mensaje (`pvp.logout_locked`). En la arena no hay bloqueo PvP, pero un golpe sí deja
  los 12 s de combate de cualquier pelea.
- **Recompensa:** matar jugadores no da experiencia ni otra recompensa (sería farmeable
  entre cuentas propias). Golpear jugadores tampoco entrena skills ni el escudo.

### Muerte por PvP
Toda muerte en la que un jugador hirió a la víctima en los últimos `kill_credit_ms` (40 s)
cuenta para cada uno de ellos: suma a su contador de muertes (`pvp_kills`), y es
injustificada para quien la atacó sin justificación. Los dos reciben un mensaje (quién
derrotó a quién; si la víctima no veía a quien la mató, `pvp.killed_unseen` sin nombre) y
el servidor registra la muerte en su log (ids de los personajes, si fue
justificada, arena, guerra y posición; nada más).

### Daño
Todo golpe de un jugador a otro (cuerpo a cuerpo, distancia, varitas, hechizos, runas y
las condiciones que deja) se escala a `damage_pct` (60 %): sin golpes de un solo turno.
Los jugadores no tienen resistencias elementales; la armadura y el escudo frenan los golpes
físicos como contra un monstruo. Una condición de otro jugador (fuego, veneno...) solo
daña si ese jugador podría atacar ahora (zonas, niveles, staff y su modo seguro) y nunca
empieza un ataque injustificado: solo continúa uno que su autor ya hizo con la mano. Una
quemadura de un duelo de arena o de una guerra que terminó deja de dañar.

**Autor de una condición:** cada golpe es un ataque de su autor (se juzga, marca, renueva
el bloqueo y da crédito de muerte como un golpe directo). El autor es un personaje, no una
conexión:
- **Relogueo de cualquiera de los dos:** la condición sigue siendo de su autor. Se guarda
  con la víctima (`characters.conditions`) junto con lo que la víctima recordaba del ataque
  de ese autor fuera de una arena (cuándo fue el último golpe y si fue injustificado) y la
  hora del guardado. Al volver, ese recuerdo vale solo si no pasó `aggressor_ms` **en el
  reloj** desde ese golpe (aunque la condición haya terminado mientras tanto), y la
  condición sigue **como si la víctima no hubiera salido**:
  los golpes que habrían caído mientras estaba fuera pasan sin daño, como en una zona de
  protección, y el resto cae a su ritmo. Así salir del juego no corta ni estira un ataque
  (ni la defensa propia): la víctima no puede guardarse los golpes para recibirlos más
  tarde (cada uno renovaría la marca y el bloqueo del autor, y ella elegiría cuándo la
  mata). Las condiciones sin autor (de monstruos) siguen congeladas mientras no está:
  salir no las cura.
- **Guardado de antes de un reinicio:** si la hora del guardado no se puede ubicar en el
  reloj de este servidor (es anterior a su arranque, con su edad contada en ticks como la
  del recuerdo; posterior a ahora; o no está, como en una fila guardada antes de esta
  regla), la condición con autor termina al entrar. Es la
  opción segura para los dos: la víctima no recibe golpes que quizás cayeron hace mucho y
  el autor no queda marcado, bloqueado ni con una muerte por un ataque que nadie puede
  medir (el recuerdo de ese ataque también se olvida tras un reinicio). Las condiciones
  duran menos de un minuto (`balance.yaml conditions`): tras un reinicio, lo normal es que
  ya hubiera terminado igual.
- **Autor fuera del mundo:** su condición no daña (los golpes pasan, como en una zona de
  protección): no podría atacar y no habría a quién darle la muerte. Mientras su condición
  daña, cada golpe renueva su bloqueo, así que quien cierra la conexión queda link-dead y
  la muerte se le cuenta igual (como a cualquier atacante). Si vuelve antes de que la
  condición termine, sigue dañando según las reglas de arriba. Consecuencia aceptada: una
  víctima que espera en una zona de protección hasta que termine el bloqueo del autor, y
  el autor sale, se queda con un resto inofensivo (antes dañaba completo, como del mundo).
- **PvP apagado:** una condición de otro jugador guardada de antes no daña a nadie.

**Hechizos de condición a distancia** (`entangle`): alcanzan a un jugador con las reglas de
un ataque directo (zonas, niveles, staff, modo seguro; a un miembro del propio grupo o
gremio se le puede apuntar, como con un rayo) y los chequeos de alcance y línea de vista.
Cuentan como un golpe aunque la condición no prenda: marca, bloqueo, defensa propia y
crédito de muerte; los golpes de una condición de daño son del lanzador.

### Modo seguro
Interruptor del cliente, **activado por defecto** (cada login empieza así hasta que el
cliente diga otra cosa). Con él no se puede atacar a un jugador si sería injustificado, y
los hechizos de área no lo alcanzan. Sin él, el área golpea a todo jugador atacable del
círculo (salvo grupo y gremio) y marca como un ataque directo. El área nunca alcanza a un
jugador que el lanzador no ve (invisible): ni daño, ni marca, ni pista.

### Guerras de gremios
- El líder declara la guerra a otro gremio por nombre; el líder del otro la acepta o la
  rechaza. Una declaración sin respuesta vence a las `war.answer_hours` (24 h).
- Activa, termina cuando un lado llega a `war.kill_limit` (30) muertes (gana), cuando un
  líder se rinde (gana el otro), a las `war.hours` (96 h; gana quien tiene más muertes o
  es empate) o si uno de los gremios se disuelve.
- Mientras dura, los miembros de ambos se atacan sin marcas (también en modo seguro) y cada
  muerte entre ellos suma **una** al marcador de su gremio, la golpeen cuantos la golpeen.
- Un gremio tiene como mucho `war.max_wars` (3) guerras abiertas (declaradas o activas), y
  una sola con cada gremio.
- Panel "Gremio": guerras con su estado, marcador y tiempo; el líder declara, acepta,
  rechaza o se rinde. También `/guild war declare|accept|decline|surrender Gremio`. Cada
  acción cuenta para el anti-flood del chat como todo comando de gremio.

### Staff, anti-bot y reportes
- `/unskull Nombre` (GM): quita la marca de un jugador conectado y olvida sus muertes
  injustificadas; queda en el log de auditoría (`remove_skull`, con la marca que tenía).
- Anti-bot: elegir de objetivo a un jugador no es un evento de entrenamiento y el daño de
  otro jugador no cuenta como golpe para la señal de reacción de curación (en PvP todos se
  curan rápido).
- Reportes: el contexto incluye `attack_player` y `kill_player` con el nombre del otro.

### Pendiente
Un ranking público de guerras. (Las marcas ya tienen sprites propios:
`assets/sprites/ui/marks/`, dibujados por `client/src/render/marks.ts`.)
