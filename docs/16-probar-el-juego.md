# 16 — Probar el juego en Thimblewick, la isla de pruebas

**Thimblewick**, la isla de pruebas (`world/islands/pruebas`, 96x96 en 2048,2048; pisos 7 y 8) es un
sandbox para probar a mano todos los sistemas en pocos minutos: todo queda a unos pasos del
templo, y en el templo hay una instructora que da experiencia, dinero, entrenamiento (skills,
nivel mágico y oficios) y curación (vida y maná). No es parte del juego normal (ver "Por
qué la isla queda fuera del juego" al final).

## 1. Arrancar
Lo de una vez está en `12-local-development.md` ("Instalar una vez"; en Windows sin WSL,
"Windows nativo": Git Bash con el `PATH` de ese doc y Docker Desktop abierto). Después:

```
make play
```

Levanta Postgres (Docker), compila el mapa (`make mapcompile`, con `-dev`), corre el
servidor en `127.0.0.1:8080` con `-start-town pruebas` (los personajes nuevos despiertan
en esta isla) y `RPG_ENV=development` (un mundo con la isla no arranca en producción: ver
el final; solo con la base local, en `localhost`: con otra `DATABASE_URL` no la impone y el
servidor no arranca con la isla) y el cliente (Vite, puerto 5173). Cuando los dos contestan imprime:

```
[play] ready: open http://localhost:5173/play/
```

Abre esa URL. El primer arranque tarda (compila el servidor y Vite prepara los módulos). Si
algo ya contesta en `:8080` (un `make dev` abierto, un `gameserver` que quedó vivo),
`make play` no arranca y lo dice; si el servidor se cae al arrancar, también.

¿Solo quieres jugar el inicio normal, sin terminal? El lanzador de doble clic
(`NequesRealm-Servidor.exe`, `13-hosting-de-pruebas.md`, "La forma más fácil: doble clic")
levanta el servidor de casa en `http://localhost:8080` (Puerto con tutorial, sin la isla
de pruebas).

- `make play` corre además la tienda cosmética con el **proveedor de pagos falso**
  (`RPG_ENV=development`, `PAYMENTS_PROVIDER=fake`): se compra nácar sin dinero real en
  `http://localhost:5173/shop`. Solo lo activa con el servidor en `127.0.0.1` y la base en
  `localhost`; con `DEV_HTTP_ADDR=:8080` (la red de casa) o una `DATABASE_URL` remota, la
  tienda queda apagada. Ojo con un túnel SSH a una base remota en `localhost`: para
  `make play` cuenta como local.
- `make play` y `make dev` arrancan el servidor con `-cookie-secure=false` (Safari y el
  WebKit de Playwright descartan una cookie `Secure` en `http://localhost` y no quedan
  dentro) y `-auth-rate-burst 200` (crear varias cuentas seguidas sin el 429 del límite por
  IP). Son solo de estos dos comandos (`LOCAL_PLAY_FLAGS` del Makefile): producción usa los
  valores por defecto.
- Una cuenta tiene como mucho 2 personajes en el mundo a la vez (`-max-chars-per-account`,
  `05-network-protocol.md` "Límites"), también con `make play`: la excepción de loopback
  (`-ws-loopback-exempt`) no lo cubre. Para probar a mano con una sola cuenta algo de más
  personajes (una misión de hito de 4 jugadores), súbelo:
  `make play LOCAL_PLAY_FLAGS="-cookie-secure=false -auth-rate-burst 200 -max-chars-per-account 4"`
  (`-1` lo quita), o usa una cuenta por cada 2 personajes.
- `PLAY_START_TOWN=puerto make play` juega el inicio normal (Puerto, con tutorial).
- Con `make dev` (que también levanta el editor y Mailpit) los personajes nuevos despiertan
  en Puerto; `RPG_START_TOWN=pruebas make dev` los manda a Thimblewick.

## 2. Cuenta y personaje
1. En `http://localhost:5173/play/`, "¿No tienes cuenta? Regístrate": cualquier email y una
   contraseña de 8 caracteres o más. Sin SMTP no se verifica nada.
2. Entra. Una cuenta nueva va directo al formulario de creación (sin "Volver"); una con
   personajes ve primero la lista y "Crear personaje nuevo" (docs/02 "Cuentas"). Crea un
   personaje (nombre, vocación y **aspecto**: cuerpo, piel, peinado, color de pelo y barba,
   con la figura que camina en el lugar; las flechas ‹ › la giran y "Al azar" elige todo).
   Al cambiar la vocación, debajo cambian su estilo en una línea y su equipo inicial
   ("Empieza con: …"). Al crear vuelves a la lista con el nuevo marcado en dorado y su
   figura; pulsa "Jugar". El aspecto se cambia después gratis en la ventana Apariencia
   (tecla O) → Personalizar → "Guardar aspecto" (docs/02 "Apariencia").
   - **Equipo inicial** (docs/02 "Equipo inicial"): al entrar por primera vez el personaje
     ya lleva el arma de su vocación (el guardián también la tapa de barril; el montaraz 60
     flechas en el slot de munición), túnica, pantalones y botas, y en la mochila 5
     galletas y una cataplasma. Muere (los lobos de los corrales) o sal y vuelve a entrar:
     no se da otra vez.
   - **Tope de personajes:** con el máximo por cuenta (10, `auth.DefaultMaxCharacters`),
     "Crear personaje nuevo" queda deshabilitado con el motivo.
   - **Poderes de cada vocación:** con la instructora (sube nivel gratis, sección 4) mira
     que la barra tenga los hechizos nuevos al llegar a su nivel: guardián `cleave` (3) y
     `sundering_blow` (26), arcanista `cinder_lance` (18), montaraz `pinning_shot` (18).
3. Despiertas en el templo de Thimblewick (2095,2086). Aquí no hay tutorial: es
   de Puerto.

Un personaje nuevo no tiene ciudad, así que despierta (también al morir) en el templo de la
isla de inicio del servidor: con `make play`, esta. El mismo personaje, con `make dev`,
despertaría en Puerto si muere o si su posición guardada no sirve.

## 3. La isla, sector por sector
Coordenadas `x,y,z`. Todo el piso 7 salvo el sótano.

| Sector | Dónde | Qué hay |
|---|---|---|
| Templo | 2091–2099 × 2084–2090 (puerta al sur) | Donde despiertas (2095,2086). **Irene Ensayo**, instructora (2093,2085): experiencia, entrenamiento, dinero, curación y una misión. En la esquina noreste, un atril con un libro (2099,2084), un cofre de recompensa (2098,2084) y un pergamino en el suelo (2097,2084). Zona de protección con la plaza |
| Plaza | 2083–2107 × 2092–2103 | **Tobías Muestra**, proveedor, en el puesto del oeste (2086,2100). Tablero del mercado (2091,2103). Cartel del templo (2093,2092) |
| Caza (norte) | Corrales 2076–2119 × 2073–2079, sendero en y 2080–2081 | De oeste a este y de débil a fuerte: 1 ratas de sentina, 2 lobos, 3 jabalíes y una araña, 4 espinosos, 5 un dragoncillo. Cartel en 2084,2082 |
| Recolección y oficios (oeste) | Camino en y 2097–2098 | Cantera con vetas de hierro (2064–2071 × 2087–2094), abedules (2074–2080 × 2086–2094), taller con fragua (2070,2102), yunque (2073,2102) y fogón (2076,2102), muelle de pesca (2052–2055 × 2097–2098) con agua con peces alrededor. Cartel en 2080,2096 |
| Playa (suroeste) | Arena al oeste del muelle, 2077–2091 × 2124–2132 | Para probar las huellas (`livingworld/README.md`): el viento las borra en la arena seca; en las tres casillas de arena mojada junto al agua (2082–2084, 2130) las borra la ola siguiente. `/tp 2084 2129 7` |
| Patio de portales (este) | 2113–2124 × 2088–2100 | Escalera (2121,2090), trampilla de la escalera de mano (2116,2090) y agujero (2119,2094). Cartel en 2114,2096 |
| Puerta con llave (este) | Puerta de práctica en 2117,2101 | Bóveda 2114–2120 × 2102–2106. Se abre con la llave de latón. Cartel en 2115,2100 |
| Sótano (piso 8) | 2110–2127 × 2088–2106 | Sala de la escalera, sala de la escalera de mano, pozo bajo el agujero con el punto de luz para subir con cuerda (2119,2094,8), cueva de murciélagos al este y el teletransporte (2113,2104,8) que vuelve a la plaza (2095,2094). Cartel en 2124,2088,8 |
| Casa (sur) | Casa de Prueba, 2086–2091 × 2109–2113 | Puerta en 2088–2089,2114; salida en 2088,2115. Alquiler: 200 de cobre por 7 días |
| Mundo vivo (norte) | 2084–2109 × 2063–2072, entre la costa y los corrales | Jardín de piedra 2094–2098 × 2066–2070 cerrado por una **enredadera espinosa** (2096,2070), con una caja, un barril, una vasija y una telaraña. Puzzle del **rastrillo** (2105,2068): dos rocas musgosas (2101,2070 y 2105,2071) y dos placas (2102,2070 y 2105,2070); detrás, una caja, un barril y un teleport de salida (2105,2066 → 2104,2071). Un cajón pesado (2108,2070) y, al oeste, una roca agrietada (2088,2071), una barricada podrida (2090,2071) y un matorral espeso (2092,2071) |
| Arena (sureste) | 2102–2112 × 2111–2119 | Zona `pvp`, entrada por el oeste (2101,2114–2116). Cartel en 2099,2113 |
| Muelle (sur) | 2094–2096 × 2133–2138 | **Remo Vaivén**, barquero (2097,2133): viajes de ida a Puerto, al Bosque y a Karvask (20 monedas), donde llegan los barcos de verdad. Cartel en 2093,2132 |

## 4. Qué probar, en orden
1. **Instructora (templo).** Habla con Irene Ensayo (click derecho sobre ella; con el
   diálogo abierto, las teclas 1–9 eligen opción). Prueba: "Quiero experiencia" (5000 o
   50 000; dos veces 50 000 te deja en el nivel 20), "Entréname", "Necesito dinero" (una
   moneda de oro por vez), "Cúrame" (vida y maná) y "¿Tienes algún encargo?" (misión
   "Ratas de práctica").
   - La experiencia sube el nivel (vida, maná, capacidad), no las skills ni el nivel
     mágico: para eso, **"Entréname"**. Nada baja: si ya tienes más, te quedas con lo tuyo,
     y se puede pedir de nuevo después de subir de nivel.
     - **"El combate"** deja las skills de tu vocación como las de quien llegó jugando a
       los corrales 4 y 5, y el nivel mágico del último hechizo de tu vocación (con la
       experiencia gratis se prueban todos, `02-game-design.md` "Hechizos por vocación").
       Guardián: espada, hacha y maza 45, escudo 40 y nivel mágico 2. Montaraz: distancia
       45, espada, hacha y maza 30, escudo 35 y nivel mágico 9. Arcanista y druida: nivel
       mágico 30 y escudo 20.
     - **"Los oficios"**: minería, tala, herrería, cocina y alquimia 25 y pesca 40. Así
       todas las recetas del juego (la más alta pide herrería 22) quedan al alcance.
   - Lo que conviene antes de cada sector: para la caza, experiencia (dos veces "Mucha" para
     el corral 4) y "El combate"; para la runa de arco (nivel mágico 1) o "mend_other"
     (nivel mágico 2, druida de nivel 8), "El combate" basta; para el yunque, "Los oficios".
2. **Tienda (plaza).** Con Tobías Muestra, "Quiero comerciar": herramientas (pico, hacha de
   leñador, caña, martillo, cuerda), galleta, cataplasma de algas, brebajes de maná (el
   común y el concentrado; "Cúrame" también llena el maná), brebajes de vida (110 y 250,
   el común y el concentrado), runa de arco (pide nivel
   mágico 1: ver más abajo), el equipo de cada vocación (guardián: hacha de mano o espada
   de hierro desde el nivel 5 y escudos; arcanista: varita de chispa, o de coral desde el
   nivel 5; montaraz: arco corto y flechas, o ballesta de contrabandista y virotes desde el
   nivel 10, que deja usar escudo; druida: vara de retoño), ropa (la del kit inicial y,
   desde el nivel 15, la túnica de musgo para todos y el abrigo de cuero de ciervo para
   guardián y montaraz: el catálogo de docs/02), la llave de latón y una mochila
   de repuesto (una muerte desde el nivel 9 sin bendiciones deja la tuya en el cadáver, con
   lo que llevaban los bolsillos, y ya no te dan otra: ver **Bolsillos**, abajo). Prueba
   también vender (compra pescado, mineral, troncos,
   lingotes y pieles). No vende pala: todavía no hay nada que cavar en el juego. Vende
   también lo de la forja: las tres piedras de temple y el **ámbar de resguardo** (3000;
   en el juego real ningún NPC lo vende: aquí está para probar la forja, punto 4b).
   - **Atributos (docs/02 "Atributos de items"):** cada arma, escudo o pieza de armadura
     que compras trae un atributo al azar. Pasa el mouse por encima (en la mochila, en el
     equipo o en el suelo) y la ficha lo muestra en verde jade bajo las stats ("+12 de vida
     máxima", "+2 de ataque"); en la tienda la ficha dice "Trae un atributo al azar".
     Compra dos iguales para ver dos atributos distintos y equípate uno de vida: la vida
     máxima de las barras sube (y baja al sacártelo). Tobías no compra equipo; los NPCs que
     sí (el armero de Puerto) pagan lo mismo con cualquier atributo. Un `/item iron_sword 3`
     del admin (sección 5) también tira uno por espada, y lo que da el capitán del capítulo 1
     en Puerto tira igual.
   - **Runa de arco:** todo personaje empieza en nivel mágico 0 y la runa pide 1. Con
     "Entréname" → "El combate" cualquier vocación pasa de 1 (la arcanista queda en 25) y la
     runa funciona en el acto, sin subir de nivel. Sin entrenar, una arcanista llega a 1
     gastando 1450 de maná (con nivel 51 le basta vaciarlo una vez con "vita lumen").
3. **Caza (norte).** Sube por el camino al oeste del templo. Empieza por el corral 1 (las
   ratas de la misión) y vuelve con la instructora para cerrarla. Sigue hacia el este solo
   si tu nivel da: el corral 5 mata a un personaje de nivel bajo. Si algo te persigue,
   vuelve a la plaza: en la zona de protección nadie ataca.
   - **Diario de misiones y tareas** (docs/02 "Diario de misiones y tareas"): abre
     "Misiones" con la tecla **L** o el libro de la botonera (en el teléfono, la pestaña
     "Misiones"). Al aceptar "Ratas de práctica" aparece en "Activas" con su paso y "0/3";
     cada rata suma una ("1/3", "2/3") y la tercera cambia el paso a "Vuelve con Irene
     Ensayo". Es una **tarea repetible** con tres minutos de espera: entregada, pasa a
     "Terminadas" con "Disponible otra vez en 2 min 59 s" (cuenta hacia atrás) e Irene
     solo ofrece "¿Hay más ratas?" (todavía no). Pasados los tres minutos el diario dice
     "Disponible otra vez" e Irene vuelve a ofrecer el encargo: empieza otra vez en "0/3" y
     paga otra vez 200 de experiencia y 50 monedas.
   - **Tareas de caza de verdad** (docs/02 "Tareas"): no están en esta isla. Las dan Fenn
     Zarzal en Ivernel (borde este de la plaza, `/tp 4173 6108 7`; contrabandistas desde el
     nivel 15, espinosos desde el 18, reptantes desde el 22) y Orso Pedernal en Cinderstead
     (borde norte de la plaza, `/tp 3655 5785 7`; sabuesos desde el 26, gólems desde el 39,
     dragoncillos desde el 48): ve con Remo Vaivén o con `/tp`, sube de nivel con Irene antes
     de salir y pide "¿Qué paga el tablón?" o "¿Qué presas hay en el libro?". Cobrada, la
     tarea espera 20 horas; para no esperar, con el personaje fuera del juego, adelanta la
     entrega con `psql` sobre la base de `make play`: `UPDATE quest_state SET value = value
     - 72000 WHERE character_id = <id> AND key = 'quest.bounty_crawlers.done_at'` (o la que
     sea). Las quests secundarias del lote 12 (docs/02 "Quests secundarias") las dan Tavin y
     Gisla en Ivernel y Nerea, Bram y Madre Oriela en Cinderstead. La de Tavin (`ferryman_jetty`)
     pide además `ch2_roots` (Capítulo 2) completada; sin jugarlo, con el personaje
     fuera del juego: `INSERT INTO quest_state (character_id, key, value) VALUES (<id>,
     'quest.ch2_roots', 2)`.
   - **Llegar a un lugar** (un paso `reach`): hay tres, todos fuera de esta isla:
     `reach_gate` de `ch3_gate` (la antesala de la puerta sellada, en la mina de la Isla
     Volcánica), `see_jetty` de `ferryman_jetty` (el embarcadero de los contrabandistas,
     `/tp 4253 6140 7`, justo al oeste de las tablas, que en esa fila empiezan en 4254: un
     paso al este lo cumple) y
     `reach_heart` de `flame_crater` (la orilla del lago de lava del cráter, alrededor de
     3714,5756). El de la mina, paso a paso: para verlo sin jugar los capítulos, con el
     personaje fuera del juego, ponle la quest en ese paso con `psql` sobre la base de
     `make play` (`INSERT INTO quest_state (character_id, key, value) VALUES (<id>,
     'quest.ch3_gate', 1), (<id>, 'quest.ch3_gate.step', 3)`), entra, hazte gm (sección 5)
     y ve a la mina con `/tp 3691 5818 8`: el diario dice "Baja hasta la antesala..."; al
     entrar a la antesala por el pasillo (4 pasos al sur, a 4 casillas o menos del eco de
     la forja, 3692,5826,8) pasa a "Muéstrale la raíz de ascua al eco". Un `/tp` directo a la antesala también cuenta.
   - Lo que juegan los tests (sección 8), como referencia: corral 1, un guardián de nivel
     1 con hacha de mano; corral 2, un montaraz de nivel 8 con arco corto y flechas;
     corral 3, una arcanista de nivel 20 con varita de coral y 20 cataplasmas; corrales 4 y 5, un druida de
     nivel 50 que lanza "glacies hasta" (lanza de escarcha: crece con el nivel), uno por
     corral: el del 4 se trae detrás al otro espinoso, y los dos con el dragoncillo matan a
     un druida. Un guardián de nivel 21 con espada de hierro, escudo y 20 cataplasmas
     **muere** en el corral 4 con las skills en 10; **entrenado** por la instructora
     (espada 45, escudo 40) mata a un espinoso y sale vivo (`TestSandboxTraining`).
   - Áreas de monstruos (lote 10, docs/02 "Habilidades"): el espinoso (corral 4) estalla
     en espinas sobre las 8 casillas que lo rodean, y el dragoncillo (corral 5) escupe
     fuego en una línea de 4 casillas hacia su objetivo, la más cercana de las 8
     direcciones: mientras se acerca, a un salto de caballo (2 y 1) el fuego pasa al lado;
     pegado a él te da siempre. Con dos personajes, el que está en la línea o al lado del
     otro (el espinoso) también se quema. Las
     invocaciones y la furia del custodio están en la forja de Karvask.
   - Los monstruos no reaparecen donde un jugador los ve (la pantalla entera: 16
     casillas a los lados, 11 arriba y abajo): si vacías un corral, aléjate hasta que
     salga de la pantalla, entero o en parte (reaparecen en la parte que no ves), y
     vuelve.
   - Los monstruos salen de los corrales por la abertura y te siguen unas casillas por el
     sendero, pero no más allá de su correa: si te alejas, te sueltan, recuperan toda la
     vida y vuelven caminando a su corral.
   - **Salir en plena pelea no salva:** "Salir del juego" a menos de 12 s de un golpe
     (dado o recibido) dice "Estás en combate" y no sale. Cerrar la pestaña en un corral
     deja al personaje en el mundo, sin conexión y atacable, hasta 12 s después del último
     golpe; si un monstruo lo mata, muere como siempre. Volver a entrar en ese tiempo lo
     retoma donde estaba (docs/02 "Bloqueo de logout en combate").
4. **Recolección y oficios (oeste).** Con el pico, usa una veta (hierro y piedra); con el
   hacha de leñador, un abedul; con la caña, el agua con peces desde el muelle de pesca
   (alcance 3). Usa la fragua (2 minerales + 1 tronco = lingote), el yunque (con el martillo)
   y el fogón (pescado) para ver sus recetas. En el yunque un personaje nuevo no fabrica
   nada: su receta más baja pide herrería 2 y se empieza en 1 (sube con unos 20 intentos en
   la fragua, es decir 40 minerales y 20 troncos). Con "Entréname" → "Los oficios"
   (herrería 25) el yunque hace todo: por ejemplo, un hacha de leñador con 2 lingotes y 1
   tronco (4 minerales y 3 troncos en total, con la fragua). Las recetas no cambiaron: la
   herrería sigue empezando en 1 en el juego real.
4b. **Forja (el yunque del taller, 2073,2102; docs/02 "Forja").** Usa el yunque y elige la
   pestaña **Forja**. Abajo están tus piezas (las puestas y las de las mochilas abiertas):
   elige una (una espada de hierro de Tobías, por ejemplo) y la ventana dice su nivel, el
   siguiente, lo que suma, la chance en grande y lo que cuesta. Lo necesario, con Tobías y la
   instructora:
   - **piedras de temple:** la menor para piezas de nivel 1 a 9 (la espada, los escudos, la
     ropa del kit), la mayor de 10 a 49 (la ballesta) y la radiante de 50 en adelante; 1 por
     intento hasta +4, 2 de +5 a +7 y 3 de +8 a +10;
   - **oro:** "Necesito dinero" con la instructora (cada intento cuesta el oro por nivel de
     la banda por el nivel al que apunta: 3 × 5 = 15 cobre el +5 de una pieza de nivel 1);
   - **herrería** (opcional): con "Entréname" → "Los oficios" (herrería 25) la chance de los
     intentos arriesgados sube 4 puntos.

   Prueba en orden: de +0 a +4 nunca falla (chispas sobre el yunque, sin confirmación); desde
   +5 la chance baja (70, 55, 40, 25, 15 y 8 %) y el botón pide **confirmar** con el aviso en
   rojo de que la pieza se puede romper. Sin ámbar, un fallo la **rompe** (se parte sobre el
   yunque y desaparece); con el interruptor del ámbar marcado, un fallo la **baja un nivel** y
   el ámbar se gasta (se gasta también si sale bien). Pasa el mouse por la pieza: se llama
   "+5 espada de hierro" y la ficha dice "Refinado +5: +3 de ataque". Un +10 no se refina
   más. Una pieza ofrecida en el intercambio no se puede refinar hasta sacarla; lo que está
   publicado en el mercado no está en la mochila. Para probar muchos intentos seguidos sin
   gastar tanto, compra piezas de nivel 1 (las más baratas de refinar).
4c. **Libros y cofres (la esquina noreste del templo; docs/02 "Libros y cofres").** Párate
   en 2099,2085, junto al atril y al cofre. Usa el atril (click derecho → "Leer", o doble
   click): se abre la ventana de lectura con «Los remeros del Farol»; pasa las páginas con ‹ ›
   (abajo dice "Página 2 de 3") y ciérrala con Escape o ×. Lo mismo el pergamino del suelo
   (2097,2084, «Manifiesto del Alba Tardía», dos páginas). Mayús+click sobre ellos da su
   descripción de una línea. Usa el cofre: "Abres el cofre y encuentras: …" con lo
   que trae (5 monedas de plata, 2 piedras de temple menores, 2 brebajes de vida y una
   espada de hierro, con su atributo al azar: pasa el mouse por ella); úsalo otra vez: "El cofre está vacío".
   Cada personaje lo abre una vez: para repetirlo, crea otro. Para probar que no da nada
   sin lugar, llena la mochila antes (las 24 casillas, por ejemplo con piezas de Tobías) y
   los 4 bolsillos, y úsalo: "No te cabe lo que hay en el cofre", nada en el suelo; libera
   lugar y vuelve a usarlo. Los libros y cofres de las islas de verdad están en la tabla de
   docs/02.
   - **Bolsillos (docs/02 "Bolsillos", lote 13):** bajo la figura del inventario, arriba de
     la mochila, está la fila **Bolsillos**: cuatro casillas del personaje, que nunca se
     pierden ni se mueven. Arrastra algo a una, úsalo o míralo desde ahí, véndelo en el
     mercado u ofrécelo en un intercambio. Con la mochila llena, lo que compras, lo que te
     dan y lo que arrastras al slot de la mochila va a los bolsillos. Para ver la regla de
     la muerte: sin bendiciones y desde el nivel 9 (la experiencia de la instructora), muere
     con algo en los bolsillos; despiertas sin mochila y con los bolsillos vacíos, y todo
     está en tu cadáver. Con los bolsillos te alcanza para juntar monedas y comprar otra
     mochila a Tobías.
5. **Mercado (plaza).** Usa el tablero del mercado: publica una oferta de venta y compra
   con otro personaje. Con un equipo (una espada de hierro), el formulario pide **cuál**
   vender (un selector por atributo) y la oferta sale con su atributo en el listado; una
   oferta de compra de espadas se llena eligiendo cuál de las tuyas entregar, de a una, y
   la que llega al buzón del comprador es esa. El personal (GM/admin) no puede usar el mercado: prueba con cuentas
   sin rol. El intercambio directo se propone desde la lista de batalla ("Proponer un
   intercambio").
6. **Casa (sur de la plaza).** Con nivel 12 o más y dinero, usa su puerta para alquilarla;
   deja objetos adentro, invita a otro personaje.
7. **Puerta con llave (este).** Sin la llave no abre; con la llave de latón en la mochila,
   úsala para abrir y cerrar. La bóveda está vacía salvo unas cajas.
8. **Portales (este y sótano).** Pisa la escalera para bajar y la de abajo para subir. Usa la
   trampilla (doble click, o click derecho y "Trepar") para bajar por la escalera de mano y la escalera de mano de
   abajo para subir. Pisa el agujero: caes al pozo; sal por la sala de la escalera o compra
   una cuerda y úsala sobre el punto de luz para subir. Al fondo, el teletransporte te deja
   en la plaza.
9. **Arena (sureste) y PvP.** Ver la sección 6.
10. **Barco (muelle).** "Quiero viajar" con Remo Vaivén (20 monedas). Es de ida: para volver,
    `/tp` o morir (despiertas en este templo con `make play`). Es un teleport de diálogo, no una
    ruta de barco: las rutas de verdad (con su viaje y su bloqueo de combate) se prueban con los
    barqueros del Bosque y de Karvask, que no piden nada para volver a Puerto.
11. **Tienda cosmética.** En `http://localhost:5173/shop`, entra con tu cuenta, compra un
    paquete de nácar (proveedor falso) y un cosmético; en el juego, panel "Apariencia".
12. **Baúl de la cuenta (plaza, junto al tablero del mercado).** Crea un segundo personaje en
    la misma cuenta y entra con los dos (dos ventanas del navegador, la misma cuenta). Con el
    primero, click derecho en el cofre (2090,2102) y "Guardar" algo comerciable de la
    mochila; la ventana del otro, abierta en el mismo cofre, lo muestra al instante. Sácalo
    con el segundo ("Sacar" o arrastrándolo a "Lo que llevas"). Prueba también: un item de
    quest (no entra), alejarse (se cierra), los dos "Sacar" a la vez sobre el mismo item (uno
    lo saca, el otro ve "Eso ya no está como lo viste…"), y salir y entrar de nuevo (lo guardado
    sigue ahí).

### Mundo vivo (lote 17)
Al norte del templo, entre la costa y los corrales (tabla de arriba; reglas en
`livingworld/README.md`):
1. **Enredadera.** Párate al sur de la enredadera (2096,2071) y úsala (click derecho, o
   Ctrl+click): cada golpe tira astillas verdes; a la cuarta a mano limpia (antes con un
   arma) se corta, deja tallos cortados y entras al jardín. Rompe la caja, el barril y la
   vasija (a veces dejan monedas o una poción en el suelo) y corta la telaraña. Los restos
   se desvanecen a los 15–30 s; la enredadera vuelve a los 180 s, pero nunca a la vista:
   aléjate hasta que salga de la pantalla y vuelve.
2. **Rastrillo.** Camina contra la roca musgosa de 2101,2070 desde el oeste (tecla →): se
   desliza a la placa de 2102,2070. Después la de 2105,2071 desde el sur (tecla ↑) hacia la
   placa de 2105,2070. Con las dos placas presionadas el rastrillo (2105,2068) se abre; si
   sacas una roca, se cierra (no sobre ti). Las rocas vuelven solas a su lugar 3 min después
   del último empuje, cuando nadie las ve (ni a su lugar): mientras estés ahí el rastrillo
   sigue abierto, hasta 6 min después del último empuje (a las dos veces el tiempo vuelven
   aunque las mires, para que una roca no encierre a nadie; empújala otra vez y el plazo
   empieza de nuevo). Si quedas adentro con el rastrillo cerrado (saliste del juego ahí, o
   tras un reinicio), el
   teleport de 2105,2066 te deja afuera, en 2104,2071.
3. **Herramientas.** La roca agrietada solo se parte con un pico (usa el pico sobre ella);
   con la espada dice que así no se rompe. La barricada y el matorral ceden a golpes, al
   hacha o al fuego (un hechizo de área de fuego los quema).
4. **El volcán** tiene dos atajos en el muro del cráter, al noroeste: una roca agrietada
   (3699,5753, pico) y una barricada podrida (3714,5746).

### Día y noche
La hora del mundo es la misma para todos y sigue la hora real (un ciclo de 240 minutos:
180 de día y 60 de noche). Para verla sin esperar, con una cuenta de staff (abajo, "Hacerse
personal"):
- `/time` dice la hora del mundo: la fase, el minuto del ciclo, la luna y la velocidad.
- `/time dawn`, `morning`, `noon` (o `day`), `afternoon`, `dusk`, `night` (o `midnight`), o
  `/time <minuto>` (0 = empieza el amanecer, 180 = empieza la noche): otra hora del mismo
  día.
- `/time moon <fase>`: el próximo día con esa luna (0 nueva, 4 llena).
- `/time speed <n>`: el mundo corre n veces más rápido (`/time speed 60`: un ciclo en 4
  minutos); `/time speed 0` lo detiene (para mirar o sacar capturas) y `/time speed 1`
  vuelve a lo normal. Un reinicio del servidor también.

Los cambios del staff no se guardan: tras un reinicio el reloj vuelve a la hora real (lo
mismo si el game loop se atrasó respecto del reloj real: la hora deriva un poco hasta el
próximo reinicio). La luna que informa `/time` es la del cielo: en el amanecer, la de la
noche anterior (`/time moon 4` y luego `/time dawn` dice luna 3). Al revés también:
`/time moon 4` dado en el amanecer deja la luna 4 en ese cielo, y la noche que sigue
(`/time night`) ya tiene la 5; para una noche con luna 4, primero `/time night` y después
`/time moon 4`. El servidor del E2E arranca con `-world-time noon` (rechazado en
producción): hora detenida al mediodía (un reloj detenido se manda al entrar y tras cada
`/time`, no cada minuto); el test de día y noche la deja así al terminar, aunque falle.
Todos los jugadores reciben el cambio en el acto. Qué mirar: a la mañana las sombras de los
personajes **y de todo objeto con altura** (árboles, muros, faroles, barriles, carteles)
largas hacia el oeste, al mediodía cortas, a la tarde hacia el este; de noche la superficie
azul, las fogatas y faroles encendidos, luciérnagas en el pasto y una sombra tenue de la
luna (ninguna con luna nueva). Un personaje con sombra proyectada no lleva la elipse bajo
los pies; la elipse vuelve dentro de un edificio, bajo tierra y con luna nueva, pegada a
los pies. La sombra de la copa de un árbol se mece con la copa. Con "Animaciones
reducidas" las sombras siguen, sin vaivén. Un cuerpo a menos de media opacidad (tu
personaje invisible, que se ve al 40 %, o uno que se desvanece) no proyecta sombra a
propósito: le queda solo la de contacto. Bajo tierra no hay sombras del sol.

## 5. Hacerse personal (GM o admin)
Los roles los da solo el operador, con la base de datos (con `make play` corriendo o no):

```
make set-role EMAIL=tu@correo ROLE=admin NOTE="probar en local" ALLOW_UNVERIFIED=1
```

Primero muestra la cuenta (fecha de creación, personajes). `ALLOW_UNVERIFIED=1` hace falta
porque en local la cuenta no confirmó su email: sin eso se niega a darle un rol de staff
(lote 16, docs/09 "Roles de staff").

`ROLE=gm` alcanza para `/tp`; `/item` y `/premium` piden `admin`. Sal del juego y vuelve a
entrar: un rol nuevo vale desde el próximo login. `make audit-log` muestra lo que hizo el
personal. Comandos útiles (en el chat; lista completa en `02-game-design.md`, "Moderación"):

| Comando | Para qué |
|---|---|
| `/tp x y z` | Ir a una casilla. Ejemplos: templo `/tp 2095 2088 7`, corrales `/tp 2088 2082 7`, oficios `/tp 2075 2098 7`, portales `/tp 2118 2098 7`, sótano `/tp 2121 2091 8`, arena `/tp 2098 2115 7`, muelle `/tp 2095 2131 7` |
| `/tp Nombre` y `/tp Nombre x y z` | Ir junto a un jugador, o llevarlo a una casilla (así se trae a alguien de vuelta a la isla) |
| `/item id [cantidad]` | Crear items de `data/items` (admin): `/item gold_coin 10`, `/item rope`, `/item pruebas_key` |
| `/premium Nombre +100 nota` | Dar nácar de la tienda cosmética (admin) |
| `/announce texto` | Anuncio a todos |
| `/house id`, `/houseevict id` | Ver o liberar una casa (`/house pruebas_house`) |
| `/unskull Nombre` | Quitar la marca PvP |
| `/marketoffers Nombre`, `/reports`, `/kick Nombre` | Mercado, reportes, expulsar |

El personal es inmune en PvP, no puede atacar a jugadores y no usa el mercado: para eso,
cuentas sin rol.

## 6. PvP con dos ventanas
1. Crea dos cuentas. La sesión es por navegador: usa una ventana normal y otra de
   incógnito (o dos navegadores), cada una con su cuenta.
2. Sube los dos personajes al nivel 20 o más con la instructora (dos veces "Mucha") y, para
   que los golpes se parezcan a los de un personaje jugado, "Entréname" → "El combate".
   Ninguna de las dos cuentas puede tener rol de personal.
3. **Arena:** entren los dos y atáquense. Sin marcas ni castigo; el que pierde despierta en
   el templo sin perder nada.
4. **PvP abierto:** fuera de la arena y de la plaza. Desactiva el modo seguro (botón
   "Modo seguro" del cliente) y ataca: quien ataca sin motivo recibe la marca de agresor.
   `/unskull Nombre` (con una tercera cuenta GM) la quita.
5. **Lo que ve el otro** (lote 13): con las dos ventanas lado a lado, equipa y saca un arma,
   un escudo o un casco en una: la otra lo ve en la figura en el acto (también al romper
   una pieza en el yunque o al morir y soltarla). Cambia el aspecto en Apariencia →
   Personalizar y guárdalo: la otra lo ve al instante. Un ataque a distancia del otro
   dispara con su arco o su ballesta; uno con varita o vara, conjura.

## 7. Apagar todo
1. `Ctrl+C` en la terminal de `make play` (corta el servidor y Vite).
2. Si algo quedó vivo (en Windows a veces pasa con `go run`): `taskkill //IM gameserver.exe //F`
   en Git Bash, y cierra la ventana de la terminal si Vite sigue en el puerto 5173.
3. `make db-down` para Postgres (los datos quedan en el volumen de Docker) y cierra Docker
   Desktop si no lo usas.

## 8. Los tests del recorrido
`server/internal/session/sandbox_test.go` juega este recorrido sin levantar nada: el mundo
real compilado con la isla (`compile.Build` con `DevIslands`), el contenido de `data/` y
`-start-town pruebas`, como `make play`, con personajes que hablan, caminan (A* por el
mapa, como el cliente), compran, usan, fabrican y pelean por mensajes de cliente. Corre en
un segundo con `go test ./internal/session -run Sandbox` (y en `make test`).

| Test | Qué juega |
|---|---|
| `TestSandboxInstructor` | Despertar en el templo (sin tutorial), experiencia, oro, curación de vida y maná y la misión de las ratas de punta a punta: entregada, el diario la muestra esperando tres minutos, Irene solo dice que el corral se está llenando, y pasados los tres minutos se toma y se cobra otra vez |
| `TestSandboxProvisioner` | La tienda igual a `data/`, comprar (con cambio de la moneda de oro), equiparse, vender; que en ninguna tienda de `data/` se gane dinero comprando y revendiendo, tampoco pasando por una receta |
| `TestSandboxPens` | Cada corral con una vocación hasta que deja botín (ver arriba qué hace falta en el 4 y el 5) |
| `TestSandboxTraining` | El guardián de nivel 21 que muere en el corral 4 con las skills en 10 y sobrevive entrenado por la instructora ("El combate"); el entrenamiento nunca baja una skill |
| `TestSandboxTrainingByVocation` | Lo que entrena cada vocación (y que su nivel mágico alcance para todos sus hechizos); un druida de nivel 8 entrenado lanza "mend_other" (nivel mágico 2), que antes no podía |
| `TestSandboxTradesTraining` | "Los oficios" dejan todas las recetas de `data/recipes.yaml` al alcance |
| `TestSandboxDevOnlyOffTheSandbox` | Si la instructora no estuviera en una isla de desarrollo, el servidor no le dejaría entrenar ni llenar el maná (`dialog.dev_only`), y la opción no haría nada |
| `TestSandboxTrades` | Picar, talar y pescar con las herramientas de la tienda; fragua y fogón; ninguna receta del yunque al alcance de un personaje nuevo, y el mismo entrenado en los oficios hace un hacha de leñador en el yunque; vender lo hecho |
| `TestSandboxHouse` | Casa: nivel 12, alquiler, entrar, dejar un objeto, extraño afuera, invitada adentro que no saca nada |
| `TestSandboxVault` | Puerta de práctica sin llave, con llave, cerrar desde adentro y salir sin llave |
| `TestSandboxPortals` | Escaleras, escalera de mano, agujero, murciélagos, punto de soga sin y con cuerda, teletransporte, una galleta tirada a la escalera |
| `TestSandboxFerry` | Los tres viajes del barquero (y sin pasaje no zarpa); morir afuera devuelve a este templo |
| `TestSandboxMarket` | Una oferta de venta en el tablero, la compra de otro personaje y el retiro del buzón |
| `TestSandboxArena` | Dos personajes de nivel 20: fuera de la arena nadie ataca en modo seguro; adentro, el que pierde despierta en el templo sin perder nada y el ganador queda sin marca |
| `TestSandboxArcRune` | La runa de arco pide nivel mágico 1: una arcanista nueva no la puede usar, y recién entrenada (nivel mágico 30, sin subir de nivel) mata una rata con ella |
| `TestSandboxDialogs` | Toda ventana de los tres NPCs se alcanza y toda opción lleva a algo |
| `TestSandboxToolsHaveAUse` | Toda herramienta que vende el proveedor tiene en qué usarse en la isla |
| `TestSandboxEverythingReachable` | Toda casilla caminable se alcanza desde el templo, y todo NPC, veta, árbol, agua con peces, estación y tablero se puede usar desde ahí |

Las guardas de las acciones de desarrollo y del mundo de desarrollo tienen sus tests fuera
del recorrido: `TestDevOnlyActionsRefusedOffDevIslands` (`session`: el servidor no arranca
con la instructora en una isla sin la marca), `TestDevOnlyActionsNeedADevIsland`
(`dialog`), `TestDevOnlyActions` (`content`), `TestBinaryKeepsDevIslands` (`world`),
`TestCompilePruebas` (`world/compile`: solo `-dev` marca la isla),
`TestLoadWorldRefusesADevWorldInProduction` (`cmd/gameserver`) y "only lets NPCs placed on
dev_only islands use dev-only actions" (`packages/content-schema`).

## 9. Abrir el juego desde un teléfono
Tres caminos, del más simple al más completo. Para la lista de qué mirar, `docs/14`
("Móvil, QA", punto 7).

1. **Por USB (Android), sin tocar la red.** Con `make play` (o `make home-up`) corriendo en
   la PC, el teléfono con *Depuración USB* y conectado:
   ```
   adb reverse tcp:8080 tcp:8080
   adb reverse tcp:5173 tcp:5173
   ```
   (la segunda línea solo con `make play`, que sirve el cliente en el 5173) y en Chrome del
   teléfono abre `http://localhost:8080/play/` (con `make play`, la dirección que imprime).
   `localhost` es un contexto seguro: funcionan el service worker y "Instalar como app"
   aunque no haya HTTPS. Al terminar: `adb reverse --remove-all`.
2. **Por la misma Wi-Fi.** En `deploy/.env.home` pon `HOME_BIND=0.0.0.0` y
   `COOKIE_SECURE=false`, `make home-up`, permite el puerto en el firewall de Windows y
   abre `http://<IP de la PC>:8080/play/` (la IP sale de `ipconfig`). Se juega, pero sin
   HTTPS el navegador no instala la app ni registra el service worker (`docs/13`, "Mis
   amigos no entran por la LAN").
3. **Por el túnel (cualquier red, también iPhone).** `make home-up` y `make home-tunnel`:
   imprime un link `https://….trycloudflare.com`; ábrelo en el teléfono y agrega `/play/`.
   Es HTTPS: se puede instalar (Android: "Instalar como app"; iPhone: Compartir → "Agregar
   a inicio"). El link cambia en cada arranque.

Para medir en el teléfono lo mismo que la auditoría de la PC (áreas seguras, tamaños de
toque, cuadros por segundo): `docs/15` "Pasada en un teléfono real".

## Por qué la isla queda fuera del juego
Decisión: Thimblewick es una herramienta de desarrollo, no contenido.
- **Es `dev_only`** (`world/world.yaml`): `mapcompile` la deja afuera salvo con `-dev`.
  `make mapcompile` (y con él `make dev`, `make play`, `make run-server` y los bots) y el E2E
  la incluyen; la imagen de producción (`deploy/Dockerfile.gameserver`, también la de
  `make home-up`) no. Ahí no existe: ni un `/tp` del personal llega, `-start-town pruebas`
  no arranca y su casa no sale en la lista pública de casas.
- **Nada del juego normal lleva a ella**: ningún barco, portal ni diálogo de otra isla. Su
  barquero no usa rutas de `data/boat_routes.yaml` sino teleports de diálogo con pasaje: el
  servidor de producción revisa cada ruta contra su mapa, capitán incluido, y sin la isla no
  arrancaría. `make validate` lo exige para toda isla `dev_only` (`03-world-and-maps.md`,
  "Validación"), y lo comprueban `tools/mapcli/src/world.test.ts` ("the sandbox island") y
  `TestCompilePruebas` (`server/internal/world/compile`).
- Por eso la instructora puede regalar experiencia y dinero: fuera de un servidor local no
  hay forma de hablarle.
- **Su entrenamiento y el maná son acciones de desarrollo** (`train_skill`,
  `restore_mana`; `06-content-data.md`, "Diálogos"): `make validate` las rechaza en un NPC
  que no esté solo en islas `dev_only`, el servidor no arranca con uno así fuera de una isla
  marcada `dev` en `world.bin`, y al elegir la opción lo vuelve a mirar
  (`dialog.dev_only`).
- **Un `world.bin` con la isla no llega a producción**: `mapcompile -dev` marca la isla en
  `world.bin` (versión 6) y el servidor no arranca con ese mundo si `RPG_ENV` es de
  producción (vacía o `production`, lo que pone `docker-compose`), igual que con el
  proveedor de pagos falso. Por eso `make run-server`, `make dev`, `make play`, `make bots`
  y el E2E corren con `RPG_ENV=development` (`12-local-development.md`, "Mapa del
  servidor").
- Los personajes de `make play` y de `make dev` comparten la base `rpg`: uno que quedó en
  la isla y entra con `make dev` sigue ahí (su isla está en el mapa local).
- No toca `testisle`, que sigue siendo la isla de los tests y del E2E.
