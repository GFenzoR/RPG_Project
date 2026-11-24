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

## Minimapa (pedido del dueño del 2026-11-23)
"Un minimapa como el de Tibia: hay que explorar para verlo, muestra los puntos cardinales y,
si tenemos un objetivo activo, una estimación de dónde está."
- **Explorar:** una casilla queda explorada cuando entra en la vista del jugador (la ventana
  de 31x21 de "La vista", solo el piso propio) al caminar, al cambiar de piso o al entrar.
  Lo explorado no se olvida nunca y es del **personaje**, no del dispositivo: lo guarda el
  servidor (docs/05 "Minimapa", docs/07 "Minimapa"). Lo no explorado es **negro**.
- **Qué muestra:** una o más casillas por píxel (cuatro niveles de zoom), cada casilla
  explorada del color de lo que tiene: lo de más arriba que bloquea el paso (muro, árbol,
  roca) o si no su suelo. El color es el promedio del sprite de ese item en el atlas
  (`make sprites`, docs/17 "Minimapa"). Solo el piso propio. El jugador va al centro con una
  marca que apunta hacia donde mira; los miembros del grupo a la vista son puntos. N, E, S y
  O (W en inglés) en los lados del marco: el norte siempre arriba.
- **Moverse por el minimapa:** arrastrarlo lo corre; "volver a centrar" lo devuelve al
  jugador. Se pliega a su barra (en los teléfonos empieza plegado).
- **Objetivo seguido:** el diario de misiones tiene "Seguir en el mapa" en cada quest en
  curso (una a la vez). El minimapa muestra una **estimación**, nunca la casilla: un círculo
  alrededor de un punto cercano al lugar del paso actual, que lo contiene entero. Si el
  círculo queda fuera del minimapa, una flecha en el borde apunta hacia él con la distancia
  aproximada (de a 5 casillas hasta 50, después de a 10); si está en otro piso, ▲ (arriba) o
  ▼ (abajo). El lugar es el NPC con quien hablar, el spawn más cercano del monstruo que hay
  que cazar (se vuelve a elegir al cambiar de piso, teletransportarse, viajar en barco o
  despertar en el templo; no al caminar), el lugar al que hay que llegar o las placas de un hito, o el `hint_area` del
  paso (docs/06). Un paso que se cumple en cualquier lado (llevar un item, una marca) no
  tiene círculo. La estimación no revela mapa: el círculo y la flecha se dibujan sobre lo
  que haya, y lo no explorado sigue negro. Es la misma para el mismo personaje, paso y
  lugar, así que pedirla muchas veces no la afina; cada spawn de un mismo monstruo se corre
  distinto, así que conocer uno no ubica los demás.

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
    tiene ataques a un objetivo (el guardián), sus áreas. Una cura propia que esas cazas
    nunca necesitan (ninguna deja al cazador bajo la mitad de su vida) la tiene que lanzar
    la primera caza que sí la necesita (lote 11: el montaraz con el arco de tejo, "Catálogo
    de equipo"). Las áreas de los magos y del
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
  estación, con lo que falta y la chance a tu nivel (el yunque, además, la pestaña de la
  forja: "Forja"). Herrería: mineral + tronco → lingote en
  la fragua; lingotes → hacha de leñador, pico o hacha forjada en el yunque (con el
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
  las vende el proveedor de Lanternby.

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
  **chequeo de presencia** (una pregunta simple, como "elige el color de esta muestra", con 10 min de
  juego para contestar y sin interrumpir nada; los colores son azul, amarillo, blanco y
  negro, que se distinguen sin depender solo del tono, así un jugador daltónico no falla
  por no ver la diferencia entre rojo y verde) y, si el puntaje sigue alto después de un
  chequeo fallado o una hora después de uno, una suspensión de 24 h. Nunca se pregunta en
  combate, en una zona sin logout ni a quien está ausente, y el plazo no corre mientras uno
  no juega. Un chequeo fallado suma puntos, pero no suspende por sí solo. Acertar no borra
  la sospecha (un programa también puede contestar): el chequeo sirve para avisar. A
  cualquiera le puede tocar un chequeo al azar de vez en cuando, sin consecuencias. El ban lo
  decide siempre un GM. Limitación conocida: la pregunta es solo visual (la muestra de
  color no dice su nombre, para que un programa no la lea del texto), así que un jugador
  ciego con lector de pantalla no puede contestarla; como fallar no suspende por sí solo
  y el ban lo decide un GM, se acepta por ahora.
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
  - Segunda área de cada mago (auditoría de contenido M5, 2026-11): Karvask
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
  | Saciedad | `well_fed` | regeneración de la vocación +100 %, hasta 20 min | suma | sobrevive |
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
  golpes físicos. A eso se suma el atributo de cada pieza puesta ("Atributos de items").
- **Contenedores:** una mochila (o los restos de un monstruo) tiene `container.slots`
  lugares. Los contenedores se anidan hasta 8 niveles; no se puede meter uno dentro de sí
  mismo. Soltar un item sobre un slot de equipo con un contenedor, o sobre un lugar de una
  ventana de contenedor que tiene otro contenedor, lo mete adentro (soltarlo sobre un
  contenedor en el mapa lo deja en el tile). Las pilas apilables se juntan hasta
  `max_stack`. Un tile admite hasta 20 items distintos soltados (las pilas iguales se
  juntan).
- **Capacidad:** cada vocación tiene capacidad (gramos) por nivel; el peso es el de los
  items equipados con su contenido y el de lo que llevan los bolsillos (abajo)
  (`weight × cantidad`). Solo lo que entra al inventario desde afuera consume capacidad.
  La UI muestra oz = gramos / 100.
- **Alcance:** tomar, soltar, abrir o usar en el suelo exige el mismo piso y distancia
  ≤ `inventory.reach` (1); un contenedor del suelo se cierra al alejarse. Mirar alcanza
  todo lo visible. Los items fijos del mapa (`world.bin`) se pueden mirar pero no mover.
- **Usar:** un contenedor se abre o cierra; un consumible cura (`heal_hp`/`heal_mp`) o se
  come y gasta una unidad, con `inventory.use_cooldown_ms` entre usos. Comer (auditoría
  de contenido m2) suma su `food_ms` a la condición `well_fed` (regeneración más fuerte,
  ver "Skills" y "Condiciones"), hasta su `max_ms` (20 min): la comida que solo alimenta
  y pasaría de ese tope se rechaza sin comerla ni gastar el cooldown ("Tienes el estómago lleno"); la
  que además cura se come siempre y su tiempo se recorta. Las runas (T1.9) y las
  herramientas (T1.12) se usan sobre una criatura o casilla con `UseItemOn`.
- **Personaje nuevo:** empieza con `inventory.start_container` (una mochila vacía) en el
  slot de mochila (el tutorial la abre) y con sus bolsillos vacíos. El kit de cada vocación
  llega con los diálogos (T1.10): al aceptar el
  capítulo 1, el capitán del puerto da un alfanje al guardián, una varita de chispa al
  arcanista (auditoría de contenido m5; antes, monedas), un arco corto y monedas para
  flechas al montaraz, y una vara de retoño al druida. El armero vende arcos, flechas y la
  ropa del kit inicial (para cualquier vocación: desde el lote 11 solo el torso pesado pide
  guardián o montaraz, "Catálogo de equipo"); el buzo vende las varitas, las varas y el
  brebaje de maná. En el Bosque las varas, las
  varitas y los brebajes los tiene la druida Velia (opción "¿Qué es este lugar?") y el
  resto la curtidora; en Cinderstead, el herrero y el templo (brebajes, cataplasmas, la varita
  de obsidiana, la vara de escarcha negra, la túnica de ceniza y el amuleto de brasa).
- **Escalones de equipo:** desde el lote 11 los da el catálogo compacto por bandas, una
  pieza por línea y banda ("Catálogo de equipo", abajo). Antes (auditoría de contenido M3)
  cada línea tenía sus propios escalones.
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

### Bolsillos (decisión del dueño, 2026-11-19)
La prueba de Thimblewick del 2026-11-19 mostró que la muerte deja la mochila en el
cuerpo y que el personaje reaparecía con una mochila nueva gratis (hallazgo M5: sin un
contenedor no se puede tener ni una moneda). El dueño decidió: *"al no tener contenedor el
personaje debiese tener 4 slots (los bolsillos) pero si te compras una mochila ganas mas
slots"*. Código: `server/internal/session/pockets.go`.
- **Qué son:** todo personaje tiene `inventory.pocket_slots` (4) bolsillos propios. Son
  parte del personaje, nunca un item: no se equipan, no se mueven, no se levantan, no se
  venden ni se intercambian y no se pierden nunca. Lo que llevan se mueve, se usa, se mira
  y pesa como lo de un contenedor que el personaje lleva (la capacidad los cuenta; un
  contenedor en un bolsillo se abre y anida como cualquiera). La mochila equipada suma
  sus lugares a los de los bolsillos.
- **Adónde va lo que se recibe:** compras, resultados de oficios, recompensas de quests,
  diálogos, cofres y tareas, el buzón del mercado, un intercambio, lo conjurado, el vuelto
  de un pago, los items de quest de un monstruo y lo que da un GM se suman primero a las
  pilas iguales que ya se llevan (la de la mochila antes que la de los bolsillos: unas
  monedas se juntan con las de un bolsillo aunque la mochila tenga lugar); lo que queda
  abre una pila nueva **primero en la mochila (su primer nivel) y después en los
  bolsillos**; lo que no entra cae a los pies como antes (o se rechaza donde se rechazaba:
  tienda, cofre, mercado, intercambio, conjurar, oficios). Las cuentas de lugar (`room`,
  `canPay`, `roomForAll`, `tradeFits`, `canReceiveMoney`) suman los dos.
- **Levantar:** soltar algo sobre el slot de la mochila o en su ventana con la mochila
  llena lo deja en los bolsillos; sin mochila, soltar algo que no es una mochila sobre su
  slot vacío también. Una mochila soltada ahí se equipa. Soltarlo en un bolsillo
  (`ItemLocation.pocket`) lo deja ahí; sobre un bolsillo con un contenedor, adentro. Un
  contenedor que está dentro de la mochila, elegido a mano, nunca derrama a los bolsillos.
- **Pagar y contar:** pagos (tiendas, mercado, bendiciones, gremio, casas, barcos, la
  forja), ingredientes, `has_item`/`take_item`, el chequeo de items de una quest, el
  selector del mercado, el intercambio, las llaves de las puertas y la forja leen la mochila
  y los bolsillos (`eachCarried`: el equipo, cada contenedor y al final los bolsillos).
- **Al morir:** ver "Muerte": lo que llevan cae al cuerpo con la mochila.
- **Guardado:** filas de `inventory_items` de primer nivel con `pocket` y el bolsillo en
  `slot` (migración 00020); los personajes de antes tienen los bolsillos vacíos. Bajar
  `inventory.pocket_slots` no borra nada guardado (lo que sobra se puede sacar, pero no
  vuelve a entrar): mejor no bajarlo.

### Catálogo de equipo (lote 11, 2026-11)
Pedido del dueño (2026-11-18): pocos items, como en los MMORPG de casillas clásicos, para
que el juego sea simple, y a cambio un atributo al azar por pieza (`feat/item-attributes`)
y el refinado (`feat/item-forge`). El catálogo se rehízo compacto: **78 piezas** (40
armas, 6 escudos y 32 armaduras y joyas) más las dos municiones, en **seis bandas** de
nivel del 1 al 100+, con una pieza por línea y banda. Cada arma, armadura y escudo pide su
nivel (`requires.level`, regla de `make validate`): el de su banda.

**Bandas.**

| Banda | Niveles | Nivel que piden | Dónde se consiguen |
|---|---|---|---|
| 1 | 1–4 | 1 | Puerto: el kit inicial |
| 2 | 5–9 | 5 | Puerto: armas y escudo (sin armadura) |
| 3 | 10–29 | armas 10; armadura, escudo y joyas 15 | Puerto (armas) y el Bosque |
| 4 | 30–49 | 30 | Karvask (Cinderstead) |
| 5 | 50–74 | 50 | todavía sin isla |
| 6 | 75–100+ | 75 | todavía sin isla |

No son las bandas que se propusieron al pedirlo (1–8, 8–20, 20–35, 35–50, 50–70, 70–85,
85–100+):
- **Abajo manda la caza de Puerto y del Bosque**, que la simulación de balance mide
  monstruo por monstruo (5–15 s y 10–40 % de la vida a su nivel, "Monstruos"). Con un solo
  escalón entre 1 y 8, o la gaviota muere en menos de 5 s al nivel 1 o el cangrejo y el
  jabalí tardan más de 15 s a los niveles 5 y 7: hace falta un escalón en el 5. Con uno
  solo entre 8 y 20, el saqueador (nivel 10) o el contrabandista (16) se salen. El arma de
  la banda 3 (ataque 22) cubre del 10 al 29, porque la caza del Bosque pide 22 al nivel 20,
  pero con su armadura al 10 el saqueador ya no lastima (menos del 10 % de la vida): por
  eso la armadura, el escudo y las joyas de la banda 3 piden nivel 15. Por lo mismo la
  banda 2 no trae armadura (la del kit inicial alcanza).
- **Arriba**, con tres bandas (50–70, 70–85, 85–100+) el catálogo pasaba de 90 piezas. Dos
  bandas anchas, con el refinado haciendo crecer cada pieza dentro de la suya, lo dejan en
  78. Las islas de esas bandas (las Islas Heladas, 40–80, y la Isla Hundida, 70+, "Mundo e
  islas") traen sus fuentes; si una isla pide una banda intermedia, se agrega con la
  fórmula de abajo.

**Líneas, por vocación.**
- **Guardián:** espada, hacha y maza (una por skill de cuerpo a cuerpo), escudo y el torso
  pesado.
- **Montaraz:** arco (dos manos, flechas), ballesta (desde la banda 3: una mano, virotes, y
  la izquierda para el escudo) y el torso pesado.
- **Arcanista:** varita. **Druida:** vara (un arma `wand` de una mano). Los dos, la túnica.
- **Para todos:** escudo, cabeza, piernas, pies, amuleto (cuello) y anillo.
- **Clases de peso:** solo el torso tiene dos. La **armadura pesada** pide
  `requires.vocations: [guardian, ranger]` (abrigo de cuero de ciervo, coraza de acero de
  ascua...); la **túnica** es para cualquiera y es la línea de los magos. Esto cambia la
  regla m6 de la auditoría de contenido ("ninguna pieza de cuero está restringida"): el
  abrigo de cuero de ciervo es pesado. La clase media del montaraz se fundió con la pesada
  para que el catálogo quede chico; cabeza, piernas y pies son de una sola clase.
- **Joyas** (los slots de cuello y anillo ya existían en el protocolo, sin items): el
  servidor suma la `armor` de cualquier slot, así que el amuleto da 1–2 de armadura y el
  anillo 0–1. Sobre todo llevan el atributo al azar de `feat/item-attributes`. Los anillos
  de las bandas 3 y 4 salen solo como botín raro.

**El catálogo** (id y su número principal: ataque/defensa, ataque y rango, defensa o
armadura).

| Línea | Banda 1 | Banda 2 | Banda 3 | Banda 4 | Banda 5 | Banda 6 |
|---|---|---|---|---|---|---|
| Espada | `rusty_cutlass` 10/5 | `iron_sword` 13/7 | `boarding_saber` 22/11 | `embersteel_sabre` 29/15 | `wyrmfang_blade` 36/18 | `tidesteel_sword` 43/22 |
| Hacha | `hatchet` 12/3 | `forged_axe` 15/4 | `bearded_axe` 24/7 | `embersteel_axe` 31/9 | `wyrmbone_axe` 38/11 | `tidesteel_axe` 45/13 |
| Maza | `belaying_pin` 11/4 | `spiked_cudgel` 14/5 | `elmroot_maul` 23/9 | `embersteel_mace` 30/12 | `wyrmbone_maul` 37/14 | `tidesteel_mace` 44/17 |
| Arco | `short_bow` 2, 5 | `yew_longbow` 7, 6 | `thornwood_longbow` 12, 6 | `embersteel_longbow` 17, 6 | `wyrmsinew_bow` 22, 6 | `drownwood_bow` 27, 6 |
| Ballesta | — | — | `smuggler_crossbow` 8, 5 | `embersteel_crossbow` 13, 5 | `wyrmsinew_crossbow` 18, 5 | `tidesteel_crossbow` 23, 5 |
| Varita (arcanista) | `spark_wand` 8 energía | `coral_wand` 13 hielo | `stormglass_wand` 21 energía | `obsidian_wand` 30 energía | `wyrmhorn_wand` 39 energía | `pearlstorm_wand` 48 energía |
| Vara (druida) | `sapling_staff` 8 tierra | `rimewood_staff` 13 hielo | `hoarfrost_staff` 21 hielo | `blackfrost_staff` 30 hielo | `glacierheart_staff` 39 hielo | `deepfrost_staff` 48 hielo |
| Escudo | `barrel_lid_shield` 9 | `plank_shield` 12 | `elmwood_shield` 18 | `embersteel_shield` 22 | `wyrmscale_pavise` 26 | `tidesteel_shield` 30 |
| Torso pesado | — | — | `stagleather_coat` 6 | `embersteel_cuirass` 8 | `wyrmscale_mail` 10 | `tidesteel_plate` 12 |
| Túnica | `patched_tunic` 2 | — | `mossweave_robe` 3 | `ashweave_robe` 4 | `duskweave_robe` 5 | `pearlweave_robe` 6 |
| Cabeza | `sailcloth_cap` 1 | — | `stagleather_hood` 2 | `embersteel_helm` 3 | `wyrmcrest_helm` 4 | `tidesteel_helm` 5 |
| Piernas | `canvas_trousers` 1 | — | `stagleather_leggings` 2 | `embersteel_greaves` 3 | `wyrmhide_greaves` 4 | `tidesteel_greaves` 5 |
| Pies | `tarred_boots` 1 | — | `stagleather_boots` 2 | `embersteel_sabatons` 3 | `wyrmhide_boots` 4 | `tidesteel_sabatons` 5 |
| Amuleto | — | — | `antler_amulet` 1 | `cinder_amulet` 1 | `wyrmtooth_amulet` 2 | `blackpearl_amulet` 2 |
| Anillo | — | — | `briar_ring` 0 | `obsidian_ring` 0 | `emberheart_ring` 1 | `tidestone_ring` 1 |

La munición (`arrow`, 9, y `bolt`, 10) no tiene bandas: se apila y no lleva atributo. Cada
pieza tiene su propio ícono, dibujado con el motor de sprites (`feat/item-icons`, docs/17
"Íconos de items"): una banda mejor se reconoce de un vistazo por su material y su acento
(óxido y madera, hierro, acero, acero de ascua con brasa, hueso y escamas de dragoncillo
con oro, acero de marea con runas) y por una silueta más grande y más trabajada.

**La fórmula** (la comprueba `packages/content-schema/src/catalog.test.ts`: una pieza nueva
la sigue, o la fórmula, el test y este doc cambian juntos). Valores base por banda *b*:

| b | A (cuerpo a cuerpo) | Arco | Varita y vara | Escudo | Torso pesado | Túnica | Cabeza, piernas, pies | Amuleto | Anillo | V (valor) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 10 | 2 | 8 | 9 | — | 2 | 1 | — | — | 30 |
| 2 | 13 | 7 | 13 | 12 | — | — | — | — | — | 150 |
| 3 | 22 | 12 | 21 | 18 | 6 | 3 | 2 | 1 | 0 | 600 |
| 4 | 29 | 17 | 30 | 22 | 8 | 4 | 3 | 1 | 0 | 2000 |
| 5 | 36 | 22 | 39 | 26 | 10 | 5 | 4 | 2 | 1 | 5000 |
| 6 | 43 | 27 | 48 | 30 | 12 | 6 | 5 | 2 | 1 | 12000 |

Desde la banda 3, cada banda nueva suma: A +7, arco +5, varita y vara +9, escudo +4, torso
pesado +2, túnica, cabeza, piernas y pies +1 y cada joya +1 cada dos bandas. V no sigue una
razón fija: es el de la tabla (de una banda a la siguiente, × 4; × 3,3; × 2,5 y × 2,4: el
salto se achica arriba). Una banda intermedia que pida una isla toma, en cada columna, un
número entre los de sus vecinas (para V, la media geométrica, redondeada como abajo), y la
tabla, `catalog.test.ts` y este doc cambian juntos.
- **Cuerpo a cuerpo:** espada, ataque A y defensa 0,5·A; maza, A + 1 y 0,4·A; hacha, A + 2
  y 0,3·A (redondeo al entero más cercano, ,5 hacia arriba). La espada para más y el hacha
  pega más.
- **Distancia:** el arco, dos manos, rango 6 (el corto, 5) y flechas. La ballesta, el
  ataque del arco − 4, una mano, rango 5 y virotes. Varita y vara: rango 4, una mano; el
  elemento de la vocación (arcanista energía, druida hielo; las de las bandas 1 y 2
  conservan el suyo: chispa de energía, coral y madera de escarcha de hielo, retoño de
  tierra).
- **Peso** (gramos, *i* = b − 1): espada 3000 + 150·i; hacha 4000 + 300·i; maza 3800 +
  400·i; arco 2400 + 300·i; ballesta 3200 + 400·(b − 3); varita 1200 + 100·i; vara 1400 +
  100·i; escudo 3500 + 600·i; torso pesado 8000 + 1000·(b − 3); túnica 2000 + 300·i; cabeza
  800 + 400·i; piernas 1600 + 500·i; pies 1200 + 400·i; amuleto 300; anillo 100.
- **Valor:** V de la banda por el factor de la línea (armas 1; ballesta 0,9; escudo 0,75;
  torso pesado 0,9; túnica 0,6; cabeza, piernas y pies 0,4; amuleto 0,8; anillo 0,6),
  redondeado a 5 debajo de 100, a 10 debajo de 1000, a 50 debajo de 5000 y a 100 arriba.
- **Precios de los NPCs** ("Economía"): venden al valor en Puerto y a 1,25 veces el valor
  en el Bosque y el Volcán; compran a un tercio del valor o menos. Así ningún par de
  tiendas deja ganar comprando y revendiendo (`make validate`; el test del catálogo lo
  mira para todo el equipo).

**Dónde se consigue** (bandas 1 a 4).
- **Puerto:** el armero vende las bandas 1 y 2 y las armas de cuerpo a cuerpo y el arco de
  la banda 3 (desde el nivel 10, para las últimas cazas de la isla); el buzo, las varitas y
  varas de las bandas 1 a 3. El hacha forjada también sale del yunque (herrería 6), en
  lugar de la espada corta forjada.
- **Bosque:** la curtidora vende las armas, el torso pesado, la capucha, las calzas, las
  botas y el escudo de olmo (que también se forja) de la banda 3; la druida Velia, las
  varitas y varas y la túnica de musgo. El amuleto de asta no se vende (Velia lo compra):
  lo talla Gisla como recompensa de `tanner_chitin` y es lo que pide el hito de Orthavel
  ("Quests de hito"), así que ese filtro no se paga con oro. Quien lo pierde (muerte, un
  refinado que lo rompe, una venta) antes de terminar la vigilia le pide otro a Gisla por
  400 monedas, más de lo que paga Velia, así que vender y pedir otro nunca da ganancia. El anillo de zarza es botín raro de espinosos y reptantes
  huecos.
- **Volcán:** Bram Tizón vende y forja la banda 4 de acero de ascua (el escudo, que antes
  solo se forjaba, ahora también se vende); el templo, la varita de obsidiana, la vara de
  escarcha negra, la túnica de ceniza y el amuleto de brasa. El anillo de obsidiana es
  botín raro de mineros de obsidiana y gólems de escoria, y la recompensa de `smith_ring`.
- **Botín de antes:** el saqueador suelta el alfanje, la cabilla (en lugar del garrote de
  deriva) y la gorra; el contrabandista, las calzas de ciervo y su ballesta; el
  dragoncillo, el sable de ascua; el minero, el yelmo, la varita y la vara.
- **Recompensas:** el capitán del puerto sigue dando el kit inicial de cada vocación y, al
  cerrar el capítulo 1, la espada de hierro al guardián; los demás reciben su valor, 150
  monedas (antes 120, lo que valía la espada). Las quests secundarias del lote 12 dan,
  además de oro y experiencia, a lo sumo un equipable de una banda que ya se consigue (el
  amuleto de asta, el anillo de obsidiana y el amuleto de brasa: "Quests secundarias");
  las demás quests y las tareas, oro y experiencia.
- **Bandas 5 y 6: todavía no se consiguen.** Ninguna tienda, botín, receta, diálogo,
  recompensa (de quest o del tutorial) ni hechizo las da (el test del catálogo lo
  comprueba con `OBTAINABLE_BANDS`, que sube cuando llegue la
  isla de la banda). La cota de escamas y la hoja de colmillo de dragoncillo pasaron a la
  banda 5 (nivel 50, más fuertes): sus recetas (herrería 20 y 22, con escamas de
  dragoncillo y núcleos de escoria) vuelven con esa isla; las que ya están en un
  inventario se quedan. Los requisitos se miran al equipar, no al entrar: quien ya tenía
  puesta una pieza que ahora pide más nivel u otra vocación (la cota o la hoja antes del
  50, el torso pesado en un mago, el escudo de tablones antes del 5) la sigue usando hasta
  que se la saca. Ningún NPC compra la cota ni la hoja hasta que llegue su isla (`make
  validate` no deja un comprador sin fuente salvo para un retirado): se pueden intercambiar
  entre jugadores.

**Retirados** (`retired: true`, `06-content-data.md` "Item"): el garrote de deriva, la
espada corta forjada, la hoja de espino, el jubón de cuero, el chaleco de piel y la rodela
remachada repetían otra pieza de su banda. Siguen definidos con sus números de antes (quien
tiene uno lo conserva) y el armero de Puerto o la curtidora los compran, pero
`make validate` rechaza cualquier fuente nueva.

**Balance.** Los kits de las simulaciones son los del catálogo (`kitFor` en
`sim/balance_test.go` para el guardián y los montaraces; túnicas y líneas de cada vocación
en `balance_vocations_test.go`) y dos tests comprueban que cada pieza se puede llevar a ese
nivel y con esa vocación; un tercero, que cada arma entra al kit en el nivel que pide, no
después. Ningún objetivo documentado cambió:
- **Guardián:** Puerto, nivel 8 en 1,10 h y 15 en 3,32 h (antes 3,46); Bosque, 15→20 en
  2,30 h y 20→25 en 3,13 h; Volcán, 25→30 en 3,92 h, 30→40 en 10,13 h y 40→50 en 15,30 h;
  el custodio, 65 s y 149 % de la vida. El más justo es el minero de obsidiana al nivel 35:
  10,2 % de la vida (el piso es 10 %).
- **Carreras del 1 al 50:** el guardián en 34,4 h (antes 34,6) y 39,4 h sin brebajes de
  maná; magos y montaraces siguen entre 0,5 y 1,5 veces el guardián en cada tramo, con niveles
  mágicos casi iguales. Los magos llevan ahora la túnica (3 a 4 de armadura menos que el
  guardián) y su ritmo casi no cambió.
- **Cada arma entra al kit en el nivel que pide** (`TestKitWeaponsFromTheirLevel`): las
  simulaciones no modelan la compra, así que el arco de tejo, la espada de hierro y las
  varitas y varas de la banda 2 llegan al nivel 5, aunque en el juego las paga el capítulo
  1 (150 monedas de la quest y, a quien no recibe la espada, 150 más del capitán, hacia el
  nivel 6-7). Con el arco de tejo desde el 5, ningún duelo de Puerto deja al montaraz bajo
  la mitad de su vida (tira de lejos: 0-2 % de la vida por lobo) y su cura (nivel 4) no se
  lanza hasta las arañas del musgo del Bosque (nivel 10). El chequeo "cada hechizo se usa a
  su nivel" lo acepta a propósito: una cura propia que las cazas de sus primeros niveles
  nunca necesitan la tiene que lanzar la primera caza que sí la necesita (una caza que deja
  al cazador bajo la mitad y no la lanza falla igual). En Puerto la cura sirve contra
  varios lobos a la vez y en los errores, que un duelo no modela. Antes la simulación
  compraba el arco al nivel 8 para que el chequeo viejo pasara, y eso escondía lo que hace
  el arco a su nivel. El montaraz va del 1 al 8 en 1,18 h (el guardián, 1,40 h).
- **Amuletos sí, anillos no:** el kit lleva el amuleto (se vende) y no el anillo (botín
  raro; los de las bandas 3 y 4 no dan armadura).
## Atributos de items (decisión del dueño, 2026-11-18)
El dueño reabrió el diseño de items: pocos items, como en Tibia, para que el juego siga
simple, pero cada uno con **un atributo al azar** (la idea viene de los juegos de botín, con
nombres y números propios). Hecho en el lote 11, rama `feat/item-attributes`
(`server/internal/session/attributes.go`, `content/attributes.go`, `data/attributes.yaml`).
La forja (refinar +1..+10, rama `feat/item-forge`: "Forja", abajo) y el catálogo compacto
son otras ramas del lote: el refinado vive en los datos de cada instancia (`refine`).
- **Un atributo, siempre uno.** Todo equipable (arma, escudo o pieza de armadura; nunca
  munición, contenedores, consumibles, herramientas ni materiales) lleva exactamente un
  atributo con un valor. No hay rarezas ni colores por calidad: el atributo es una línea más
  de la ficha, en su propio color. Un item con atributo **nunca se apila** (`make validate`
  rechaza un equipable `stackable`).
- **Cuándo se tira:** en **cada creación** de un equipable, con la fuente sembrada del loop
  (`session.Config.Rand`, la misma del `game.Loop`): botín de monstruos, compra a un NPC
  (también la tienda de Thimblewick), recompensas de quest y de diálogo (el kit del
  capítulo 1), oficios, `/item` del staff, la recompensa del tutorial y un botín de quest
  (`each_player`); también un hechizo que conjure o una recolección que dé un equipable
  (ningún dato lo hace todavía). Se elige entre los
  atributos cuyo `on` nombra la clase del item (el `weapon.type` de un arma, `shield`, o el
  `armor.slot`) por su `weight`, con un valor uniforme en la banda del `requires.level` del
  item (sin requisito = nivel 1). El inventario inicial es una mochila (no tira) y los items
  fijos del mapa (`world.bin`) no son instancias: nunca tiran.
- **Items de antes:** un equipable guardado sin atributo (de antes de este cambio) tira el
  suyo una vez al cargarse y se guarda con él: el personaje en el mismo login (un guardado
  aparte, así una caída antes del autoguardado no tira otro al volver a entrar), el
  suelo de una casa en la escritura de la casa que la carga provoca al arrancar, y lo que
  espera en el buzón del mercado al retirarlo (una oferta de venta vieja se compra sin
  atributo y lo tira en el inventario del comprador; si tenía varias unidades, se compran
  todas las que se pidan y cada una tira el suyo).
- **Nada lo cambia ni lo pierde:** mover (equipo, contenedores, suelo, portales), el
  intercambio (las dos ofertas), el suelo de una casa (y el buzón al liberarla), el cadáver
  y lo que suelta la muerte, el buzón y las ofertas del mercado, el guardado y el log de
  economía (cada instancia con atributo es una fila propia con `details.mods`) mueven la
  instancia tal cual. Persistencia: `inventory_items.attributes`, la columna nueva
  `market_offers.attributes` (migración 00019) y `mods` dentro del JSON de
  `market_mail_items.item` y `house_items.item` (docs/05 `ItemMods`). Una columna
  `attributes` que no se puede leer (solo una edición a mano de la base la escribe) se
  registra con nivel error y se lee como item sin atributo: el personaje entra igual y el
  mercado arranca, y el equipable tira uno nuevo al cargarse.
- **Intercambio:** lo ofrecido es la instancia tal como se ofreció: si sus `mods` cambian
  en el lugar (la forja), sale de la oferta como si se hubiera movido y se borran las
  confirmaciones (`checkTrade`).
- **NPCs:** un NPC paga el `value` base; el atributo no cambia el precio. Lo que vende un
  jugador sigue siendo "N de este item", sin elegir cuál: el NPC (y un `take_item` de
  diálogo o el ingrediente de una receta) se lleva primero lo que está en los contenedores
  y lo puesto al final (un NPC nunca compra lo puesto) y, entre esas, la tirada más floja:
  sin atributo, después la que cae más abajo en la banda de su atributo (de 0 en el mínimo
  a 1 en el máximo); a igual, en el orden de la mochila (`spareFirst`). Para guardar una
  pieza buena, el jugador la lleva puesta. **Una pieza refinada (+1 o más) nunca se toma
  así** (revisión final del lote 11, `spareable`): para esos caminos es como si el jugador
  no la llevara (la tienda no la cuenta ni la compra, `has_item` no la ve, una receta no la
  gasta), así un +9 no se vende al precio base ni se pierde en una receta sin elegirlo.
  Sale solo por mano del jugador: el mercado (con su selector), el intercambio o el suelo.
- **Mercado:** una oferta de **venta** de un equipable es **una instancia** (cantidad 1) que
  elige quien vende entre las suyas (`MarketUpdate.owned_mods`); cada una es una fila propia
  del listado con su atributo, y el comprador recibe exactamente esa. Una oferta de
  **compra** de un equipable la llena **cualquier instancia**: quien le vende elige cuál, de
  a una por vez, y esa es la que llega al buzón del comprador. El precio de referencia es por
  item, sin mirar atributos. **El listado** (revisión final del lote 11): como cada venta de
  un equipable es una fila, las `list_size` más baratas podían tapar todo lo demás (quince
  espadas comunes escondían una +8 o un atributo raro más caros, y nadie podía aceptarlos
  porque no conocía su oferta). Por eso, en las ventas de un equipable, después de las
  `list_size` más baratas se lista además la más barata de **cada clase de pieza** que
  quede (cada par atributo y nivel de refinado), siempre en orden de precio: a lo sumo
  `list_size` filas más una por clase en venta. El valor del atributo no separa clases: se
  ve la más barata de la clase, y la siguiente cuando alguien la compra.
- **Qué suma:** solo lo que se lleva puesto (la mochila no cuenta). Todo se suma por
  atributo y cada uno, si tiene `cap`, no pasa de él.

  | Atributo | Efecto | Lo tiran | Bandas (nivel del item: rango) | Peso | Tope |
  |---|---|---|---|---|---|
  | `max_health` | + vida máxima | escudo, cabeza, torso, piernas, pies, cuello, anillo | 1: 4-10 · 10: 8-18 · 25: 14-30 · 50: 25-50 · 80: 40-80 | 12 | — |
  | `max_mana` | + maná máximo | varita/vara, cabeza, torso, piernas, pies, cuello, anillo | igual que la vida | 12 | — |
  | `health_regen` | + vida por tic de regeneración | escudo, cabeza, torso, cuello, anillo | 1: 1 · 10: 1-2 · 25: 1-3 · 50: 2-4 · 80: 3-5 | 6 | — |
  | `mana_regen` | + maná por tic de regeneración | varita/vara, cabeza, torso, cuello, anillo | igual que la vida | 6 | — |
  | `attack` | + ataque del arma (cuerpo a cuerpo o disparo) | espada, hacha, maza, distancia | 1: 1-2 · 10: 1-3 · 25: 2-4 · 50: 3-5 · 80: 4-7 | 14 | — |
  | `armor` | + armadura | cabeza, torso, piernas, pies | 1: 1 · 25: 1-2 · 50: 2-3 · 80: 2-4 | 14 | — |
  | `defense` | + defensa de las manos | escudo | 1: 1-2 · 10: 1-3 · 25: 2-4 · 50: 3-5 · 80: 4-7 | 14 | — |
  | `sword_skill`, `axe_skill`, `club_skill`, `distance_skill` | + la skill del arma en los ataques | el arma de esa skill | 1: 1 · 10: 1-2 · 25: 1-3 · 50: 2-4 · 80: 3-5 | 10 | — |
  | `magic_level` | + nivel mágico de los hechizos | varita/vara | 1: 1 · 25: 1-2 · 50: 1-3 · 80: 2-4 | 12 | — |
  | `speed` | + velocidad (puntos) | pies | 1: 2-4 · 10: 3-6 · 25: 4-8 · 50: 6-11 · 80: 8-14 | 14 | — |
  | `fire_protection`, `ice_`, `energy_`, `earth_`, `holy_`, `death_protection` | − % del daño de ese elemento | escudo, cabeza, torso, piernas, pies, cuello, anillo | 1: 1-3 · 10: 2-4 · 25: 3-6 · 50: 4-8 · 80: 5-10 | 3 (sagrado y muerte 2) | 40 % |
  | `life_leech`, `mana_leech` | % del daño de un golpe del arma vuelve como vida o maná | armas (el maná también las varitas) | 1: 1-2 · 10: 1-3 · 25: 2-4 · 50: 2-5 · 80: 3-6 | 6 | 15 % |

  Sin experiencia ni oro extra: alimentarían la economía. La skill de escudo no tiene
  atributo porque todavía no entra en ninguna fórmula (la defensa del escudo sí).
- **En las fórmulas** (`attributes.go` `wornGear`, recalculado con el equipo en
  `equipmentChanged`): la vida y el maná máximos son los de la vocación más el equipo (al
  sacarse una pieza la vida baja con el máximo si hace falta, nunca sube sola; el login
  restaura la vida guardada después de cargar el equipo); el ataque suma al del arma
  (`meleeSkill`, el disparo; `wandFight` también lo lee, pero ninguna pieza que se lleve
  con una varita tira `attack`, así que ahí vale 0); la armadura a la del equipo; la defensa a la de las
  manos (`handsDefense`, también en PvP); las skills a `combatSkill` (lo que usan ataques y
  hechizos, como `keen_eye`: no lo que se entrena ni el panel) y el nivel mágico a lo que
  escalan los hechizos (no a sus requisitos); la velocidad a la base antes de las condiciones
  (`refreshSpeed`); la regeneración a cada tic de la vocación (también si la vocación
  sola no regenera nada); la protección baja todo daño
  de su elemento que recibe un jugador (monstruos, condiciones, PvP: `damagePlayerBy`; la
  armadura sigue sin frenar la magia); el robo devuelve su parte del daño que hizo un golpe
  del arma (cuerpo a cuerpo, disparo o varita, a monstruos o en PvP; los hechizos y las
  condiciones no roban).
- **Balance:** los atributos son bonos, así que las simulaciones de `server/internal/sim`
  visten a cada cazador con su kit con atributos tirados por pelea (la media sobre las
  peleas). Para que las metas de las islas sigan valiendo, el bestiario de Puerto pega uno
  a tres puntos más de máximo (rata de sentina y gaviota ladrona 9, lobo 19, murciélago 18,
  jabalí 20, araña de musgo 16, saqueador 25, escarabajo de mena 28) y el espinoso y el
  reptante hueco del Bosque dan un poco menos de experiencia (204 y 248).
- **Cliente:** la ficha (tooltip y menú) muestra el atributo traducido, con su valor, bajo
  las stats y en su color (`--ui-item-attribute`); la de un equipable sin atributo (una
  tienda, una receta) dice que trae uno al azar; en el mercado (la búsqueda, una oferta de
  compra, el historial) dice en cambio que cada pieza trae el suyo, porque llega la que
  elige quien vende. Un atributo retirado del pool se muestra como retirado (no suma nada),
  en la ficha y en el mercado. Equipo, contenedores, suelo, intercambio y mercado usan la
  misma ficha.
- **Pendiente:** un atributo del collar o del anillo (no hay ninguno en el catálogo
  todavía); la skill de escudo en las fórmulas.

## Forja (decisión del dueño, 2026-11-18)
Pedido del dueño: *"me gustaría agregar el sistema de forja de ragnarok, para que el item
vaya pegando más pero forjar es difícil"*. De ese juego se toma solo la mecánica (refinar por
niveles, seguro hasta un punto, después cada intento arriesga la pieza); nombres, materiales,
números y textos son propios. Hecho en el lote 11, rama `feat/item-forge`
(`server/internal/session/refine.go`, `content/forge.go`, `balance.yaml → forge`,
`data/items/forge.yaml`, ventana `client/src/ui/Forge.tsx`).
- **Qué se refina:** todo equipable que tira un atributo ("Atributos de items": arma, escudo,
  pieza de armadura o joya; nunca munición, contenedores ni nada que se apila), de **+1 a
  +10** (`forge.levels`: su largo es el tope). Un +10 no se refina más.
- **Dónde:** en un **yunque** del mapa (`forge.station: anvil`, la estación de herrería de
  `data/recipes.yaml`), a 1 casilla y en el mismo piso, como las recetas. Usar el yunque abre
  su ventana con dos pestañas: **Recetas** y **Forja**. Hay uno en cada pueblo (Puerto, Ivernel
  en el Bosque y Cinderstead en Karvask, más el de la mina) y en Thimblewick: no
  hizo falta agregar ninguno con mapcli. Se eligió el yunque y no un NPC herrero: la estación
  ya es "el lugar del oficio", funciona igual en todos los pueblos y no ata la forja a un
  diálogo; los herreros venden las piedras.
- **Cada intento** gasta, de una vez y pase lo que pase: las **piedras de temple** de la banda
  del item (`forge.levels[n].stones`: 1 hasta +4, 2 de +5 a +7, 3 de +8 a +10), el **oro**
  (`forge.bands[].gold` × el nivel al que apunta: el intento a +7 de una pieza de nivel 30
  cuesta 120 × 7 = 840 cobre) y, si el jugador lo pide, **un ámbar de resguardo**. La pieza
  tiene que ser suya y estar a mano: puesta o en un contenedor abierto que lleva (nunca en el
  suelo ni en un contenedor que no lleva, un cadáver o un cofre: "solo puedes refinar lo que
  llevas"; ni ofrecida en el intercambio; lo publicado en el mercado ya no está en su
  mochila). La ventana no ofrece las piezas de un contenedor abierto sin padre que no es
  del tipo que lleva puesto (cadáver, cofre, bolsa del suelo: `maybeCarried`); una bolsa
  dentro de otro contenedor sí se muestra, porque `ContainerOpen` no dice si su padre se
  lleva, y si no se lleva el servidor contesta `refine.not_carried`.
  Piedras y ámbar se toman de los contenedores (como los ingredientes de una receta); el oro,
  de cualquier moneda que lleve, con el vuelto como en toda compra. Un intento por pedido,
  al ritmo de los oficios (`forge.time_ms`, 2 s, compartido con recolectar y fabricar). El
  pedido dice la pieza que ve el cliente con todos sus `mods` (atributo, valor y nivel): un
  click repetido después de un éxito ya no coincide y no hace nada. Después de una rotura las
  piezas de ese contenedor suben un lugar: un segundo click mandado antes del resultado (con
  lag) nombra la pieza rota, y el servidor no refina la que ocupó su lugar salvo que sea
  igual en todo (entonces da lo mismo cuál); eso no depende del ritmo de `balance.yaml`. La
  ventana, además, no deja mandar otro intento hasta que llega la respuesta del anterior (un
  resultado o un aviso; 10 s como mucho) y suelta la pieza rota en vez de apuntar a la que
  quedó en su lugar.
- **La chance** (`forge.levels[n].chance`, en %): hasta **+4 nunca falla** (`safe_level`);
  desde +5 baja en cada nivel: **+5 70 %, +6 55 %, +7 40 %, +8 25 %, +9 15 %, +10 8 %**. La
  tira la fuente sembrada del loop (`TickContext.Rand`, `IntN(100) < chance`).
  - **Herrería:** suma 1 punto cada 6 niveles del oficio, como mucho **+5** (herrería 30, la
    de las recetas más altas: `smithing_bonus`, cuya `skill` nombra el oficio), y solo en
    los intentos que pueden fallar. La forja no entrena herrería: el oficio se sube
    fabricando.
- **El resultado:**
  - **éxito:** la pieza sube un nivel (chispas sobre el yunque, efecto 8);
  - **fallo desde +5, sin ámbar:** la pieza **se rompe y desaparece** (efecto 9, una pieza que
    se parte; el log de economía la registra con sus `mods`);
  - **fallo con ámbar:** el ámbar se quiebra en su lugar y la pieza **baja un nivel** (+7 → +6;
    efecto 9). El ámbar se gasta en **cada** intento en que se usa, salga bien o mal: es un
    seguro que se paga; marcarlo en un nivel seguro no lo gasta.

  No hay "fallo que no cuesta nada": desde +5 todo fallo rompe la pieza o la baja un nivel.
- **Qué da cada nivel** (`forge.bands`, por el `requires.level` del item, las bandas del
  catálogo compacto; el bono del nivel *n* es `floor(n × valor)`):

  | Banda (nivel del item) | Piedra | Oro por nivel | Ataque (armas) | Armadura (cabeza, torso, piernas, pies) | Defensa (escudos) |
  |---|---|---|---|---|---|
  | 1–4 | menor | 3 | 0,5 | 0,2 | 0,3 |
  | 5–9 | menor | 12 | 0,7 | 0,2 | 0,4 |
  | 10–29 | mayor | 40 | 1 | 0,3 | 0,6 |
  | 30–49 | mayor | 120 | 1,4 | 0,3 | 0,8 |
  | 50–74 | radiante | 300 | 1,8 | 0,4 | 1 |
  | 75+ | radiante | 700 | 2,2 | 0,5 | 1,2 |

  Un +10 suma así al arma entre 5 (banda 1) y 22 de ataque (banda 6: la espada de 43 llega a
  65), a una pieza de armadura entre 2 y 5 y a un escudo entre 3 y 12: más en las bandas
  altas, como pidió el dueño ("vaya pegando más"). Los primeros niveles de una pieza de banda
  baja pueden no sumar todavía (0,2 × 4 = 0,8 → 0): la ventana muestra el bono de ahora y el
  del nivel siguiente. Las **joyas** (cuello y anillo) no suman armadura: cada nivel agrega el
  **10 %** del valor de su atributo (`jewelry_pct`, redondeado hacia abajo; un anillo de +20
  de vida a +5 da 30), y ese total sigue con el tope del atributo. Con un atributo
  chico el redondeo se come los primeros niveles: un anillo de +1 de regeneración no gana
  nada hasta +10 y uno de +3 de protección recién a +4 (3 × 10 % × 4 = 1,2 → 1), aunque cada
  intento desde +5 cuesta y arriesga la pieza; la ventana lo muestra (el bono de ahora y el
  del nivel siguiente, 0 → 0). El ataque cuenta solo para
  el arma de la mano derecha y la defensa para el escudo de la izquierda; la armadura, en
  cualquier slot de armadura. Lo de la mochila no suma.
- **En las fórmulas** (`attributes.go` `wornGear`, que llama a `refineGain` de `refine.go`): el
  ataque se suma al del arma como el atributo `attack` (cuerpo a cuerpo, disparo y varita),
  la armadura a la del equipo y la defensa a la de las manos (también en PvP). Refinar una
  pieza puesta recalcula el equipo en el acto (`setRefine` limpia `Player.gearFrom`).
- **Los materiales** (`data/items/forge.yaml`, nombres propios; sprites del motor de sprites):
  - **piedra de temple menor** (items de nivel 1–9; 10 cobre), **mayor** (10–49; 150) y
    **radiante** (50+; 600): las venden los herreros (el armero de Puerto y la curtidora de
    Ivernel la menor y la mayor; el herrero de Cinderstead las tres) y caen de algunos monstruos (la
    menor, de saqueadores, mineros ahogados y escarabajos de mena; la mayor, de reptantes
    huecos, contrabandistas, excavadores de obsidiana y gólems de escoria; la radiante, del
    custodio de la forja, 30 %, mientras no haya islas de esas bandas). Ningún NPC las compra:
    no hay vuelta de compra y venta.
  - **ámbar de resguardo** (3000 de valor de referencia): **ningún NPC lo vende ni lo da**
    (regla de `make validate`, salvo el mercader de Thimblewick, que es solo de
    desarrollo); cae del custodio de la forja (25 %) y, raro, de los monstruos más fuertes de
    Karvask (cría de wyrm 0,5 %; excavador, gólem y salamandra 0,3 %). Se comercia
    entre jugadores.
- **Costo esperado** (lo comprueba `content/forge_test.go` `TestForgeExpectedCosts`, a ±5 %),
  en cobre, con el valor de referencia V de cada banda del catálogo compacto y cada pieza rota
  reemplazada por una nueva de valor V:

  | Banda (V) | Hasta +4 | Hasta +7 sin ámbar | Hasta +7 con ámbar desde +5 | Ámbares hasta +7 |
  |---|---|---|---|---|
  | 1 (30) | 70 | 1 100 | 530 | 11 |
  | 2 (150) | 160 | 3 100 | 1 300 | 11 |
  | 3 (600) | 1 000 | 17 000 | 7 500 | 11 |
  | 4 (2 000) | 1 800 | 36 000 | 14 000 | 11 |
  | 5 (5 000) | 5 400 | 102 000 | 41 000 | 11 |
  | 6 (12 000) | 9 400 | 197 000 | 74 000 | 11 |

  Las metas: **+4 cuesta más o menos lo que la pieza** (entre 0,5 y 3 V: seguro y
  accesible); **+7 es un proyecto** (entre 10 y 40 V sin ámbar; con la caza de la banda 4,
  36 000 cobre son unas 14 h de botín neto de la simulación de balance; menos con ámbar);
  **+10 es una leyenda** (sin ámbar, miles de veces el valor de la pieza; con ámbar en cada
  intento arriesgado, unos 1 900 ámbares en promedio). Es lo que pidió el dueño: "forjar es
  difícil".
- **Persistencia y seguridad:** el intento entero pasa en un comando del loop (todos los
  chequeos primero, después se gasta todo junto y se tira la chance), así una desconexión lo
  ve hecho o sin empezar, nunca a medias ni dos veces; el personaje se guarda en el acto
  después de cada intento que puede fallar (desde +5, como una muerte), así una caída del
  servidor no devuelve una pieza rota ni quita un nivel ganado. Un nivel seguro (hasta +4)
  espera el guardado de siempre: volver a antes de él devuelve juntos el nivel, las piedras y
  el oro, sin nada que ganar, y no se escribe en la base cada 2 s por cada jugador que
  refina. El nivel viaja con la instancia por todos los caminos que
  mueven un item ("Atributos de items": mover, intercambio, muerte, casa, mercado, buzón,
  guardado). El log de economía (fuente `forge`) registra el oro, las piedras y el ámbar
  gastados, la pieza rota y cada cambio de nivel (la instancia sale con su nivel viejo y entra
  con el nuevo); no cuenta como ganancia para el detector de anomalías.
- **Nombre y ficha:** una pieza refinada se llama "+7 espada…" en todo el cliente (ficha,
  tooltip, intercambio, mercado y los mensajes del servidor: la clave `client.item.refined`
  con `{level}` y `{name}`, nunca texto armado en el código). En el mercado, el selector de
  cuál vender y las filas de ofertas ajenas dicen "+7 espada · +3 ataque"
  (`client.market.refined_line`), y el selector empieza por el refinado más bajo
  (`MarketUpdate.owned_mods` viene ordenado como `spareFirst`): aceptar una oferta de compra
  vende en el acto, así que nunca se elige una +7 sin verla. La ficha agrega la línea
  "Refinado +7: +3 de ataque" en el color del metal caliente (la de una joya no pasa del
  tope de su atributo). "Mirar" (`look.*`) nombra la pieza con su nivel y da su ataque,
  armadura o defensa con lo que suma el refinado.
- **La ventana** (pestaña Forja del yunque, estilo oscuro de docs/17): la pieza elegida (de
  las puestas y las de los contenedores abiertos), su nivel y el siguiente con el bono de
  cada uno, la **chance en grande** (verde si es segura, ámbar si arriesga), las piedras y el
  oro con lo que se lleva, el interruptor del ámbar cuando se lleva uno y el intento puede
  fallar (avisa que se gasta salga bien o mal), y un **paso de confirmación** desde +5 que
  avisa en rojo que la pieza se puede romper. Si un intento gastó el último ámbar, el
  interruptor desaparece y el próximo intento va sin él, con su aviso de rotura. Lo que se
  lleva (piedras, ámbar, oro) se cuenta al usar el yunque y después de cada intento, como
  en las recetas: lo que se junta con la ventana abierta se ve al volver a usarlo. El
  resultado del último intento queda arriba unos segundos.
- **Pendiente:** elegir la pieza arrastrándola a la ventana (hoy se elige de la lista); una
  marca "+N" sobre los íconos del inventario (hoy la dicen la ficha y la lista de la forja);
  islas de las bandas 5 y 6 con fuentes propias de la piedra radiante.

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
  - Por qué: en los corrales de Thimblewick (radio 2, con una abertura al sendero
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
  Las venden los tres templos (la hermana Liora en Lanternby, Ivernel y Cinderstead), cada una a
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
  - **Bolsillos** ("Bolsillos", arriba): lo que llevan cae al cuerpo **con la mochila, en
    la misma tirada** (el slot de mochila), también sin mochila. Los bolsillos se quedan:
    son del personaje. Bendiciones, protección de novato y marcas PvP pesan igual que
    sobre la mochila.
  - Todas las bendiciones `bless.*` se borran al morir (también las de un novato).
- Reapareces en el templo de tu ciudad de residencia (`characters.town`, o la primera isla)
  con vida y maná completos. La muerte se guarda al instante (no espera al autoguardado).
- **Sin mochila nueva** (decisión del dueño del 2026-11-19, "Bolsillos"): si la mochila
  cayó al cuerpo, reapareces sin mochila y con los bolsillos vacíos; la vieja, con todo lo
  que llevaba, sigue en el cuerpo con lo que llevaban los bolsillos (se recupera
  arrastrándola o abriéndolo). Los bolsillos alcanzan para tener monedas y levantar cosas
  (el hallazgo M5 de la prueba exploratoria, que antes resolvía una mochila gratis: esa
  regla y su ref `new_backpack` del log de economía ya no existen). Los proveedores
  (Puerto y Thimblewick) venden mochilas (20 de cobre).
- El cuerpo de un jugador entra todo lo que cae: tiene los 10 lugares de los restos de
  los monstruos o, si puede caer más, uno por slot de equipo y uno por cada item de los
  bolsillos (14 con `pocket_slots` 4; más si los bolsillos guardan más de `pocket_slots`
  porque se bajó). Un proscrito pierde todo (diez piezas y cuatro bolsillos) y a un
  asesino puede caerle casi todo (40 % por pieza y la mochila siempre): nada queda suelto
  en la casilla, donde la reserva del dueño (`corpse_owner_only_ms`) no lo cubriría
  (`session/death.go` `playerCorpse`; la ventana del cuerpo muestra todos sus lugares).
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

### Estados del personaje (lote 13, rama `feat/hud-status`)
Además de sus condiciones, el jugador ve en la bandeja de estados (docs/17 "Bandeja de
estados") tres estados que el servidor ya conoce y que antes solo se notaban al chocar con
ellos. No son condiciones: no tienen reglas propias, no se guardan, no se curan ni se
apilan; dicen lo que ya vale. Código: `server/internal/session/status.go`.

| Estado | Id | Cuándo | Tiempo |
|---|---|---|---|
| En combate | `in_combat` | el bloqueo de logout ("Bloqueo de logout en combate"): pelea en los últimos `combat_block_ms`, o un bloqueo PvP (atacante o víctima) | hasta que se puede salir del juego |
| Bloqueo de ataque | `pvp_locked` | el bloqueo PvP del atacante ("PvP", `lock_ms` o `kill_lock_ms`): ni zona de protección ni salir del juego | hasta que vence |
| Zona de protección | `protection_zone` | parado en una zona `protection` de `zones.yaml` (también una casa): nadie lo ataca y ningún daño periódico (veneno, fuego, descarga) lo daña | sin fin: mientras siga ahí |

- Un atacante bloqueado ve los dos primeros (el segundo dice además que no puede entrar a
  una zona de protección); la víctima, solo "En combate".
- **Morir** termina "En combate" (salvo que lo sostenga un bloqueo PvP); una zona de
  protección no lo termina (arriba).
- Ningún `id` de `balance.yaml → conditions` puede ser uno de estos tres: el servidor no
  arranca (`checkStatusIDs`).

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
  saqueadores sueltan la cabilla (antes el garrote de deriva, que el lote 11 retiró: el
  armero lo sigue comprando, como todo lo retirado), el armero compra el hacha forjada, la
  piedra tosca (500 g, 1-2 por golpe de veta) y el cuarzo, el herrero de Cinderstead la piedra,
  la curtidora la hoja de espino, y la tarja, el cofre sellado y la carta del minero salen
  solo a quien los necesita.
- **Brebajes de maná** (auditoría de contenido M2, 2026-11): el combustible de los magos.
  El brebaje (50 de maná, 22 cobre) lo venden el buzo de Puerto, la druida del Bosque y el
  templo de Cinderstead (24); el concentrado (125, 50 cobre) solo Cinderstead. Nadie los compra de
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
  cobre) lo venden la druida y el mercader del Bosque y el templo de Cinderstead; el concentrado
  (250, 125 cobre) solo Cinderstead: ~0,5 cobre por punto, entre la cataplasma y el maná. Como
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
- **Quests y tareas como fuente de oro** (lote 12): la medida es el botín de una hora de
  la mejor caza de su nivel, el de las simulaciones de balance (el mismo duelo que mide el
  ritmo de "Experiencia y nivel", así que es la hora del que mejor caza). Una quest
  secundaria paga, una sola vez, entre 4 y 10 minutos de ese botín (entre 5,7 y 6,7 las de
  hoy) y una tarea de caza, una vez cada 20 horas, entre un décimo y un cuarto de la hora
  de su presa (hoy ~20 %). Las dos lo comprueba `sim/balance_tasks_test.go` (números en
  "Quests secundarias" y "Tareas"). Una tarea no da items: uno que un NPC compre por más
  que su oro pagaría más de lo que dice (el test también lo rechaza).
- Sumideros de oro: bendiciones, viajes en barco, reparaciones, recetas de oficio, la
  fundación de un gremio, la comisión del mercado, el alquiler de las casas (T5.4) y la
  forja (cada intento cuesta oro y piedras de temple, y un fallo puede destruir la pieza:
  "Forja").
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
- Se usa en un **tablero del mercado** de cada ciudad (Puerto, Ivernel y, desde la
  auditoría de contenido m7, Cinderstead), parado junto a
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
- **Equipables** ("Atributos de items"): una oferta de venta es una instancia con su
  atributo, elegida por quien vende, y se lista como una fila propia; una oferta de compra
  la llena cualquier instancia, de a una, la que elija quien le vende.
- **Lo que se ve:** al buscar un item, sus mejores `list_size` ofertas de venta (más
  baratas primero; las de un equipable, además, la más barata de cada clase de pieza:
  "Atributos de items", Mercado) y de compra (mejor pago primero), sus propias ofertas, el buzón, su
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
  vuelven a su último guardado escrito (pierden lo jugado desde ahí). Ese guardado nunca
  es anterior a lo que soltaron al suelo fuera de una casa, y desde el lote 16 tampoco
  en una caída del servidor: cuando un personaje tira algo a la calle (o el servidor se
  lo deja a los pies), su estado del final de esa acción se guarda en el acto, o, si ya
  tiró algo en los últimos 2 s, junto con lo demás al cerrar esa ventana de 2 s (o
  antes, con su próximo intercambio, compra, venta, retiro del buzón o cambio en una
  casa), sin que se note. Hasta que la base confirma ese guardado, lo tirado queda
  **reservado** a quien lo tiró: él puede volver a tomarlo, y otro jugador recibe "Eso es
  de otro jugador por ahora." (`inventory.not_yours`) durante como mucho esos 2 s más lo
  que tarde la escritura (normalmente unos ticks). Así ni una caída ni un intercambio
  descartado dejan un item en dos personajes. Para que la reserva nunca se quede con lo
  de otro, en la calle nada entra en una bolsa o un cadáver ajeno (`inventory.street_bag`:
  "En la calle solo puedes guardarlo en algo que acabas de soltar tú: déjalo en el
  suelo."), y lo tirado no se suma a una pila igual ya confirmada, aunque sea propia:
  forma una pila aparte, así que una casilla se llena antes (`inventory.tile_full`).
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

## Baúl de la cuenta (decisión del dueño, 2026-11-23)
Un baúl por **cuenta**, compartido por todos sus personajes: lo que uno guarda, otro de la
misma cuenta lo saca, en cualquier pueblo. Las recompensas siguen siendo por personaje (no
cambia nada de quests, cofres ni hitos) y siguen pudiendo estar en línea a la vez dos
personajes de una cuenta (docs/05 "Límites"). Números en `balance.yaml → stash` (docs/06).
- **Dónde:** un cofre `stash_chest` junto al tablero del mercado de cada pueblo (Puerto,
  Bosque, Karvask y Thimblewick). Se abre con click derecho (o "Usar") **al lado** del
  cofre (1 casilla, como una estación); alejarse cierra la ventana. Por ahora no hay baúl en
  las casas.
- **Lugar:** `slots` celdas (30). Cada celda es una pila, una instancia o un contenedor con
  todo lo que lleva adentro. Una pila que se guarda se suma a una pila igual del baúl que
  tenga lugar para todas las unidades; si no, ocupa una celda libre. Con el baúl lleno solo
  entran unidades a una pila que ya tiene. Si un día baja `slots`, nada se pierde: mientras
  tenga más celdas que `slots` no entra nada, ni siquiera unidades a una pila que ya tiene;
  se puede sacar hasta volver a `slots`.
- **Qué entra:** solo lo `tradeable` (un contenedor, solo si todo lo de adentro también lo
  es): un item de quest nunca pasa de un personaje a otro de la cuenta. No entra lo ofrecido
  en un intercambio abierto ni nada durante el bloqueo PvP. El personal del juego no lo usa
  (como el mercado).
- **Qué conserva:** todo: cantidad, atributo, valor y refinado de un equipable, cargas de
  una runa, contenido de un contenedor. Sacar algo lo pone en la mochila (y si no hay lugar,
  en los bolsillos); si no entra o pesa demasiado, se queda en el baúl. Una pila simple que
  pesa más de lo que se puede cargar se saca en partes: la ventana pide las que entran.
- **Seguro ante caídas:** cada guardar o sacar se escribe en una sola transacción con el
  personaje (docs/01 "Transacciones"): un item está en el baúl o en el personaje, nunca en
  los dos ni en ninguno, pase lo que pase con el servidor. Dos personajes de la cuenta en
  línea ven el mismo baúl en vivo; si los dos piden el mismo item a la vez, uno lo saca y al
  otro se le dice que ya no está. Tras sacar algo, el personaje no puede tirarlo a la calle
  hasta que el guardado se confirma (normalmente un tick o dos).
- Anti-flood propio (`action_burst` / `action_refill_ms`): cada movimiento es una escritura.

## Casas (T5.4)
Mecánica conocida del género (casas del mapa que se alquilan); reglas, números, nombres y
textos propios. Números en `balance.yaml → houses` (docs/06); cada casa (casillas, puertas,
alquiler) es un dato del mapa, `world/islands/<isla>/houses.yaml` (docs/03).

- **Qué es una casa:** un área del mapa con nombre, pueblo (su isla), casillas por piso,
  una o más **puertas** (casillas de la casa donde se entra) y una **salida** afuera,
  junto a una puerta. Hoy hay 13 (auditoría de contenido M6: eran 6): seis en Lanternby
  (Puerto), cuatro en Ivernel (Bosque) y tres en Cinderstead (Volcánica), de 21 a 38 casillas.
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
| Velmara (inicial) | 1–15 | Tutorial, primera ciudad (Lanternby), Capítulo 1 |
| Selvaine (T3.6) | 10–30 | Druidas, bestias, leñador (olmo), Capítulo 2; ciudad: Ivernel |
| Karvask (T5.5) | 25–60 | Herrería avanzada (acero de ascua), dragones jóvenes, Capítulo 3; ciudad: Cinderstead |
| Islas Heladas | 40–80 | Hielo, mazmorras profundas |
| Isla Hundida | 70+ | Ruinas del imperio antiguo, final de la historia actual |

- Viaje entre islas: NPC capitán de barco, cuesta oro, requiere nivel o quest para
  algunas rutas (ver "Viajes en barco").
- Cada isla tiene superficie (piso 7), subterráneos (8–12) y alturas (6–4).

### Nombres del mundo
Pedido del dueño (2026-11-20): que las ciudades y zonas tengan nombre propio, con el sabor
de la fantasía épica clásica. Del género se toma solo el **sabor**; ningún nombre sale de
una obra ajena (regla legal de `CLAUDE.md`).

**Estilo por región**
- **Verde y costa** (islas, bosques, caletas): vocales suaves y líquidas (l, r, v, s,
  n): Velmara, Selvaine, Ivernel, Avelline, Nyssaral, Vaunel.
- **Minas, forjas, volcán**: consonantes duras y grupos ásperos (k, g, r, sk, kh, br):
  Karvask, Grakkun, Brakkhal, Skarrag, Hraskel, Vadrek.
- **Pueblos de gente común**: compuestos llanos de aire inglés, de dos palabras comunes:
  Lanternby, Cinderstead, Howlmead, Saltwrack, Fernhallow, Gullsand, Marrowdeep, Murlowe,
  Thimblewick, Pellwick.

**Reglas**
- Inventar cada nombre. Nunca un nombre, lugar, pueblo, personaje ni palabra de la obra de
  Tolkien ni de sus lenguas (nada de Rivendell, Gondor, Shire, Moria, Bree, Hobbiton; nada
  de raíces como -dor, -ost, -ithil, -wen, mithril, mellon, galad, amon, anor, mir, nen,
  el-/elen-), ni de otro juego o libro. Ante la duda, se cambia.
- El nombre propio es el mismo en es y en; la parte descriptiva se traduce («Cueva de
  Marrowdeep» / «Marrowdeep Cave», «Grakkun, la mina vieja» / «Grakkun, the old mine»).
- Solo cambian los nombres visibles. Los ids (`puerto`, `bosque`, `volcan`, `pruebas`,
  `testisle`, zonas, casas, quests, NPCs, items `brasal_*_sign`) se quedan como están; en
  docs y comentarios «Puerto», «el Bosque» y «el Volcán» siguen siendo atajos de esos ids.
- Las claves: `island.<id>.name`, `town.<isla>.name` (la ciudad de cada isla con casas),
  `zone.<id de zona>.name` (toda zona de `world/islands/*/zones.yaml`) y
  `area.<isla>.<área>.name` (cazaderos sin zona que nombran misiones y carteles), en
  `i18n/*/world.yaml`. `packages/content-schema/src/place-names.test.ts` exige que toda
  isla, ciudad y zona tenga nombre en los dos idiomas, que ningún texto use los nombres
  viejos y que ningún nombre caiga en una lista de nombres y raíces de Tolkien.
- El Farol sigue siendo la fe del templo de Lanternby (en inglés, the Lantern): el pueblo
  se llama por ella. Las casas conservan sus nombres (ya eran nombres propios: «Casa del
  Ancla Partida»).
- Un área nueva (salas de misión, islas futuras como las Islas Heladas o la Isla Hundida,
  que hoy solo tienen nombre de trabajo) toma nombre con estas reglas y agrega su clave.

**Tabla** (id → nombre es / en; entre paréntesis, el nombre viejo)

| id | es | en |
|---|---|---|
| `island.puerto` | Velmara (Isla del Puerto) | Velmara (Harbour Isle) |
| `island.bosque` | Selvaine (Isla del Bosque) | Selvaine (Forest Isle) |
| `island.volcan` | Karvask (Isla Volcánica) | Karvask (Ember Isle) |
| `island.pruebas` | Thimblewick (Isla de Pruebas) | Thimblewick (Sandbox Isle) |
| `island.testisle` | Pellwick (Islote de ensayo) | Pellwick (Test islet) |
| `town.puerto` | Lanternby (el Farol) | Lanternby (Farol) |
| `town.bosque` | Ivernel (Raigal) | Ivernel (Raigal) |
| `town.volcan` | Cinderstead (Brasal) | Cinderstead (Brasal) |
| `zone.puerto_temple` | Templo del Farol | Temple of the Lantern |
| `zone.puerto_depot` | Depósito de Lanternby | Lanternby Depot |
| `zone.puerto_plaza` | Plaza de Lanternby | Lanternby Square |
| `zone.puerto_dock` | Muelle de Lanternby (Muelle del Farol) | Lanternby Dock (Farol dock) |
| `zone.puerto_north_shore_plot` | Playa de Gullsand | Gullsand Beach |
| `zone.puerto_no_pvp` | Tregua de Velmara | Truce of Velmara |
| `zone.bosque_temple` | Templo de la Raíz | Temple of the Root |
| `zone.bosque_town` | Plaza de Ivernel | Ivernel Square |
| `zone.bosque_dock` | Muelle de Ivernel | Ivernel Dock |
| `zone.bosque_north_cove_plot` | Caleta de Vaunel | Vaunel Cove |
| `zone.bosque_arena` | Arena del Cardo | Thistle Arena |
| `zone.volcan_temple` | Templo de la Llama Quieta | Temple of the Still Flame |
| `zone.volcan_town` | Plaza de Cinderstead | Cinderstead Square |
| `zone.volcan_dock` | Muelle de Cinderstead | Cinderstead Dock |
| `zone.pruebas_town` | Plaza de Thimblewick | Thimblewick Square |
| `zone.pruebas_arena` | Arena de Thimblewick | Thimblewick Arena |
| `zone.testisle_temple` | Templo de Pellwick | Temple of Pellwick |
| `zone.testisle_dock` | Muelle de Pellwick | Pellwick Dock |
| `zone.testisle_no_pvp` | Patio de la tregua | Truce Yard |
| `area.puerto.wolf_field` | Howlmead, el campo del norte (campo de lobos) | Howlmead, the north field |
| `area.puerto.wreck_beach` | Playa de Saltwrack (playa del naufragio) | Saltwrack Beach |
| `area.puerto.west_forest` | Bosque de Fernhallow (bosque del oeste) | Fernhallow Wood |
| `area.puerto.mine` | Grakkun, la mina vieja (Mina vieja) | Grakkun, the old mine (Old mine) |
| `area.bosque.stag_woods` | Bosque de Avelline (bosque de ciervos) | Avelline Wood |
| `area.bosque.marsh` | Ciénaga de Murlowe (ciénaga del sur) | Murlowe Marsh |
| `area.bosque.deep_forest` | Nyssaral, el bosque profundo | Nyssaral, the deep forest |
| `area.bosque.smugglers_camp` | Campamento del Remo Quemado | Burnt Oar Camp |
| `area.bosque.cave` | Cueva de Marrowdeep (cueva de los contrabandistas) | Marrowdeep Cave |
| `area.volcan.ash_flats` | Llano de Hraskel (llano de ceniza) | Hraskel Flats (ash flats) |
| `area.volcan.slope` | Ladera de Vadrek (ladera de lava enfriada) | Vadrek Slope |
| `area.volcan.crater` | Cráter de Skarrag (el cráter) | Skarrag Crater |
| `area.volcan.mine` | Mina de Brakkhal (Mina de la Montaña) | Brakkhal Mine (Mountain Mine) |
| `area.volcan.forge` | La forja antigua | The ancient forge |

Los templos, los atriles y las casas ya tenían nombre propio y no cambian. Los textos de
misiones, NPCs, libros, carteles y noticias usan estos nombres (el nombre propio y, la
primera vez en cada texto, lo que es: «Hraskel, el llano de ceniza»).

### Tutorial (T4.2)
- **Quién lo ve:** solo un personaje nuevo cuya isla de origen es la del tutorial (Puerto,
  `data/tutorial.yaml → island`): nivel 1, sin experiencia y sin estado de tutorial. Un
  personaje recién creado no tiene `town` y su isla de origen es la de inicio del servidor
  (`-start-town`, o la primera de `world.yaml`), la misma cuyo templo lo recibe; en un
  servidor que hace empezar en otra isla, nadie ve el tutorial. Un
  personaje que existía antes del despliegue ya tiene experiencia o niveles y no lo ve
  nunca. No hay isla de novatos aparte: la vocación se elige al crear el personaje y el
  tutorial ocurre en el pueblo de Lanternby.
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

Además: quests secundarias, libros con lore y cofres escondidos en el mapa (ver "Libros y
cofres").

**Diario de misiones y tareas.** Cada personaje tiene su diario (ventana "Misiones", tecla L
o el libro de la botonera; una pestaña del panel en teléfonos), que el servidor le manda
entero al entrar y cada vez que cambia una quest (`QuestLog`, docs/05). Dos pestañas:
"Activas" (nombre, capítulo o "Secundaria", el texto del paso actual y, en un paso de
matar, las muertes contadas, "5/8", con una barra) y "Terminadas". La línea principal va
primero, por capítulo. Además de matar, juntar, hablar y los flags, un paso puede ser
**llegar a un lugar** (`reach`: una zona del mapa o unas casillas alrededor de un punto;
cuenta al caminar, al usar una escalera o un teletransporte, al viajar en barco y al
despertar en el templo; docs/06 "Quest"). Una quest puede ser una **tarea repetible**
(`repeatable: { cooldown_hours }`): terminada, se puede tomar otra vez cuando pasa su
espera, desde el primer paso, y paga su recompensa cada vez. Es la base de las tareas de
caza del final del juego (pedirle al jugador que vuelva a un coto cada día). El diario
muestra cuánto falta para volver a tomarla ("Disponible otra vez en 2 h 15 min") y el NPC
que la da distingue si está disponible o si todavía espera. Las tareas de caza de Ivernel
y Cinderstead están en "Tareas" (abajo); la de práctica de Thimblewick espera tres
minutos (docs/16).

**Capítulo 2 "Raíces" (T3.6, Selvaine).** Lo da Velia Musgo, la druida de Ivernel,
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
  hueco (24, cueva, mordida venenosa, ve invisibles). Con la banda 3 del catálogo un
  guardián pasa de 15 a 20 en ~2,3 h y de 20 a 25 en ~3,1 h.
- **Oficios en el Bosque:** el olmo (`elm_tree`) se tala como el abedul y da troncos de
  olmo (y resina desde woodcutting 4). Recetas: escudo de olmo en el yunque y caldo de
  hongo lumbre en el fogón; la curtidora Gisla vende el equipo de cuero de ciervo y las
  armas de la banda 3 (la hoja de espino se retiró en el lote 11; ella la sigue comprando).

**Capítulo 3 "Fuego bajo la piedra" (T5.5, Karvask).** Lo da Casia Hollín, la
guardiana de los registros de Cinderstead, solo a quien tiene el flag `ember_root_found` del
Capítulo 2. La raíz de piedra es un item (`ember_root`, no comerciable): Velia Musgo la
entrega en Ivernel a quien tiene el flag, una a la vez y hasta abrir la puerta de `ch3_gate`
(si se pierde, se pide otra). Casia y el herrero piden la raíz encima; sin ella, Casia
manda a buscarla a Ivernel. Tres quests encadenadas, todo en datos (`data/quests/ch3_*.yaml`,
`data/npcs/volcan_*.yaml`):
1. `ch3_embers` (nivel 30): matar 10 sabuesos de ceniza, juntar 6 escamas de salamandra,
   entregarlas a Casia y mostrarle la raíz a Bram Tizón, el herrero, que reconoce la marca
   de la forja antigua. 14 000 XP y 800 monedas.
2. `ch3_gate` (nivel 35): matar 10 mineros de obsidiana, conseguir un plano de galería
   (botín de los mineros), entregarlo a Casia, bajar hasta la antesala de la puerta
   sellada, en lo más hondo de la mina (un paso `reach`: llegar a 4 casillas del eco lo
   cumple, "Diario de misiones y tareas"), y mostrarle la raíz al eco de la forja, que le
   devuelve su forma: la **llave de ascua** (`ember_key`, no comerciable), que abre la
   puerta. Casia da la pista del camino en los dos últimos pasos. 22 000 XP y 1100 monedas. Quien terminó
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
- **Bestiario de Karvask** (nivel objetivo de `TestVolcanBalance`): sabueso de
  ceniza (27, velocidad 300: no se le escapa, no huye), salamandra de brasa (31, escupe brasa a distancia y deja
  ardiendo, inmune al fuego), minero de obsidiana (35, mina, lanza esquirlas que revientan sobre su objetivo y sus vecinos), gólem de
  escoria (41, mucha armadura, inmune al fuego, estalla alrededor) y dragoncillo de ascua (50, cráter,
  aliento de fuego en un rayo de 4 que deja ardiendo). Jefe: custodio de escoria (44, 1800
  de vida, golpe de escoria alrededor, dos salamandras bajo el 60 %, furia bajo el 30 %;
  pelea de 30–90 s que pide curarse o ir en grupo; "Monstruos", "Habilidades"). El fuego
  es la norma: todos resisten fuego y
  el hielo los daña más. Con el equipo de Cinderstead un guardián pasa de 25 a 30 en ~3,9 h, de
  30 a 40 en ~10,1 h y de 40 a 50 en ~15,3 h (el test pide 0,4–1,2 veces el `pace`; con el
  catálogo del lote 11, antes 3,8, 10,4 y 15,2).
- **Herrería avanzada:** la veta de ascua (`ember_vein`, minería, el mineral de ascua sale
  desde minería 8) y el botín de mineros y gólems dan mineral de ascua. En la fragua, 3
  minerales + 1 lingote de hierro + 1 tronco de olmo (del Bosque: las islas comercian) dan
  un lingote de acero de ascua (herrería 10). En el yunque, la banda 4 del catálogo (todas
  nivel 30, "Catálogo de equipo"): yelmo (herrería 12), sable (13), hacha, maza, arco y
  escarpes (14), ballesta y grebas (15), coraza (16) y escudo (17). La cota de escamas y la
  hoja de colmillo de dragoncillo (herrería 20 y 22) son de la banda 5 desde el lote 11:
  sus recetas vuelven con la isla de esa banda. Bram Tizón vende la banda 4 y compra los
  materiales de la isla a un tercio de su valor.
- **En el mapa** (`world/islands/volcan`, T5.5 parte 2): Cinderstead al oeste (templo de la Llama
  Quieta, plaza con fragua, yunque y fogón, el archivo de Casia, una casa y, en el borde
  norte de la plaza, Orso Pedernal con el libro de presas: "Tareas"), muelle al oeste con
  Nerea Vado. Se llega desde Ivernel (`bosque_to_volcan`, nivel 25, 150 monedas) y se
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

## Libros y cofres (lote 12, 2026-11)
Explorar tiene que pagar (auditoría del 2026-11-19): la historia del imperio hundido ya no
sale solo de tres NPCs, y salirse del camino puede dar algo. Las dos cosas son items del
mapa con un bloque propio en `data/items/exploration.yaml` (docs/06 "Item").

**Libros y pergaminos.** Un atril con un libro abierto, un libro cerrado o un pergamino
(arte del motor de sprites, docs/17). Usarlo (click derecho → "Leer", o doble click) abre
la **ventana de lectura**: el título y una página a la vez, con el número de página y
botones para pasarlas; Escape o × la cierran. Mirarlo (Mayús+click) sigue dando una
línea: qué es y cómo se llama. **Decisión: la ventana es del cliente, sin el servidor.** El texto es
contenido estático (`i18n/<idioma>/books.yaml`, que el cliente ya trae, como los textos de
los NPCs), igual para todos y sin nada que esconder, como el de un cartel que se lee con
Mirar desde cualquier casilla a la vista: el cliente no manda nada al leer, así que no hay
mensaje nuevo ni regla de distancia (un libro se lee desde donde se ve, como un cartel). Un
libro no se lleva (`pickupable: false`) ni tiene estado: el mismo item puede estar en dos
lugares (el atril de Lanternby está también en Thimblewick).

Los textos son propios y siguen lo que cuentan los NPCs y los capítulos 1 a 3:

| Libro | Dónde | De qué habla |
|---|---|---|
| «Los remeros del Farol» (atril) | Templo del Farol, Puerto (3152,6381,7) | Cómo los sobrevivientes del imperio llegaron remando a una luz que nadie encendió |
| «Lo que sostiene la raíz» (atril) | Templo de la Raíz, Ivernel (4148,6101,7) | El árbol antes que el bosque; los druidas que escuchan la tierra |
| «La Llama Quieta» (atril) | Templo de la Llama Quieta, Cinderstead (3640,5785,7) | Por qué la llama del altar no tiembla; los fuegos que fueron de otros |
| «Registro de la forja, tomo tercero» (atril) | Archivo de Casia, Cinderstead (3660,5796,7) | Cinderstead nació para la forja; las llaves de piedra templada; «no se apagó, se fue» |
| «Apuntes de una herrera de Cinderstead» (libro) | Archivo de Casia (3664,5800,7) | El acero de ascua, la marca de la forja (la llama en el aro) y hasta dónde aguanta el temple |
| «Cuaderno de rastros» (atril) | El atril de Velia bajo los olmos de Ivernel (4180,6112,7) | El farol de rastreo y lo tibio que llegó del mar |
| «Manifiesto del Alba Tardía» (pergamino) | Entre los cajones del naufragio, Puerto (3119,6328,7) | La carga y el cofre pagado al triple; la luz falsa de las rocas |
| «Bitácora del remo quemado» (pergamino) | Cueva de los contrabandistas, Bosque (4219,6136,8) | El cofre bajado a la cueva y el que paga en monedas viejas, para la montaña |
| «Lo que vimos detrás de la pared» (pergamino) | Galería inundada de la mina, Puerto (3194,6287,8) | La pared tallada, la puerta cerrada desde adentro y el agua |

**Cofres de recompensa.** Un cofre de tablones con bandas de hierro (bloque `chest`: un `id`
y sus recompensas). Usarlo junto a él (a 1 casilla; click derecho → "Abrir", o doble
click) le da a **cada personaje** sus recompensas **una sola vez**: el personaje lo
recuerda en su storage (`chest.<id>`, la misma tabla que las quests; por eso el `id` de un
cofre no se renombra ni se reutiliza nunca, y `data/ids.lock.yaml` lo fija), y el storage
y los items van en el mismo snapshot, así un guardado, un logout o una desconexión en el
mismo tick nunca guardan uno sin lo otro. Reglas:
- **Todo o nada:** si todas las recompensas no entran (capacidad y lugar en la mochila,
  contando las pilas que se suman a las que ya lleva, como el `give_item` de un diálogo)
  no da nada, no lo marca y lo dice (`chest.no_room`); el jugador libera lugar y lo abre de
  nuevo. Nada cae al suelo.
- **Otra vez:** "El cofre está vacío" (`chest.empty`); dos usos en el mismo tick dan una
  sola vez.
- **Lo que da:** dinero, las piedras de temple de su banda, pociones y una pieza del
  catálogo de su banda que sirve a cualquier vocación. Un equipable se crea como cualquier
  otro (`giveItem`): tira su atributo al azar (docs/02 "Atributos de items"). Nunca el
  ámbar de resguardo (la protección de la forja solo cae de monstruos), nunca un item
  retirado ni uno que no se levanta (`pickupable: false`), y cada recompensa es una pila
  como mucho (`make validate` y el arranque del servidor lo revisan).
- **Por personaje, no por cuenta (para que el dueño lo decida):** las recompensas se pueden
  comerciar y `puerto_grove` está al alcance de un personaje de nivel 1 en la isla de
  inicio, así que cada personaje nuevo de una cuenta saca otra vez sus 2 piedras de temple
  menores y un gorro con su atributo al azar, y puede pasárselos al principal. Es lo
  pedido (como las quests, que también son por personaje) y lo que da es poco; si se
  quiere cerrar, el cofre podría recordarse en la cuenta o dar sus piezas sin comercio.
- **Economía:** cada unidad se registra en `economy_log` con la fuente `chest` y el id del
  cofre (docs/01 "Log de economía"); cuenta como ganancia para los atípicos, como el botín.
- **El cofre se ve siempre cerrado.** Mostrarlo abierto solo a quien ya lo abrió pediría
  estado del mapa por personaje (los items del mapa son los mismos para todos): no vale lo
  que cuesta. El mensaje del servidor dice si ya estaba vacío.

| Cofre | Dónde | Banda | Recompensas |
|---|---|---|---|
| `puerto_mine` | Fondo de la mina de Puerto, en el nicho de la galería inundada, pasando los mineros ahogados (3193,6286,8) | 2 | 3 de plata, 3 piedras de temple menores, 5 cataplasmas de algas, escudo de tablones |
| `puerto_grove` | Bajo los robles de la esquina noroeste del bosque de Puerto, lejos de los caminos (3107,6353,7) | 1 | 1 de plata, 2 piedras de temple menores, 3 cataplasmas de algas, gorro de lona |
| `bosque_cave` | Nido de los reptantes de la cueva de los contrabandistas, Bosque (4252,6170,8) | 3 | 6 de plata, 2 piedras de temple mayores, 3 brebajes de vida, capucha de cuero de ciervo |
| `volcan_mine` | Mina del Volcán, pasando los gólems: esquina noreste de su galería (3734,5782,8) | 4 | 15 de plata, 4 piedras de temple mayores, 3 brebajes de vida concentrados, amuleto de brasa |
| `pruebas` | Templo de Thimblewick (2098,2084,7), para probarlo (docs/16) | — | 5 de plata, 2 piedras de temple menores, 2 brebajes de vida, espada de hierro |

Cada isla nueva trae los suyos al final de sus mazmorras, con las recompensas de su banda.
### Quests secundarias (lote 12)
Pedido del dueño del 2026-11-18 (un mundo con quests por banda de nivel) y auditoría de
juego del lote 10: entre `ch2_coffer` (20) y `ch3_embers` (30), y después del custodio
(40), solo se cazaba. Cinco quests secundarias llenan esos huecos con NPCs que ya estaban
en los pueblos y que no daban encargos. Todo en datos (`data/quests/*.yaml`, los diálogos
de `data/npcs/`); las ofrece la opción del NPC desde su nivel (`level_at_least`) y sin la
quest empezada. `ferryman_jetty` pide además `ch2_roots` completada (`quest_state`): sigue
al "bote sin bandera" del Capítulo 2, y quien no lo vio no entendería el encargo.

| Isla | Niveles | Quest | La da | Pasos | Recompensa |
|---|---|---|---|---|---|
| Puerto | 8 | `diver_locket` "Lo que el mar se llevó" | Corvo, el buzo | un relicario de los saqueadores, entregarlo | 900 XP, 200 monedas |
| Puerto | 10 | `foreman_ore` "Hierro de las vetas viejas" | Doran Pike, el capataz | 5 minerales de hierro, entregarlos | 1200 XP, un pico |
| Bosque | 22–25 | `ferryman_jetty` "Luces en la costa este" (con `ch2_roots` completada) | Tavin Rema, el barquero | llegar al embarcadero de los contrabandistas (`reach`), matar 12 reptantes huecos en la cueva de al lado, contárselo | 7000 XP, 700 monedas |
| Bosque | 25–28 | `tanner_chitin` "Cuero de quitina" | Gisla, la curtidora | 8 quitinas de reptante, 4 corazones de espino, entregarlos juntos | 9000 XP, un amuleto de asta, 750 monedas |
| Volcán | 30–33 | `captain_fenders` "Defensas que no arden" | Nerea Vado, la capitana | matar 10 salamandras de brasa, 5 pieles de sabueso de ceniza, entregarlas | 13 000 XP, 900 monedas |
| Volcán | 42–45 | `smith_ring` "El anillo de obsidiana" | Bram Tizón, el herrero | 5 núcleos de escoria, entregarlos, pedirle a Madre Oriela una brasa de la Llama Quieta (`flag_equals`: su opción pone el flag), volver por el anillo | 25 000 XP, un anillo de obsidiana, 1500 monedas |
| Volcán | 45–48 | `flame_crater` "La llama del cráter" | Madre Oriela, la sacerdotisa | llegar a la orilla del lago de lava del cráter (`reach`), matar 6 dragoncillos de ascua: **termina en esa muerte** | 28 000 XP, un amuleto de brasa, 1800 monedas |

Con la línea principal, la secuencia queda: 15 `ch2_roots`, 20 `ch2_coffer`, 22 y 25 las
del Bosque, 30 `ch3_embers` y `captain_fenders`, 35 `ch3_gate`, 40 `ch3_warden`, 42 y 45
las del Volcán. Del 48 en adelante solo queda la tarea de los dragoncillos hasta la isla
de la banda siguiente.

- **Experiencia:** alrededor del 12 % (entre 10 y 15 %) de la experiencia de su banda: de
  su nivel a tres más arriba (`sim/balance_tasks_test.go`, `TestSideQuestRewards`). Del 22
  al 25 son 56 376 puntos (7000 son el 12,4 %); del 25 al 28, 72 144 (12,5 %); del 30 al
  33, 102 744 (12,7 %); del 42 al 45, 198 216 (12,6 %), y del 45 al 48, 226 944 (12,3 %).
  Los capítulos pagan algo más (`ch2_coffer`, ~19 % de la suya; `ch3_warden`, ~20 %). En
  tiempo, una quest secundaria vale entre 14 y 33 minutos de la mejor caza de su nivel
  (más arriba, más: las bandas se estiran), más o menos lo que cuesta hacerla.
- **Oro:** entre 4 y 10 minutos del botín de la mejor caza de la banda ("Economía"): 5,7
  minutos de reptantes (`ferryman_jetty`), 6,1 (`tanner_chitin`), 6,7 de salamandras, 6,7
  de gólems y 5,9 de dragoncillos.
- **Equipo:** a lo sumo un equipable por quest, de una banda que ya se consigue y que se
  puede llevar a su nivel; tira su atributo como cualquier pieza creada ("Atributos de
  items"). El anillo de obsidiana era solo botín raro: es la primera fuente segura. Va
  después de la experiencia y antes del oro en la lista de recompensas, que se dan en
  orden: la experiencia puede subir el nivel, y con él la capacidad, así que quien no
  podía cargar el item antes de cobrar lo recibe en la mochila y no en el suelo (que en
  `flame_crater` es el cráter, entre dragoncillos). Lo juega `TestFlameCraterSideQuest`, y
  `sim/balance_tasks_test.go` (`TestQuestRewardOrder`) exige a toda quest de `data/` la
  experiencia, el item y el oro en ese orden.
- **Lo que piden:** todo `has_item` tiene una fuente a 4 niveles o menos de la quest
  (`TestPuertoBalance`, "quest items near the quest level"): quitina (reptante, 24), corazón de espino
  (espinoso, 20), piel de sabueso (27), núcleo de escoria (gólem, 41). Ninguna pide un item
  de quest nuevo.
- **Llegar a un lugar** (`reach`): el embarcadero que armaron los contrabandistas en la
  costa este (4256,6139, radio 2, sobre las tablas) y la orilla del lago de lava en el
  corazón del cráter (3714,5756, radio 2, entre los dos nidos de dragoncillos). Los dos se
  alcanzan a pie desde el templo de su isla (`make validate`) y tienen dónde pararse
  (`TestRealWorldStarts`).
- **Termina en una muerte:** `flame_crater` no vuelve al NPC: la llama del templo "le
  avisa" a Oriela y la recompensa llega donde esté el jugador (a la mochila, o a sus pies
  si no entra). Después ella tiene una opción de agradecimiento.
- **Historia:** las cajas del embarcadero llevan el sello de la aduana de Puerto: alguien
  con permisos abastece a los contrabandistas del remo quemado (Capítulo 2), con
  compradores que no existen. Queda abierto, como quién les pagó por el cofre. El anillo y
  la llama cuentan de los sacerdotes de la forja vieja y del cráter donde se encendió la
  Llama Quieta. Ningún nombre ni texto viene de otro juego.
- **Música:** ninguna tiene música propia (`music` de la quest): el cráter es el lugar que
  la merecería si hay un tema para él.
- **Tests:** un test de sesión por quest (`session/sidequests_test.go`: oferta por nivel,
  cada paso, entrega, recompensas y la tirada de los equipables; en `tanner_chitin` y
  `captain_fenders`, que la entrega se esconde y no completa nada si el jugador vendió lo
  que pedía después de cumplir el paso, y en `flame_crater`, que la subida de nivel de la
  recompensa hace entrar el amuleto) y el de las recompensas.

### Tareas (lote 12)
Tareas de caza repetibles (`repeatable`, "Diario de misiones y tareas"): una razón para
volver cada día a un coto. Dos NPCs nuevos las dan, cada uno con tres:

- **Fenn Zarzal, montero** (`bosque_hunter`, en el borde este de la plaza de Ivernel,
  4173,6106, donde sale el camino al bosque profundo): el **tablón** del pueblo.
- **Orso Pedernal, jefe de cazadores** (`volcan_hunter`, en el borde norte de la plaza de
  Cinderstead, 3655,5783, junto al camino al llano de ceniza): el **libro de presas**.

| Tarea | La da | Desde el nivel | Presa | XP | Oro | Una hora de esa caza (simulada) | Parte de la hora |
|---|---|---|---|---|---|---|---|
| `bounty_smugglers` | Fenn | 15 | 25 contrabandistas del cofre | 4500 | 1200 | 22 216 XP, 6068 de botín (nivel 16) | 20,3 % y 19,8 % |
| `bounty_thornlings` | Fenn | 18 | 25 espinosos | 5000 | 1000 | 25 358 XP, 5169 (nivel 20) | 19,7 % y 19,3 % |
| `bounty_crawlers` | Fenn | 22 | 30 reptantes huecos | 6200 | 1450 | 30 976 XP, 7351 (nivel 24) | 20,0 % y 19,7 % |
| `bounty_hounds` | Orso | 26 | 30 sabuesos de ceniza | 6700 | 1150 | 33 632 XP, 5786 (nivel 27) | 19,9 % y 19,9 % |
| `bounty_golems` | Orso | 39 | 20 gólems de escoria | 9100 | 2650 | 45 736 XP, 13 396 (nivel 41) | 19,9 % y 19,8 % |
| `bounty_wyrmlings` | Orso | 48 | 8 dragoncillos de ascua | 10 400 | 3600 | 52 336 XP, 18 193 (nivel 50) | 19,9 % y 19,8 % |

- **Turnos:** cada una se toma en el tablón o en el libro (la opción de la presa, con
  `quest_state` `available` y su nivel), se cumple con las muertes (el diario las cuenta)
  y se cobra con el mismo NPC. Cobrada, la opción lleva a "ya la cobraste" hasta **20
  horas** después de la entrega (el reloj del servidor; `cooling_down`) y después vuelve a
  ofrecerse, desde cero. La espera es de cada jugador y empieza al cobrar (no hay un
  tablón que se renueva para todos a una hora), y así lo dicen el tablón y el libro. En
  curso no aparece en el tablón: está en el diario. Se pueden tener las tres de un NPC a
  la vez.
- **Cuánto pagan, y por qué:** una tarea suma como mucho alrededor de un cuarto de lo que
  ya da una hora de cazar ahí, en experiencia y en oro; hoy, un quinto. La hora es la de
  la simulación de balance, al nivel objetivo de la presa (`TestVolcanBalance` y
  `TestBosqueBalance`): la del que mejor caza, así que para un jugador real la tarea pesa
  algo más, y por eso el tope de un cuarto deja margen. Las muertes de la tarea son parte
  de esa hora (30 reptantes son ~14 minutos de la simulación, 8 dragoncillos ~4), y la
  espera de 20 horas la vuelve diaria: quien caza una hora al día ahí gana ~20 % más ese
  día; quien caza cuatro, ~5 %. Es un motivo para volver, no un reemplazo de la caza: el
  ritmo de "Experiencia y nivel" casi no cambia. `sim/balance_tasks_test.go`
  (`TestTaskRewards`) exige a toda tarea de una isla real entre un 10 y un 25 % de la hora
  de su presa, en experiencia y en oro, y una espera de 20 horas o más.
- **Sin items:** una tarea paga experiencia y oro. Un item como recompensa diaria podría
  venderse a un NPC por más que el oro que dice la tarea; el test rechaza cualquier item
  que un NPC compre por más que ese oro.
- **Por qué esas presas:** cada isla tiene una tarea al principio, al medio y al final de
  sus niveles (el Bosque del 15 al 26, el Volcán del 26 al 58). Los contrabandistas siguen
  volviendo a la costa este después del Capítulo 2, y el libro de Cinderstead paga por lo que
  baja de la montaña desde que la forja vieja despertó (el comienzo del Capítulo 3: el
  texto lo cuenta, así se entiende sin haberlo jugado).
- **Tests:** `session/bounty_test.go` juega la de los reptantes con muertes reales y el
  reloj del loop (oferta desde el 22, la muerte 30, el pago, el diario con "disponible otra
  vez", la espera de 20 horas al minuto y el segundo turno desde cero) y recorre las seis
  contra `data/` (nivel, pago exacto, sin items, la espera); `TestTaskRewards` exige que
  un solo NPC dé cada tarea (el tablón de un cazador nunca muestra las del otro).

### Quests de hito (lote 14, pedido del dueño del 2026-11-20)
"Quiero que el juego tenga quests que son hitos, puede ser de nivel [...] o necesidad de
equipo, necesitas 4 personas o 2 personas." Una **quest de hito** es una prueba que marca
un antes y un después: pide un nivel, a veces una pieza de equipo y, sobre todo, **varias
personas a la vez** sobre unas placas del mapa. Solo tomamos la idea (una prueba
cooperativa de placas); nombres, lugares, textos, números y recompensas son propios.

- **En los datos** (`data/quests/<id>.yaml`, docs/06 "Quest"): `milestone: true`, un
  `title` (lo que se gana) y `requires`: `level`, `players` (1 a 4), opcionalmente
  `vocations` (una por jugador: cada placa lleva la marca de una) y `gear` (un item que se
  lleva encima, o puesto con `equipped: true`, o un arma empuñada de un tipo, `weapon`:
  `sword`, `axe`, `club`, `distance` o `wand`, los `weapon.type` de los items).
  Su último paso, y solo ese, es `sigils`: las placas que hay a `radius` casillas
  (Chebyshev) de un punto y el destino `to`, la **sala de recompensa**. No es repetible.
- **Antes de empezarla:** el diario de misiones tiene una pestaña **Hitos** con todos
  ellos, también los que el personaje todavía no tomó, cada uno con sus requisitos y una
  marca de cumplido o no (nivel, equipo, su vocación entre las pedidas); la cantidad de
  personas es del grupo, sin marca. Las marcas las calcula el servidor y se mandan de
  nuevo cuando cambia el nivel o lo que lleva el personaje. La quest la ofrece un NPC
  desde su nivel (`level_at_least`), como cualquier otra.
- **Las placas** (items con bloque `sigil`, `data/items/exploration.yaml`, arte del motor
  de sprites): `sigil_plate` sirve a cualquiera; `sigil_plate_<vocación>` solo a esa
  vocación. No bloquean ni se levantan. El servidor no arranca, y `make validate` rechaza
  el mapa, si una placa queda fuera de todo hito, dos en la misma casilla, o una sobre una
  casilla no caminable, una casa o la entrada de una escalera, un agujero o un
  teletransporte (las mismas reglas en `initSigils` y `checkSigils`). Mirar una dice cuántas de su hito están ocupadas
  ("2 de 4") y, si tiene, para qué vocación es.
- **La regla (servidor autoritativo y determinista, `session/sigil.go` y
  `quest/milestone.go`):** al final de cada tick en que alguien pisó una placa (un paso, un
  teletransporte o entrar al juego sobre ella), o en que cambió lo que cumple alguien que
  ya está parado sobre una (se pone el amuleto, sube de nivel, avanza la quest: no hace
  falta bajarse y volver a subir), el servidor mira las placas de ese hito. **Solo pisa una
  placa quien tiene la quest en ese paso** (o alguien del personal): a cualquier otro el
  paso se le rechaza con `milestone.fail_step`, así nadie ajeno ocupa una placa para
  trabar a los que la están haciendo.
  Cuenta una placa con un jugador **vivo, conectado** (un link-dead no cuenta: salir del
  juego sobre la placa es dejarla; pero sigue parado encima mientras sea link-dead, y uno
  con bloqueo PvP lo es mientras dure el bloqueo, que no tiene tope: aceptado así) **y que no sea del personal** (un GM nunca cuenta y se lo
  dice `milestone.staff`). Una persona ocupa una sola casilla, así que nunca dos placas.
  El rechazo del paso es solo para jugadores: un monstruo puede pararse en una placa (por
  ejemplo uno de la galería de Morvund si alguien deja `morvund_gate` abierta) y la ocupa
  hasta que lo maten o se vaya; no traba a nadie para siempre.
  - Si faltan placas por ocupar, se le dice cuántas hay (`milestone.waiting`) solo a quien
    acaba de pisar una (o de cambiar lo que cumple sobre ella): los que ya esperan no
    vuelven a oírlo cada vez que alguien sube y baja de una placa.
  - Con todas ocupadas, cada uno tiene que cumplir, en este orden: **no ser de la misma
    cuenta que alguien de una placa anterior** (lote 16, anti-alts: un dueño con dos
    personajes no es un grupo; la primera placa en el orden del mapa cuenta y las
    siguientes de esa cuenta fallan con `milestone.fail_same_account`; una cuenta
    desconocida, 0, nunca se junta con otra), tener la quest en curso en ese paso, la
    vocación de su placa, el nivel y el equipo. Quien no cumple oye por
    qué (`milestone.fail_same_account`, `fail_step`, `fail_vocation`, `fail_level`,
    `fail_gear`) y los demás
    quién falta (`milestone.not_ready`); **nadie se mueve**.
  - Si todos cumplen, el servidor busca una casilla libre para **cada uno** alrededor de
    `to` (la misma búsqueda por anillos de un portal: `searchRings` con su área, nunca una
    casa ni la entrada de un portal, a `travel.arrival_radius`) y con el bloqueo PvP de un
    portal (un atacante bloqueado no entra a una zona de protección desde afuera: oye
    `pvp.protection_locked` y los demás, con `milestone.not_ready`, a quién esperan). Si no
    hay lugar para todos, nadie se mueve (`milestone.blocked`) y la sala no se vuelve a
    mirar sola cuando se libera: hay que bajarse de una placa y volver a subir (lo dice el
    texto, "Prueben de nuevo"). Si lo hay, los lleva juntos
    en el mismo tick, cumple el paso de cada uno (las recompensas de la quest, como
    cualquier último paso) y les anuncia a todos `milestone.achieved` con los nombres.
  - **No hace falta un grupo** (decisión del dueño): desconocidos pueden hacerlo juntos.
    El sistema de grupos no se toca.
- **Una vez por personaje:** la quest terminada no vuelve a estar en ese paso, así que un
  veterano ya no cuenta en las placas (no puede "llevar" a otros por segunda vez). La sala
  de recompensa tiene un cofre que da una vez por personaje (`content.ChestKey`, "Libros y
  cofres"). Se sale por un teletransporte de un solo sentido (o, si la sala está detrás de
  una puerta con llave, por esa puerta, que se abre desde adentro); `make validate` exige
  que desde la sala se llegue a un templo sin llaves ni herramientas.
- **El logro:** el título (`quest.<id>.title`) se ve en la pestaña de terminadas del
  diario, y el anuncio a los participantes sale en su chat. Un hito terminado aparece a
  propósito en las dos pestañas, Hitos (con todos, hechos o no) y Terminadas.

| Hito | Isla | Nivel | Quién | Lo da | Placas | Recompensa |
|---|---|---|---|---|---|---|
| `ms_thalorn_oath` "El juramento de Thalorn" | Bosque (cripta bajo las piedras al noreste de Ivernel, piso 8) | 20 | 2 personas, cualquier vocación | Hermano Olmar (`bosque_priest`) | 4207,6090 y 4213,6090 | 6600 XP, anillo de zarza, 600 monedas; cofre: 4 de plata, 1 piedra de temple mayor, 3 brebajes de vida. Título "Testigo del Juramento" |
| `ms_orthavel_vigil` "La vigilia de Orthavel" | Bosque (bajo los robles al sur de Ivernel, piso 8) | 25 | 1 persona con el **amuleto de asta puesto** (solo lo da `tanner_chitin`; ninguna tienda lo vende; Gisla talla otro por 400 monedas si se pierde antes de terminar el hito) | Fenn Zarzal (`bosque_hunter`) | 4178,6125 | 8600 XP, botas de cuero de ciervo, 700 monedas; cofre: 5 de plata, 2 piedras de temple mayores, 3 brebajes de vida. Título "Vigía del Asta" |
| `ms_morvund_embers` "Las cuatro ascuas de Morvund" | Volcán (cámara al norte de la galería oeste de la mina, piso 8) | 35 | 4 personas, **una de cada vocación**, cada una con la **llave de ascua** (`ch3_gate`) | el eco de la forja (`volcan_forge_echo`) | guardián 3647,5755; arcanista 3657,5755; montaraz 3647,5761; druida 3657,5761 | 19 000 XP, la **llave de Morvund**, un yelmo de acero de ascua, 1300 monedas; cofre: 10 de plata, 3 piedras de temple mayores, 3 brebajes de vida y de maná concentrados. Título "Mano de las Cuatro Ascuas" |

- **La galería de Morvund** (la recompensa de acceso): un coto de caza chico (21x13) detrás
  de una puerta con llave (`morvund_gate`) en la pared oeste de la cámara, con mineros de
  obsidiana y gólems de escoria. Solo entra quien lleva la llave de Morvund (no se
  comercia); quien la pierde le pide otra al eco. Como toda puerta con llave, abierta deja
  pasar a cualquiera y desde adentro se abre sin llave.
- **Economía:** cada hito paga como una quest secundaria de su nivel (10–15 % de la
  experiencia de su banda, el oro entre 4 y 10 minutos de la mejor caza, un equipable de
  una banda que ya se consigue): `sim/balance_tasks_test.go` (`TestMilestoneRewards`) lo
  exige. Todos los participantes cobran la recompensa entera.
- **Nombres:** Thalorn, Orthavel y Morvund son inventados (con aire de Tolkien, ninguno
  suyo); la otra rama del lote 14 (`feat/place-names`) renombra pueblos y zonas en el
  mismo estilo.
- **Tests:** `quest/milestone_test.go` (requisitos, completar juntos, placas a medio
  ocupar, vocación equivocada, personal, salir del juego, una sola vez),
  `session/sigil_test.go` (2 y 4 jugadores en un mapa de prueba, el diario con los hitos
  sin empezar, la mirada a una placa, el paso rechazado sin la quest, la re-evaluación al
  ponerse el equipo o subir de nivel sobre la placa, la sala sin lugar, el bloqueo PvP,
  la muerte y el link-dead en combate sobre una placa, el veterano rechazado, el aviso de
  espera solo a quien llega, una placa suelta que no deja arrancar),
  `session/sidequests_test.go` (Gisla talla otro amuleto de asta), `session/sigil_map_test.go` (los tres en el mapa
  real, los cofres y la puerta de la galería), el validador de mapas
  (`packages/map-format`, "checks milestone plates") y de contenido, y el E2E
  "milestones" de `e2e/game.spec.ts` (dos desconocidos en Thalorn).

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
- **Gestionar:** cualquiera puede salir; el líder expulsa, pasa el liderazgo y apaga (o
  vuelve a prender) la experiencia compartida. Pasar el liderazgo y prender o apagar cuentan para el
  anti-flood del chat (cada cambio se anuncia a todos). Un grupo que queda con un solo miembro se disuelve.
- **Desconexión:** salir del mundo (logout, conexión caída, cliente lento, reloguear en
  otro lado, expulsión de staff) es salir del grupo. Si era el líder, el liderazgo pasa al
  miembro más antiguo. Sus invitaciones (enviadas y recibidas) se borran. Los grupos **no
  se guardan**: tras un reinicio o un relogueo hay que volver a formarlo. Morir no saca a
  nadie del grupo.
- **Experiencia compartida: prendida al formar el grupo** (`shared_by_default: true`,
  decisión del dueño 2026-11-20: estar en grupo con otro jugador tiene que dar más
  experiencia sin tener que descubrir un botón). Al formarse, los dos primeros miembros
  leen "El grupo comparte la experiencia..." en el log; el líder puede apagarla y volver a
  prenderla. Al morir un monstruo, sus shares de daño (incluido el de las condiciones de
  T3.2) se reparten como siempre, salvo los de los miembros de un grupo con la experiencia
  compartida prendida que **comparten** esa muerte. Comparte un miembro que cumple las
  tres condiciones:
  1. **Cerca:** en el piso del monstruo y a `share_distance` (24) casillas o menos de donde
     murió (Chebyshev). Vivo.
  2. **Contribuyó** en los últimos `contribution_ms` (75 s): hizo daño a un monstruo,
     curó a otro miembro herido, o un monstruo lo atacó (tanquear).
  3. **Nivel:** al menos `level_range_pct` (70 %) del nivel más alto entre los que cumplen
     1 y 2, o a lo sumo `level_gap_always` (3) niveles por debajo.

  Si comparten dos o más, los shares de daño de los que comparten forman un **pozo** que
  crece con el **bonus de grupo** y se divide en partes iguales entre ellos (también a
  quien no le pegó, como un sanador). Los miembros que no comparten cobran su propio share.
  Si comparte uno solo, no hay pozo: cada uno cobra lo suyo. El share de quien salió del
  mundo (logout o relogueo) se pierde: cuenta en el total pero no lo cobra nadie, así que
  terminar el monstruo de otro no da su experiencia. Quests: cuenta la muerte quien le
  hizo daño, como antes.
- **Bonus de grupo** (`bonus_pct_by_sharers`, decidido por el dueño: hasta +20 %). Solo
  importa **cuántos** comparten, no sus vocaciones:

  | Comparten | Bonus del pozo |
  |---|---|
  | 2 | +5 % |
  | 3 | +10 % |
  | 4 | +15 % |
  | 5 o más (hasta `max_members`, 6) | +20 % (tope) |

  La lista empieza en 2; más miembros que escalones toman el último, que es el tope. Cada
  uno cobra `pozo × (100 + bonus) / 100 / n` (enteros, redondeo hacia abajo). Ejemplo: dos
  matan un monstruo de 240 entre los dos → 240 × 1,05 / 2 = 126 cada uno, de los que 6 son
  el bonus. El chequeo de `make validate` y del arranque exige de 1 a `max_members - 1`
  escalones, cada uno de 0 a 100 y nunca menor que el anterior.

  **Cuánto rinde** (`server/internal/sim/balance_party_test.go`, `TestPartyPaceVsSolo`,
  bestiario de Puerto a su nivel objetivo, `DEBUG_BALANCE=1` imprime la tabla):
  - *Mismas presas:* si cada miembro mata lo que mataría solo (el grupo tira de varios
    monstruos a la vez y cada uno pelea el suyo), cada uno gana lo de cazar solo × (1 +
    bonus): +5 % de a dos, +10 % de a tres, +15 % de a cuatro, +20 % de cinco en adelante,
    menos el redondeo hacia abajo del reparto (menos de 1 punto por presa). Ej. lobo (28)
    a nivel 4: 4340 xp/h solo, 4495 de a dos, 5115 de a cinco. En las presas de 6–8 de
    experiencia (rata de sentina, gaviota ladrona) ese redondeo se come casi todo el bonus.
    El test pasa por la fórmula real del reparto (`content.Party.SharedEach`, la misma que
    paga `shareExperience`).
  - *Foco en un monstruo:* si todo el grupo le pega al mismo (la pelea dura 1/n, pero
    caminar, juntar el loot y descansar siguen igual), cada miembro gana bastante menos que
    solo (61–67 % de a dos, 25–33 % de a seis, según el monstruo; el test exige un piso
    por tamaño de grupo, 55 % de a dos a 22 % de a seis, en monstruos de 20 o más de
    experiencia). El bonus no compensa
    cazar en fila presas fáciles: paga cazar monstruos más duros o abrirse y tirar de
    varios. Ver "Pendientes" en docs/14.
- **Una cuenta, un miembro que comparte (anti-alts).** Dos personajes de la misma cuenta
  (el `account_id` que la sesión ya tiene) cuentan como **uno** al compartir: comparte el
  primero en orden de entrada al grupo **que califica** (el filtro de nivel corre antes,
  sobre todos, alts incluidos, y el alt más alto también fija el nivel tope del
  anti-carry), así que un alt bajo que entró primero no le quita el bonus a su personaje
  principal; el otro cobra solo el share de su propio daño,
  sin bonus. Así un jugador con dos clientes abiertos no se arma un grupo de alts para
  cobrar el bonus, y un personaje con su alt no forma un pozo (es un solo "compartidor").
  El indicador y la marca "comparte" siguen la misma regla. Un personaje sin cuenta
  (`account_id` 0: personajes armados a mano en tests o bots) nunca se agrupa con otro.
  `TestSharedExperienceSameAccountAlts` lo fija.
- **Anti-carry.** Un personaje alto no puede subir a uno bajo: el bajo queda fuera por
  nivel (condición 3), así que solo cobra el daño que él mismo hizo, y el alto, sin nadie
  más que comparta, cobra lo suyo sin bonus. Estar al lado sin hacer nada tampoco alcanza
  (condición 2), ni ayudar desde lejos (condición 1). El bonus solo existe entre dos o más
  que cumplen las tres. `TestSharedExperienceAntiCarry` lo fija.
- **Loot:** igual que sin grupo, es de quien hizo más daño.
- **Indicador:** apagada, activa o inactiva. Cada miembro lo calcula solo con los miembros
  que ve (él incluido): activa si al menos dos de ellos cumplen 2 y 3 ahora mismo. Así ni
  el indicador ni la marca "comparte" delatan que un miembro lejos murió o está peleando.
  La distancia se evalúa en cada muerte, no en el indicador. Mientras está activa, el
  `PartyUpdate` lleva el bonus de los que comparten (`bonus_percent`).
- **Qué ve el jugador** (lo que el dueño no veía antes):
  - la ventana de grupo dice "Bonus de grupo: +10 % de experiencia (3 comparten)" mientras
    el reparto está activo, con la marca "Comparte" en cada miembro que comparte, y una
    línea de ayuda que explica qué da un grupo (también sin grupo);
  - la bandeja de estados muestra el ícono `party_bonus` (dos compañeros) con el
    porcentaje escrito ("10%") mientras el bonus está activo; lo arma el cliente con el
    `PartyUpdate`, no viaja en `PlayerConditions`;
  - el número flotante de experiencia de una muerte compartida marca la parte del bonus:
    "126 (+6 grupo)". Esa parte solo la ven el que la cobra y los miembros de su grupo; un
    extraño al lado ve solo "126".
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
- **Ambiente** (lote 18, pedido del dueño del 2026-11-23; `livingworld/README.md`
  "Ambiente"): ya no es un loop por isla. Bajo la música suena lo que hay alrededor del
  jugador: olas cerca del mar, viento en la arena (y una brisa suave en el pasto), viento
  en los árboles de un bosque, la lava, gotas en las cuevas y un murmullo donde hay puestos
  y bancos; y, cerca de cada uno, el agua de una fuente o un pozo, el crepitar de un fogón
  o un brasero, una antorcha o un farol y la fragua, paneados según de qué lado están. Las
  capas entran y salen con fundidos lentos, sin cortes, y cada loop arranca en un punto
  distinto. Usa el canal y el volumen de ambiente.
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

## Senderos (mundo vivo, lote 17, pedido del dueño del 2026-11-23)
"Si muchos jugadores caminan sobre el pasto, empieza a verse la tierra; cuando dejan de
pasar, el pasto se recupera." Es estado compartido: todos ven los mismos senderos, así que
lo lleva el servidor (contrato en `livingworld/README.md`, números en
`data/livingworld/wear.yaml`).
- **Qué desgasta:** cada paso de un **jugador** sobre un suelo de superficie `grass` o
  `tall_grass` (`ground.surface` de `data/items`; la lista es `surfaces` de `wear.yaml`)
  suma `player_step` (4) puntos a esa casilla, hasta `max` (2400). Los **monstruos no**
  (`monster_step: 0`): deambulan siempre por sus zonas y las pelarían aunque nadie pase;
  se puede subir si se quiere que un cubil se note. Los NPCs nunca, ni un jugador
  invisible (su sendero delataría por dónde anda quien no se ve).
- **Recuperación:** cada `decay_every_ms` (1 min) cada casilla gastada pierde `decay` (2)
  puntos: desde el tope, el pasto vuelve en 20 h. También mientras el servidor está
  apagado: al arrancar se descuenta ese tiempo.
- **Niveles** (`levels`: 400, 1000, 1800): 0 nada, 1 pisoteado, 2 gastado, 3 tierra
  pelada. Tres pasos por minuto en una casilla durante tres horas dejan tierra pelada.
  La hierba alta, las matas y las flores (`trample` en `data/livingworld/plants.yaml`) se
  dibujan aplastadas desde el nivel 1.
- **El mapa no cambia:** el desgaste es una capa que el cliente dibuja sobre el suelo; los
  caminos que ya están dibujados en un pueblo (tierra) no se tocan ni desgastan, y nada
  escribe en `world/`. No cambia la velocidad ni ninguna regla: es solo cómo se ve.

## Apariencia (lote 13, pedido del dueño del 2026-11-19)
"Debiéramos tener una ventana de personalización", y que los demás vean lo que lleva cada
uno. Todo jugador, NPC que es una persona y monstruo humanoide es un humanoide del motor de
sprites (docs/17 "Humanoides del motor"): un cuerpo y, encima, lo que lleva puesto.
- **Hombre o mujer** (pedido del dueño del 2026-11-20: "ojo el personaje principal puede ser
  hombre o mujer"): es lo primero que se elige (dos botones, "Hombre" y "Mujer"), y se
  cambia gratis como el resto. Es una elección aparte del cuerpo: robusto o esbelto valen
  para los dos, así que hay cuatro cuerpos. La mujer se distingue a la escala del juego por
  los hombros más angostos y caídos, la cintura y la línea de la cadera, un pecho apenas
  sugerido y la mandíbula más chica, sin sexualizar; su ropa de torso tiene el cinturón en
  la cintura y la túnica un poco más larga. Tiene la misma altura que el hombre: el
  esqueleto es el mismo, para que cascos, armas, botas y peinados le queden a los cuatro
  cuerpos (docs/17 "Humanoides del motor"). Todos los peinados y barbas sirven para los dos;
  al elegir "Mujer" la barba vuelve a "Sin barba" (se puede elegir otra después), y "Al
  azar" elige el sexo y, para una mujer, sin barba. Los NPCs y monstruos humanoides tienen
  el sexo que dicen sus nombres y textos.
- **El aspecto del personaje:** sexo, cuerpo (robusto o esbelto), piel, peinado, color de pelo
  (tiñe pelo y barba) y barba, de las elecciones de `data/looks.yaml` (docs/06 "Looks"; las
  pieles `creatures_only`, la de los ahogados y la ceniza, son solo de NPCs y monstruos).
  Se elige al **crear el personaje**, con una figura que camina en el lugar y gira con las
  flechas (y "Al azar"), y se cambia **gratis y cuando se quiera** en la ventana
  **Apariencia → Personalizar** (tecla O; "Guardar aspecto"). El cambio lo ven al instante
  todos los que tienen al jugador a la vista. Para que nadie inunde a los demás con
  cambios, hay un tope (`limits` de `looks.yaml`: 6 seguidos, después 1 cada 1,5 s); lo que
  pasa se descarta.
- **Personajes de antes:** el que no tiene aspecto guardado (creado antes del lote 13) o
  tiene uno que ya no está entre las elecciones recibe al entrar uno elegido de su id
  (siempre el mismo para el mismo personaje; con barba, siempre hombre) y lo guarda; lo
  puede cambiar gratis. De un aspecto guardado solo se reemplaza lo que ya no está entre
  las elecciones: el resto, y sobre todo el sexo, se conserva (a una mujer cuya barba
  desapareció le toca sin barba). Uno guardado antes del sexo (migración 00022) conserva
  todo su aspecto y es hombre si tiene barba; sin barba recibe el sexo que sale de su id
  (`content.Looks.SavedLook`). El resto de lo que sale del id no cambió.
- **Textos al jugador:** el español que le habla al jugador no da por hecho que es un hombre
  (nada de "bienvenido", "listo" o "entero" dirigidos a él): se escribe neutro cuando suena
  natural ("Ya pisas tierra firme", "Vuelve con vida", "Tengo heridas"; los estados son
  sustantivos: Veneno, Prisa, Saciedad). Si algún texto nuevo no se puede decir neutro, se
  usa un `select` de ICU sobre un parámetro `sex` (hoy ninguno lo necesita). El inglés no
  cambia.
- **Lo que se ve puesto:** la pieza de cabeza, el torso, las piernas, los pies y lo de cada
  mano, cada una con su `worn` (forma y material del catálogo); las joyas, la mochila, la
  munición y lo de adentro de un contenedor nunca se ven. Equiparse, sacarse algo, una pieza
  que se rompe en la forja, lo que cae al morir o lo que se vende o se intercambia cambian
  la figura para todos los que la ven. Una capucha tapa el pelo y un yelmo cerrado, el pelo
  y la barba (`hides`); en la ventana de Apariencia la figura se muestra sin la pieza de
  cabeza, para ver el peinado que se elige.
- **El atuendo** (la tienda, T5.7) ya no da el cuerpo, solo la ropa: el de siempre
  (`citizen`) llena con su ropa el torso, las piernas y los pies vacíos; uno de la tienda
  tapa esos tres aunque haya armadura, y el casco, el escudo y el arma se siguen viendo.
- **El ataque de otro jugador** juega el clip de su arma (arco y ballesta disparan, varita y
  vara conjuran, el resto golpea), porque ahora se sabe qué lleva en la mano.
- **Solo es aspecto:** ninguna regla del juego lee el cuerpo ni lo que "se ve"; lo que da
  algo es el equipo puesto, como siempre.

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
  afuera, y perderlo no quita la marca de agresor ni el bloqueo que se traían de afuera. Hay una chica en la arena de Ivernel (Selvaine).
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

## Día y noche (pedido del dueño del 2026-11-23)

El mundo tiene un ciclo de **180 minutos reales de día y 60 de noche** (decisión del dueño);
el amanecer y el atardecer son los primeros y los últimos 15 minutos del día. La luna
cambia de fase cada día, de nueva a llena y vuelta en 8 días. La hora la lleva el servidor
(la misma para todos; con la velocidad normal sigue la hora real entre reinicios) y la manda a cada cliente.

**Por ahora es solo visual:** de noche la superficie se ve azul y más oscura (más clara y
plateada con luna llena, más oscura con luna nueva, pero nunca tanto que cueste jugar),
brillan las fogatas, antorchas, faroles y ventanas, salen las luciérnagas, y las sombras de
los personajes siguen al sol (a la mañana hacia el oeste, al mediodía cortas bajo los pies,
a la tarde hacia el este) y de noche a la luna, tenues. Ninguna regla (monstruos, daño,
visión, tiendas) depende de la hora; las cuevas no cambian. Los números están en
`data/livingworld/daynight.yaml` y el detalle en `livingworld/README.md` "Día y noche". El
staff la cambia para probar con `/time` (docs/16).

## Mundo vivo (lote 17)

Pedido del dueño (2026-11-23): el mapa se puede romper en muchas cosas para que el mundo se
sienta vivo, pero **los muros nunca se rompen**; algunos objetos hay que romperlos o moverlos
para avanzar. Todo el detalle (contrato, datos, números) está en
[`livingworld/README.md`](../livingworld/README.md); acá, las reglas de juego:

- **Romper.** Cajas, barriles, vasijas, enredaderas espinosas, matorrales espesos, rocas
  agrietadas, barricadas podridas y telarañas tienen puntos de vida y una lista de formas
  que los rompen: cuerpo a cuerpo (con el arma o a mano limpia: 5 de daño), cualquier ataque
  (también un arma a distancia o una varita en rango), hacha, pico o fuego (un hechizo de
  área de fuego sobre su casilla, o una varita de fuego). Se golpean con "usar" sobre el
  objeto (o usando la herramienta sobre él), al ritmo de los oficios. Una forma equivocada
  no gasta el golpe y dice `living.wrong_way`.
- **Restos.** Roto, deja restos caminables que se desvanecen (`debris_seconds`) y vuelve a
  estar `respawn_seconds` después de romperse, solo si no hay una criatura en su casilla
  (si no, lo intenta cada segundo). Los items sueltos que haya ahí (el botín que nadie
  levantó, una moneda tirada para trabarlo) se corren a una casilla vecina libre; solo
  unos restos de criatura, que se pudren solos, lo hacen esperar.
- **Botín.** Algunos tienen una tabla chica (monedas, una galleta, una poción, seda): se tira
  una vez por rotura y cae en la casilla, a nombre de quien la rompió para la economía.
  Queda en el suelo sin dueño, a propósito: a diferencia de los restos de un monstruo,
  cualquiera que esté al lado lo puede levantar (es poco, y un objeto no es una pelea).
- **Empujar.** Una roca musgosa o un cajón pesado se empujan caminando contra ellos (en
  línea recta): se mueven una casilla si la de atrás está libre; el jugador no se mueve. Dos
  empujes en el mismo tick: el primero gana. Vuelven a su lugar `reset_seconds` después del
  último empuje, cuando no hay nadie en ese lugar (el puzzle se arma solo para el
  siguiente); los items sueltos que haya ahí se corren a una casilla vecina.
- **Placas y compuertas.** Una placa de presión se hunde con una criatura o un objeto
  empujable encima; un rastrillo se abre mientras todas sus placas (las que están a su
  radio) están presionadas y se cierra cuando una se libera, si no hay nadie debajo (un
  item suelto debajo se corre a una casilla vecina: no la traba abierta).
- **Nunca** en una zona de protección, una casa, una puerta, un muro o la pared de una sala
  con llave (romperlo, empujarlo o abrirlo dejaría entrar sin llave), y nunca como único
  camino de una quest un objeto que pide herramienta, un empujable o una compuerta.
- **Estado transitorio:** nada de esto se guarda; un reinicio deja el mundo como el mapa.
