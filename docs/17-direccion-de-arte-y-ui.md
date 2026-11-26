# 17 — Dirección de arte, animación, movimiento y UI

Este doc nace de la primera prueba del dueño (2026-11-17). Fija cómo se tiene que ver,
moverse y manejarse Neque's Realm. Cada regla tiene un id (`ART-n`, `ANI-n`, `MOV-n`,
`UI-n`, `SRC-n`) para citarla en tareas y PRs. Lo que todavía es código está en el plan
del final (§7): nada de este doc está implementado salvo lo que dice "hoy" y las tareas
que §7 marca como hechas (A2 y A3: tema, fuentes, dock y ventanas; "Hecho: A2 y A3"; A4 y
A5: menú del click derecho con la ficha, diálogo y tienda sin scroll, y los botones del
gremio; "Hecho: A4, A5 y los botones del gremio"; A6: movimiento fluido, click previsto y
caminar manteniendo el mouse, "Hecho: A6" en §4; y A8 con la parte de criaturas de A10 y
A12, el 2026-11-17; y el arte del mundo de A10, A11 y la luz de A13, rama
`feat/world-art`, el 2026-11-18; y el resto de A1, A10, A11 y A13, rama
`feat/world-art-2`, el 2026-11-18: "Hecho: el resto de A1, A10, A11 y A13"; y los restos
de ANI y MOV, rama `feat/lpc-actions`, el 2026-11-18: "Hecho: disparar, conjurar,
desvanecerse, pasos y girar"; y el motor de sprites, rama `feat/sprite-engine`, el
2026-11-18: "Motor de sprites", al final de §3).

## Lo que pidió el dueño
Textual, de la prueba del 2026-11-17:

> el movimiento tiene que ser más fluido; las gráficas no están mal pero necesitamos
> mejorarlas; aprende de todos los sprites de Tibia, ahí están mejor logrados, las paredes
> se ven mejor y todo está más pulido; los enemigos tienen que tener sprites de movimiento;
> genera una UI buena, bonita y oscura estilo Diablo 2 pero con las funcionalidades
> actuales; debiese verse más pantalla; todo debiese tener animaciones o el juego se ve
> aburrido; click derecho en los items debería mostrar una descripción; el menú para hablar
> es muy incómodo, no quiero hacer scroll para buscar las cosas; los gremios debiesen tener
> su menú aparte o botoncitos como en Tibia; fluidez de movimiento como en Diablo 2;
> considera otros juegos 2D de este estilo.

Decisiones del dueño del mismo día (ya están en `00-vision.md`, `CLAUDE.md` y
`assets/CREDITS.md`):
- Los assets de terceros pueden ser también **CC-BY-SA** (por ejemplo, Liberated Pixel
  Cup), y las fuentes, **OFL**.
- La vista llega **hasta 31x21 casillas**.
- Se puede usar arte y música **generados con su cuenta de Gemini**, registrados en
  `assets/CREDITS.md` con su prompt y sin nombrar otros juegos, artistas ni obras (SRC-5).
- **Pantalla completa y menús flotantes** (2026-11-18, textual): "me gusta la de diablo con
  esas gráficas góticas, y me gusta también la de tibia pero no quiero que se vea como que
  estas viendo el mapa a traves de una ventana o un cuadro, quiero que el juego se vea full
  screen, como Diablo 2 o como Ragnarok Online, en donde los menús 'flotan' y puedes
  moverlos donde te acomoden". Y dos respuestas suyas del mismo día: el HUD es una **barra
  gótica abajo** (el orbe de vida abajo a la izquierda, el de maná abajo a la derecha y en el
  medio la barra de experiencia, la hotbar F1–F12 y los botones de menú), la única pieza
  fija; y las ventanas son **libres con imán**: cada una se suelta donde sea y recuerda su
  lugar, y cerca de un borde de la pantalla, del techo de la barra o del borde de otra
  ventana se pega para alinearse. Hecho en A14 (§7).
- **La regla legal no cambia.** De Tibia copiamos mecánicas, y de Tibia y Diablo
  aprendemos estilo. Nunca copiamos sus sprites, nombres, mapas, textos ni fuentes. Nada de
  este doc se dibujó mirando un sprite concreto de esos juegos, y ninguna tarea que salga
  de aquí puede hacerlo.

## 0. Diagnóstico: lo que muestran los screenshots de hoy
Revisados con Read en `client/e2e/screenshots/actual/` (corrida del 2026-11-15).

| Problema | Dónde se ve | Causa | Se arregla en |
|---|---|---|---|
| Los muros parecen otro suelo | `65-volcan-temple`, `14-shop` | `walls/stone_wall` es `dngn/wall/brick_gray0` de Dungeon Crawl: una textura de ladrillo vista desde arriba que llena la casilla, sin cara frontal ni altura | ART-3 |
| El pasto "hierve" y aplana todo | `04-world`, `07-combat`, `32-bosque-plaza` | `ground/grass` es ruido saturado de alta frecuencia, el mismo tile repetido. El lobo de `07-combat` casi no se distingue del fondo | ART-4, ART-6 |
| Personajes chicos y de escalas mezcladas | `04-world`, `14-shop` | El atuendo `citizen` es una figura de unos 10x25 px en una casilla de 32. Los NPCs y monstruos de Dungeon Crawl tienen cada uno su escala | ART-2, SRC-4 |
| Nada se mueve solo | todos | Monstruos y NPCs de un solo frame que se deslizan. Agua, árboles y fuego quietos (`29-bosque-dock`) | ART-7, ANI |
| La UI se ve como una página web | todos | Encabezado de 68 px, columna fija de 240 px, `system-ui`, botones dorados planos. Mapa de 960x704 en una ventana de 1280x800 | UI |
| El gremio ocupa la columna aunque no tengas | `04-world`, `46-guild-panel` | El formulario "Fundar" vive siempre en la columna lateral | UI-7 |
| Diálogo y tienda tapan el mapa con listas largas | `13-dialog-window`, `14-shop` | Opciones en una lista vertical. La tienda tiene un campo de cantidad y un botón por fila | UI-6 |
| Paso, pausa, paso | (al jugar) | Ver §4: el cliente espera la confirmación del servidor antes del paso siguiente, y los demás arrancan su paso cuando llega el paquete | MOV |

## 1. Qué aprendimos de cada referencia (y qué no copiamos)
Las fuentes consultadas están al final. Donde no hubo documentación pública (Tibia no
publica cómo dibuja), lo que sigue es observación de estilo y discusión de la comunidad,
no datos internos.

### Tibia: lectura del mapa
- **Grilla de 32x32 con proyección oblicua.** Lo que es más grande que una casilla (64x64)
  se ancla en una esquina de su casilla y crece hacia arriba y a la izquierda, sobre las
  casillas vecinas. Nuestro renderer ya lo hace (`packages/renderer/src/map-view.ts`).
- **Las criaturas "se paran" en la casilla.** Los clientes abiertos de Tibia (OTClient)
  manejan para cada sprite un *displacement* (cuánto se corre el dibujo de la criatura) y
  una *elevation* (cuánto suben los items y criaturas apilados sobre una mesa o una caja,
  con un tope). Además, *animation phases* por sprite, y los pasos del ciclo de caminar
  van atados al paso.
- **Muros por piezas.** Hay piezas horizontales, verticales, esquinas y postes, y su altura
  se dibuja sobre la casilla de atrás. Las puertas son parte del muro. Ahí está casi todo
  el "se ve mejor" de las paredes: hay **altura y cara frontal**, y el muro tapa lo que
  tiene detrás.
- **Suelos como rompecabezas.** Muchas variantes por suelo, bordes de transición entre
  todos los pares, detalles sueltos (piedras, flores, pasto alto) y tiles animados (agua,
  fuego, banderas). Las cuevas son oscuras y la luz viene de antorchas.
- **Interfaz.** Una columna derecha de miniventanas apiladas (lista de batalla, skills,
  contenedores) que se minimizan, y una barra de botones que abre cada una. Se elige entre
  controles "clásicos" (click derecho = usar) y menú contextual.

### Diablo II: sensación y UI oscura
- El postmortem cuenta que renderizaron a los personajes en **16 direcciones** y a los
  monstruos en **8**, y que un monstruo tiene **hasta 14 modos de animación** (caminar,
  atacar, morir, etc.). La variedad de animación es lo que da vida al mundo.
- El objetivo de la interfaz era que fuera "lo más transparente posible": clicks simples
  para moverse, atacar, abrir puertas y tomar items. **Mantener el botón** hace que el
  personaje siga caminando hacia el cursor, y al soltar termina su paso.
- Marcos de piedra y metal oscuros, dos orbes (vida y maná) y un cinturón abajo. Los
  paneles (personaje e inventario) se abren sobre una mitad de la pantalla y se cierran al
  instante. Las fichas de item usan colores para el tipo de item.
- La remasterización sumó fuentes más grandes, escalado de UI, interruptores (sacudida de
  cámara, indicador de "falló") y sliders por canal de sonido. Accesibilidad =
  personalizar.

### Ultima Online: ventanas e items
- Las ventanas ("gumps") se ponen donde uno quiere. El equipo se ve sobre una figura del
  personaje (*paperdoll*).
- Casi todo tiene **menú contextual**, y los items muestran sus propiedades en un tooltip.

### Otros juegos 2D cenitales
- **Stardew Valley:** fichas de item al pasar el mouse (nombre, categoría, descripción,
  efectos). El entorno siempre se mueve un poco: el pasto se agita al pisarlo, los árboles
  tiemblan y el agua está animada. Las acciones tienen pequeños rebotes de respuesta.
  **Lección:** una ficha legible y un mundo que respira valen más que más detalle por
  sprite.
- **Realm of the Mad God:** personajes de muy pocos píxeles con contorno oscuro y ciclos
  de caminar y atacar muy cortos, y la acción se lee igual. **Lección:** con 2 frames bien
  puestos y buen contorno alcanza. Lo que mata la lectura es que algo no se mueva.
- **Old School RuneScape** (3D, pero sus convenciones de interfaz son 2D y muy probadas):
  el menú del click derecho lista todas las acciones, con la de por defecto arriba y
  "Examinar" al final. El panel lateral tiene una pestaña por sistema, con botones de
  ícono. **Lección:** el texto de la acción por defecto al pasar el mouse ("Hablar con
  Tilde", "Atacar a lobo") enseña los controles sin manual.
- **Liberated Pixel Cup (LPC):** es un estilo y a la vez una fuente de assets (§6). La guía
  derivada de su guía de estilo pide:
  - proyección ortográfica, cámara a unos 60°, grilla de 32x32;
  - luz desde arriba y apenas desde la izquierda;
  - contorno fuerte en personajes y más suave en objetos;
  - tramado casi nunca;
  - personajes en frames de 64x64.

  LPC Revised usa una paleta de unos 170 colores y personajes más grandes que el promedio.

## 2. Arte del mundo (ART)

### ART-1 Proyección (decisión)
**3/4 frontal, la de LPC y la de nuestro spritegen.** La altura sube recta en pantalla:
se ve la cara de arriba y la cara sur de cada objeto. **No** adoptamos el corrimiento en
diagonal de Tibia, por tres razones:
- los packs que podemos usar (LPC, Dungeon Crawl) están en 3/4 frontal;
- el ancla de abajo a la derecha que ya tenemos funciona igual;
- el autotile de muros (ART-3) queda más simple.

De Tibia tomamos lo otro: altura que tapa la casilla de atrás, piezas por orientación y
variedad.
- 1 píxel de sprite = 1 píxel de arte. Nada de mezclar densidades: un pack de 16x16 no se
  escala a 32 sin decisión del dueño (`assets/README.md`).

### ART-2 Tamaños y anclas
El atlas exige lados múltiplos de 32: un objeto de 32x48 va en un lienzo de 32x64 con la
parte de arriba transparente.

| Tipo | Lienzo | Ancla | Notas |
|---|---|---|---|
| Suelo, borde | 32x32 | la casilla | Mosaico sin costuras (test de spritegen) |
| Item chico (moneda, poción, hierba) | 32x32 | la casilla | Dibujo de ≤ 20x20 apoyado abajo y centrado: así se apila |
| Mueble u objeto (mesa, cofre, yunque) | 32x32 o 32x64 | abajo a la derecha (hoy) | Puede tener *elevation* (ART-8) |
| Muro (una pieza) | 32x64; 32x96 para murallas | abajo a la derecha | Cara de 32 px y tapa sobre la casilla de atrás (ART-3) |
| Árbol | 64x64, 64x96 o 96x96 | abajo, tronco centrado (ver abajo) | Copa animada por viento (ART-7) |
| Criatura chica (rata, murciélago) | 32x32 | abajo, centrada | Figura de 16–28 px |
| Animal mediano (lobo, jabalí, ciervo, sabueso, araña, sapo) | 64x64 | pies centrados en la casilla | A la escala de la persona de LPC (ver "Animales medianos") |
| Humanoide (jugador, NPC, bandido) | frames de 64x64 | pies centrados en la casilla | Figura de 36–40 px de los pies a la coronilla, la cabeza un sexto ("Humanoides del motor", §3); antes 40–48 px, como LPC |
| Criatura grande o jefe | 64x64 o 96x96 | pies centrados | Ocupa una casilla en el servidor, aunque se vea más grande |

- **Animales medianos** (decidido el 2026-11-18, con la segunda tanda de Gemini): todos
  los animales se miden contra la persona de LPC (~46 px, 1,8 m: ~25 px por metro) y no
  contra la casilla. Con eso: lobo y sabueso ~40 px de largo, jabalí ~36 de largo y 23 de
  alto, ciervo ~42 de alto con las astas (una persona), reptante hueco y salamandra ~45 de
  largo, gólem ~50 de alto y ancho como dos, dragoncillo ~58 de largo, y el jefe del
  Volcán (`slagbound_warden`) ~77 de alto en 96x96. Rata, cangrejo y escarabajo quedan en
  32x32 (son chicos de verdad). El jabalí y el ciervo de spritegen eran de 32x32 con el
  ancla de siempre y la sombra pintada: al lado del lobo de Gemini el ciervo parecía una
  cría y los dos pisaban 4 px más abajo que el resto. Pasaron a ser su mismo diseño
  dibujado 1,2 y 1,4 veces más grande en 64x64, y desde el 2026-11-18 son modelos del motor
  de sprites ("Motor de sprites", al final de §3): ~38 px de largo el jabalí (22 de ancho
  visto de frente) y ~46 de alto el ciervo con las astas, con `anchor: bc` y la sombra de
  contacto (`shadow: ellipse` en
  `assets/sprites.yaml`), como todo animal animado. La gaviota sigue de 32x32 con su
  sombra pintada mientras el dueño no decida su arte.

- **Ancla por sprite** (hecho para criaturas, 2026-11-17): `anchor: br` (abajo a la
  derecha, el de siempre) o `anchor: bc` (centrado; los pies `FEET_LINE` = 4 px por encima
  del borde de abajo de la casilla, donde va la sombra de contacto). `foot` (filas vacías
  bajo los pies) y `top` (alto del dibujo) no se escriben: spritepack los mide en los
  frames de caminar y los pone en `atlas.json` `anims`. Toda animación con capas es `bc`.
  En el mapa (hecho, 2026-11-18): un sprite con `anchor: bc` en la sección `tiles` de
  `assets/sprites.yaml` se centra en su casilla (los árboles); el resto de los items y
  muebles sigue abajo a la derecha.
- **Click sobre sprites altos:** un click en la cabeza de un humanoide (que cae en la
  casilla de arriba) tiene que elegir a la criatura. Primero se prueban las cajas de las
  criaturas dibujadas (de la última a la primera) y después la casilla (hecho, 2026-11-18:
  ver "Hecho: el resto de A1, A10, A11 y A13").
- **Nombres y barras** van sobre la cabeza real (la parte opaca más alta del frame), no
  sobre la casilla (hecho: suben `lift` px, `client/CLAUDE.md`).

### ART-3 Muros con altura y autotile
- **Un muro ocupa su casilla** (el formato de mapa no cambia). Su sprite de 32x64 se
  dibuja así:
  - los 32 px de abajo son la **cara sur**: ladrillo, piedra o troncos, con la luz de ART-5;
  - los 32 px de arriba son la **tapa**: la cara de arriba del muro, más clara, con un
    borde iluminado arriba y a la izquierda y uno oscuro donde termina.
- El orden de dibujo de hoy (fila por fila, de arriba hacia abajo) resuelve la oclusión:
  - en un muro norte-sur, la tapa de cada pieza tapa la cara de la de atrás, así que se ve
    una franja de tapas con una sola cara abajo, como en cualquier 3/4;
  - una criatura detrás del muro queda tapada por él.
- **Autotile en el render, no en el mapa.** El item sigue siendo uno por material
  (`stone_wall`, `wooden_wall`, `rock_wall`) con un campo nuevo `autotile: wall` en
  `data/items` (contenido como datos). El renderer mira los 4 vecinos del mismo material y
  arma el muro con dos partes:
  - tapa: `walls/<material>/cap_<máscara>`, 16 piezas (máscara N, E, S, O);
  - cara: `walls/<material>/face_<0..3>` (sola, extremo izquierdo, medio, extremo derecho),
    solo si al sur no hay muro.

  Así se pinta un muro con un solo item y el editor ve lo mismo (usa el mismo renderer).
- **Puertas:** pieza de 32x64 con marco y dintel, que continúa la tapa. Una puerta de casa
  (`houses.yaml` `doors`) que hoy es solo suelo recibe un marco decorativo que no bloquea.
- **Muros altos** (murallas, acantilados): cara de 64 px (sprite de 32x96).
- **Detrás de un muro** (cambiado por el dueño el 2026-11-23): si un muro tapa al jugador
  propio, **el muro cede**. Solo las piezas de muro que están al sur de él y cubren su
  dibujo se vuelven translúcidas (35 %), con un fundido corto, y vuelven al alejarse. El
  jugador nunca palidece. Antes se dibujaba encima una silueta clara al 45 %, y el dueño la
  vio "pálida y rara". A los demás no se les hace nada: esconderse detrás de un muro es
  parte del juego. Solo cede el muro que tapa al jugador, no todos los muros de la vista
  como en Diablo 2, así los interiores no quedan a la vista.
- Techos y pisos de arriba (en Tibia se ocultan al entrar) **quedan fuera** de este plan.
  Hoy solo se dibuja el piso del jugador.

**Hecho (A11, 2026-11-18), con estas diferencias con lo de arriba:**
- **Una pieza entera por máscara, no tapa y cara por separado.** Cada material tiene 16
  sprites de 32x64, `walls/<material>/wall_<máscara>` (N=1, E=2, S=4, O=8), con la tapa y la
  cara ya juntas: menos sprites por casilla, y las esquinas y uniones se dibujan a mano en
  la receta. El sprite del material (`walls/stone_wall`) es la pieza este-oeste, la que ven
  el inventario y la paleta del editor.
- **Sin campo `autotile` en `data/items`.** Que un sprite es un muro lo dicen los nombres de
  sus piezas: spritepack las encuentra y escribe `wall: true` en `atlas.json` `tiles`. Una
  puerta en un muro (`doors/forge_gate`, `doors/pruebas_gate` y sus abiertas) lleva
  `joins_walls: true` en la sección `tiles` de `sprites.yaml`: no tiene piezas, pero sus
  vecinos la cuentan como muro y la tapa sigue de corrido. Las dos puertas son arcos
  propios metidos en su muro, con la misma altura.
- **Dos formas** (`tools/spritegen/src/recipes/walls.ts`):
  - **muros construidos** (piedra, troncos): delgados, de 10 px. Un muro este-oeste se para
    en el borde sur de su casilla: su cara la llena y su tapa ocupa solo las últimas 10
    filas de la casilla de atrás, así que lo que está ahí se sigue viendo casi entero. Un
    tramo norte-sur es una franja de tapas por el medio, con suelo a los lados;
  - **roca** (paredes de cueva, vetas de hierro y de brasa): un bloque de todo el ancho y
    20 filas de fondo, con tapa rugosa y cara de acantilado solo donde no sigue roca al sur.
- **Orden de dibujo:** el de siempre (fila por fila; `MapView` ordena items y criaturas por
  `itemZIndex` y `entityZIndex` a través de los bordes de chunk), así que la tapa de un muro
  tapa a la criatura de la casilla de atrás y la criatura de adelante tapa la cara. Las
  piezas se eligen mirando los vecinos también en el chunk de al lado, y un chunk se
  rearma si cambia un vecino del que dependen sus bordes.
- **El muro cede** (desde el 2026-11-23): `MapView` guarda las piezas de muro por casilla
  (`wallSprites`, y también los items que se unen a los muros). En cada frame,
  `revealBehind(rect, fila, ahora)` funde a `REVEAL_ALPHA` (0,35) las de las
  `REVEAL_ROWS` filas al sur del jugador que se cruzan con su dibujo. El dibujo es
  `figureRect` de `game-canvas.ts`: la caja del sprite del cuerpo. Las demás piezas vuelven
  a 1, con un fundido exponencial de `REVEAL_FADE_MS` (90 ms). Los demás jugadores quedan
  tapados.
- **Muros altos, ventanas y marcos (hecho, 2026-11-18):** la muralla `rampart_wall` (16
  piezas de 32x96, cara de 64 px), los muros con ventana `stone_wall_window` y
  `wooden_wall_window` (sus 16 piezas con la textura del muro liso; la ventana solo en las
  piezas con cara de lado a lado) y el marco de las puertas de casa, que no cambia mapas:
  ver "Hecho: el resto de A1, A10, A11 y A13".

### ART-4 Suelos: variantes, textura y transiciones
- **Al menos 4 variantes por suelo** (la principal en ~70 % de las casillas), elegidas en
  el render con un hash de (x, y, z): `ground/grass/0..3`. El mapa no cambia y el resultado
  es determinista.
- **Textura de baja frecuencia:** manchas de 6–12 px y detalles sueltos de 1–2 px. Máximo
  5 tonos por suelo, y dentro de un mismo suelo **ΔL\* ≤ 15** (CIELAB) entre el tono más
  claro y el más oscuro. El pasto de hoy salta mucho más.
- **Detalles sueltos:**
  - los decorativos (matas, piedritas, flores) los esparce el renderer con un hash de la
    posición (`groundDecal`, abajo): no se pueden tocar y no pesan en el mapa;
  - lo que tiene sentido de juego (un arbusto que bloquea) sigue siendo un item del mapa.
- **Bordes** (`gen-borders`): entre todos los pares de suelos naturales que se tocan, con
  orilla irregular (nunca recta) que no se repite de casilla en casilla, y en el agua con
  espuma animada. **Hecho en el lote 13** (abajo).

**Hecho (A10, 2026-11-18):** pasto, tierra, arena y piedra de piso tienen 4 looks y la arena
mojada 2 (`ground/<suelo>/var_<n>`, recetas en `tools/spritegen/src/recipes/ground.ts`). El
renderer elige con `tileHash(x, y, z)` y deja el principal en el 70 % (`weight` en
`tiles`). Los detalles sueltos (flores, matas, piedritas, una raíz, una concha, musgo) van
en esos looks, lejos de los bordes, en vez de esparcirlos el cliente. Cada borde tenía una
orilla de tres ondas que se repetían por casilla (nunca recta y sin dientes; en el lote 13
se veía regular: ver abajo) y las orillas del agua, espuma que rompe en 4 frames. Un test
de spritegen exige la banda de valor de ART-6 a cada suelo (la lava no: brilla).

**Hecho (lote 13, 2026-11-19, `feat/terrain-borders`):** el dueño, jugando la Isla de
Pruebas: "faltan los sprites de transicion, todo tiene cortes demasiado cuadrados cuando la
transicion entre pasto y tierra nunca es recta". Había reglas para 7 pares; tierra con
pasto (1080 lados de casilla), pasto con piedra (399), tierra con arena, pasto con arena
mojada, ceniza con basalto y otros diez pares se tocaban en línea recta.
- **Una escalera de suelos** (`data/borders.yaml`, docs/06 "Bordes") en vez de reglas de a
  pares: cada suelo natural tiene un solo juego de piezas (su borde) que va sobre todos los
  suelos más bajos que toca. De abajo arriba: lava, bajío, agua, arena mojada, arena, lava
  enfriada, escoria, tierra, basalto, piedra, pasto, ceniza. Los pisos de madera y los
  muelles siguen rectos (hechos a mano). El bajío usa la misma agua que el agua de al lado
  (mismo ruido, más los peces), así que no necesita borde. Un suelo nuevo es una línea.
- **Orillas que nunca se repiten:** cada pieza tiene 4 looks y el renderer elige uno por
  casilla con `tileHash` (`lookOf` de `packages/renderer` tile-art: parejo entre los cuatro,
  no 70/30 como los suelos; el mismo para todas las piezas de la casilla). Todos los looks
  cruzan los lados de la casilla en el mismo punto (10 px de la esquina del lado del suelo
  alto) y adentro se doblan con su propio perfil: un oleaje suave, dos o tres bultos de 1 a
  6 px y algún píxel suelto, sin escalones de más de 2 px; las esquinas de adentro son un
  arco grande, así una costa en escalera se lee como una diagonal ondulada. Lo verifica el
  test de `gen-borders` (el contrato de los lados para cada pieza y look, y que dos lados
  opuestos nunca cierren un camino de una casilla).
- **Cada suelo con su orilla** (`edge`): matas de pasto que se paran sobre la tierra
  (`tufts`), piedritas grises en la arena (`pebbles`), terrones en la tierra y la escoria
  (`clods`), la junta oscura de la piedra y el basalto con alguna esquirla (`joint`), el
  borde mojado de la arena mojada (`wet`), el labio iluminado de la costra de lava
  (`crust`) y granos sueltos de ceniza (`drift`). Valor y tono: los del suelo mismo (el test
  exige la banda de ART-6, L\* 20-50, a cada pieza).
- **El agua:** la espuma (`border_surf_*`) va debajo de los bordes, una por borde y con su
  forma: el borde mojado de la tierra (dos tonos de arena mojada), la línea clara de
  espuma y la cortada que rompe en 4 frames, cada look con sus propios frames
  (`<pieza>/var_<n>/frame_<m>`). Así, donde dos bordes se pisan, la espuma de uno nunca se ve
  sobre la tierra del otro, y la que queda sigue la orilla de todos juntos (antes una
  esquina de adentro de espuma bajo dos bordes distintos dejaba agua sin espuma entre los
  bordes y el arco; medido sobre las 6561 vecindades de agua, arena y pasto en sus 4 looks:
  ningún píxel de orilla sin espuma ni espuma suelta en el agua).
- **Capas:** las piezas son `flat` (spritepack las marca en `atlas.json`) y se dibujan con
  los suelos, debajo de las sombras proyectadas, los items y las criaturas: el hocico de un
  lobo o el arma de un jugador que entra en la casilla de al lado no quedan bajo el borde de
  esa casilla, y la sombra de un árbol oscurece el borde como al suelo.
- **Mapas:** `mapcli autoborder` de las cinco islas en sus dos pisos (también las cuevas, con
  tierra y piedra): las piezas pasaron de 6297 a 12273 y el diff es solo de piezas de borde.
- Queda: una casilla sola que entra en otro suelo (la punta de un camino, una ensenada de
  una casilla) termina en punta (dos esquinas de adentro); se lee como un sendero que se
  afina. Una pieza propia para ese caso serían 4 piezas más por suelo.

**Hecho (2026-11-24, `feat/ground-variety`):** el dueño: "los sprites de piso se repiten
demasiado, sobre todo la arena; crea muchas más variaciones para que las áreas grandes se
vean naturales". La arena tenía manchas de 16 px y motas que caían en el mismo lugar de
cada casilla: un campo de arena era una grilla. Tres capas, todas funciones puras de la
posición en `packages/renderer/src/tile-art.ts` (el cliente, el editor y `mapcli render`
dibujan lo mismo; nada cambia en el mapa ni en el servidor):
- **Muchos looks por suelo** (`recipes/variety.ts` de spritegen): arena y pasto 11, tierra y
  piedra de piso 6, arena mojada y ceniza 5, escoria 4. Cada look conserva el anillo de 1 px
  del look principal y redibuja su **corazón**: otra semilla de la misma textura, o una
  versión con más ondas de viento, más grano, más húmeda o más clara (arena), más tupida,
  más seca o con trébol (pasto). En la arena, el pasto y la tierra la textura es un campo
  de niveles y el corazón se funde con el anillo en el nivel, sin tramado (`levelHeart`); el
  look principal sale de la semilla cuyo anillo queda más cerca del nivel medio
  (`calmSeed`), así el anillo que todos comparten no dibuja la grilla. La ceniza y la
  escoria (grano fino) funden el corazón con un tramado ordenado. Sus manchas grandes son
  más suaves que antes: la sombra amplia la pone el tono (abajo). El peso del principal
  (`weight` en `tiles`) baja a 0,2-0,35: ningún tile domina.
- **Elección por zonas** (`groundLook`): un ruido lento (`macroNoise`, celdas de 14 y 6
  casillas) hace que cada zona tire a una tanda de looks vecinos en la lista (los looks
  parecidos van juntos: una playa con ondas, otra con grano) y a más o menos looks
  alternativos. Dos casillas de lado nunca muestran el mismo look alternativo (los looks
  pares van en un color del damero y los impares en el otro) y una casilla se corre del
  look de sus vecinas diagonales de arriba (en bandas de 8 filas: menos del 5 % repite).
- **Tono** (`groundTone`): cada suelo y cada pieza de borde se tiñe con otro ruido lento,
  hasta un 10 % más oscuro y un poco más cálido o más frío. Las zonas grandes cambian de
  tono sin escalones entre casillas (a lo sumo 6 niveles de 255), y como el tono es de la
  posición, el borde de un suelo coincide con el suelo del que sale.
- **Detalles sueltos** (`groundDecal`, `<suelo>/decal_<n>`): arena (conchas, piedritas, una
  rama seca, huellas de gaviota, alga seca, ondas de viento) y pasto (flores amarillas,
  blancas y violetas, trébol, dos piedras, hojas caídas). Uno cada ~20 casillas, más en
  unas zonas que en otras, nunca dos que se toquen y solo donde las cuatro vecinas son del
  mismo suelo (ningún borde los tapa). Son arte del suelo, no items: no se pueden tocar ni
  bloquean, se dibujan con los suelos debajo de bordes, sombras e items, son chicos (5-80
  px, en el centro de la casilla) y del valor del suelo.
- Tests: `ground-variety.test.ts` del renderer (determinismo, vecinos distintos, diagonales,
  continuidad del ruido, tono, detalles), `map-view.test.ts` y `render.test.ts` de mapcli
  (tono y detalles como el juego), spritegen (anillo igual al principal, detalles chicos y
  centrados, banda de ART-6) y spritepack (`decals` en `atlas.json`).
- Queda: el agua y la lava (animadas: un look necesita sus 4 frames), la lava enfriada y el
  basalto (celdas: otro corazón corta una losa) y los pisos de madera siguen con un solo
  look. No hay nieve ni piso de cueva propios todavía: cuando entren, con `levelLooks`.

### ART-5 Contorno, sombra y luz
- **Luz principal desde arriba a la izquierda** (como hoy). Por material, 3–4 tonos más un
  brillo. Corrimiento de matiz ≤ 15°: las sombras van hacia el azul o el violeta y las luces
  hacia el amarillo. Nada de "más oscuro = más negro".
- **Contorno selectivo:**
  - criaturas y personajes: 1 px oscuro del color local, casi negro abajo y a la derecha
    (lado de la sombra) y más claro o cortado en el borde iluminado. Es lo que los separa
    del fondo;
  - objetos: contorno más suave;
  - suelos: sin contorno;
  - el negro puro (`#000`) solo en la sombra.
- **Sombras:**
  - las de Dungeon Crawl vienen pintadas (abajo a la derecha) y se quedan (`assets/README.md`,
    "Sombra de las criaturas");
  - los sprites nuevos con animación no la pintan: el renderer dibuja una **sombra de
    contacto** (elipse de 20x6 px, negro al 35 %) bajo los pies. Así no tiembla con los
    frames ni se duplica. Un campo `shadow: baked | ellipse | none` por sprite decide
    (A10);
  - árboles y edificios: una **capa de sombras** del renderer, después del suelo y antes
    de los items, con blend multiply, a partir de un sprite de sombra propio
    (`<sprite>.shadow`). La sombra cae sobre cualquier suelo sin pintarla en el árbol.
    **Hecho (2026-11-18)** como `<sprite>/shadow`, sin multiply: la capa entera va al 32 %
    (`CAST_SHADOW_ALPHA`) y cada sombra va teñida hacia el azul violeta
    (`CAST_SHADOW_TINT`), así dos sombras que se pisan no se oscurecen el doble. La tienen
    los árboles, el arbusto, la roca, la fragua, la fuente y el brasero.
    **Desde el 2026-11-25 el juego no las dibuja:** cada objeto con altura proyecta su
    propia sombra según el sol (abajo, "Sombras de los objetos"). El arte `<sprite>/shadow`
    queda para el editor de mapas y `mapcli render`, que no tienen hora;
  - la **sombra de contacto** de una criatura solo se dibuja donde no hay sombra
    proyectada (bajo tierra, bajo techo, noche sin luna): nunca las dos juntas.

### ART-6 Paleta y valores
- **Paleta maestra:** si se integra LPC, la de LPC Revised (~170 colores) es la referencia.
  Las rampas de `tools/spritegen/src/palette.ts` se acercan a ella para que el arte propio y
  el de LPC convivan.
- **Bandas de valor** (L\* de CIELAB; si una pantalla pasada a grises no las respeta, falla
  la revisión visual):

  | Capa | L\* | Saturación (C\*) |
  |---|---|---|
  | Suelos | 20–50 | baja a media (≤ 35) |
  | Muros y objetos | 25–65 (la tapa más clara que la cara) | media |
  | Criaturas y personajes | 10–85: el mayor contraste de la pantalla | media, alta en acentos |
  | Efectos, números y marcas | 60–100 | alta |

- **Una paleta por isla:** el tono dominante y el acento.
  - Puerto: arena y piedra cálidas, mar azul verdoso.
  - Bosque: verdes profundos, musgo y ocre.
  - Volcán: grises de ceniza y naranja de brasa.
- **Tramado:** nunca para degradados. Como textura intencional, como mucho el 10 % de los
  píxeles. En damero, solo en transiciones de áreas grandes (profundidad del agua, sombra
  en piedra).
- **Alfa 0 o 255** en los sprites (regla de hoy). La transparencia parcial es del renderer:
  sombras, luz y desvanecidos.

### ART-7 Tiles e items animados
- **Formato:** frames como carpetas, igual que los efectos (`ground/water/0..n`,
  `decor/torch/0..n`), y en `sprites.yaml` o en la receta
  `animation: { frames, ms, sync: world | tile | random }`:
  - `world`: todos en fase (agua, lava);
  - `tile`: con desfase por hash de la casilla (antorchas, banderas), para que no parpadeen
    juntas;
  - `random`: destellos sueltos.
- **Tiempos:**

  | Elemento | Frames | ms por frame | Sincronía |
  |---|---|---|---|
  | Agua de mar o río | 4–8 | 200–250 | world, más espuma de orilla |
  | Lava | 4–6 | 250–300 | world |
  | Antorcha, fogata, fragua | 3–4 | 100–140 | tile |
  | Bandera, ropa colgada | 3–4 | 150–180 | tile |
  | Fuente, cascada | 4 | 120–160 | world |
  | Copa de árbol, arbusto, pasto alto, juncos (viento) | ninguno | — | el viento del mundo vivo los mece (abajo, "Mundo vivo: el viento"); ya no llevan frames |
  | Teletransporte | 6–8 | 100 | world |
  | Veta de mineral | 1 destello cada 3–5 s | 80 | random |

- **Ambiente solo del cliente** (sin servidor, pool de ≤ 100 partículas en pantalla):
  - motas de polvo en cuevas, brasas en el Volcán, hojas en el Bosque, niebla y gaviotas
    sobre el mar;
  - polvo al pisar tierra o arena (3 frames, 200 ms) y ondas al pisar agua baja (hecho:
    "Hecho: disparar, conjurar, desvanecerse, pasos y girar"; no hay agua baja caminable,
    así que las ondas van en la arena mojada);
  - el pasto alto se agita al pasar.
- **Luz:**
  - los pisos subterráneos (z ≥ 8) van oscuros, con un radio de luz alrededor del jugador
    y de cada antorcha (capa de oscuridad en multiply y luces aditivas);
  - día y noche: después llegó el ciclo (abajo, "Día y noche y sombras proyectadas").

**Hecho (A10 y la luz de A13, 2026-11-18):**
- **Formato:** frames `<sprite>/frame_<n>` (el sprite es el frame 0) y, en la sección
  `tiles` de `assets/sprites.yaml`, `ms` y `sync` (por defecto 250 ms y `world`).
  spritepack los pasa a `atlas.json` `tiles` y `MapView` los avanza en
  `render(cam, view, now)` desde una lista plana: no asigna nada por frame y solo toca un
  sprite cuando cambia su frame. El editor anima igual; `mapcli render` muestra el frame 0.
- **Animados hoy:** agua y bajío (240 ms, `world`), lava (280 ms, `world`), espuma de
  orilla (250 ms, `world`), copas de roble, olmo, abedul y pino y el arbusto (700–900 ms,
  `tile`), fragua y fogón (110–120 ms, `tile`), y cuatro props nuevos para los pueblos:
  antorcha y estandarte de pared (cuelgan en la cara de un muro este-oeste: van en su
  casilla, después del muro), brasero y fuente. Desde el lote 12 están en los pueblos y
  las minas (ver "Kit de props de pueblo", más abajo), junto con el farol, el puesto de
  mercado y el mástil con bandera del kit, también animados.
- **Luz en cuevas:** `client/src/render/light-layer.ts`. Un mapa de luz a un cuarto de la
  pantalla, borrado a un gris frío (`AMBIENT`), con un brillo suave por luz, encima del
  mapa con blend multiply y debajo de efectos y nombres. Da luz el jugador (4,5 casillas) y
  cada item con `light` en `tiles` (radio en casillas: fragua y brasero 3,5, fogón y
  antorcha 3). Los brillos salen de un pool: un frame no asigna. En la superficie no dibuja
  nada.
- **Partículas de ambiente (hecho, 2026-11-18):** brasas, polen, rocío y polvo de cueva
  ("Hecho: el resto de A1, A10, A11 y A13").
- **Pendiente:** polvo y ondas al pisar, pasto que se agita, niebla y gaviotas sobre el
  mar y vetas con destello (`sync: random` ya existe, falta el arte). Los props nuevos ya
  están en los pueblos (lote 12).

### ART-8 Elevación
Una propiedad `elevation: <px>` en `data/items` (mesas, cajones, barriles: 8 px) sube lo
que se apila encima, hasta 24 px. Es solo de dibujo. La criatura que pisa la casilla
también sube.

**Hecho (2026-11-18)** tal cual: `MapView` sube cada item por la suma de lo que tiene
debajo (`stackElevation`, tope `MAX_ELEVATION` = 24; las sombras proyectadas no suben) y
`elevationAt` dice cuánto sube la criatura de esa casilla; el cliente la sube también a
mitad de paso, entre la altura de las dos casillas. El editor y `mapcli render` leen el
mismo campo. Lo tienen el cajón de carga, el barril y la mesa (8 px; los dos últimos son
del kit de props del lote 12): el libro de la herrera del archivo de Cinderstead está sobre una
mesa y se dibuja 8 px más arriba.

### Mundo vivo: el viento (hecho, 2026-11-25, rama `feat/wind-flora`, lote 20)
Pedido del dueño (2026-11-24): que también se mueva lo grande del mapa (árboles, arbustos,
plantas en general), poco pero **orgánico**, y que toda planta futura (selva y demás) lo
herede sola. El contrato está en `livingworld/README.md` "Viento"; aquí, la dirección de
arte.

- **La base plantada, la copa se mueve.** Un skew o un giro del sprite entero se ve falso
  (se mueve el tronco). El sprite se corta en tiras horizontales que se corren de lado por
  el cuadrado de su altura sobre el *pivot* (donde termina el tronco): el tronco no se
  mueve nunca.
- **Quietas, y cada tanto una ráfaga** (el dueño, 2026-11-26, después de jugar los lotes
  19 y 20: "el movimiento que le agregaste a las plantas es demasiado, pareciera que
  tienen vida o que se están como quemando; tiene que ser un movimiento generado por un
  random y cada cierto rato, como si pasara una ráfaga de viento"). Regla de arte: **una
  planta que se mueve siempre se lee viva o en llamas; el viento es un suceso, no un
  estado.** El vaivén constante y el aleteo de la copa se sacaron. Una planta está quieta
  y, cada 45 s en promedio (al azar: entre 24 y 67 s en un mismo lugar), el frente de una
  ráfaga cruza el mapa: al llegarle, la planta se inclina, sostiene un segundo, se
  balancea dos veces cada vez menos y queda quieta otra vez. Fuerza, momento y dirección
  de cada ráfaga son al azar, e iguales para todos los jugadores (reloj del servidor).
- **Poco:** 1 a 2 px en la punta de un árbol con una ráfaga mediana, hasta 3 con una
  fuerte. Un arbusto, la mitad; hierba y juncos se doblan desde el suelo; un cactus o un
  árbol seco casi no se mueven. Todos los números (cada cuánto, qué tan fuerte, cuántos
  balanceos, px por tipo) están en `data/livingworld/wind.yaml`.
- **Píxeles enteros de pantalla.** Cada tira se corre un número entero de px de pantalla al
  zoom actual: el pixel art no se desenfoca ni tiembla. Es el recurso clásico del pixel art
  hecho a mano (correr filas), no un estirado.
- **Ráfagas que cruzan el mapa.** El frente viaja (8 casillas por segundo): los árboles de
  un bosque se inclinan uno tras otro, cada uno con su tamaño y su ritmo. Nunca todos a la
  vez.
- **Según el lugar:** más en la costa y el desierto, menos dentro de un bosque y sobre la
  piedra de un pueblo, nada adentro (pisos de madera) ni en cuevas, un poco menos de noche.
- **La sombra de la copa se dobla con la copa** en la ráfaga (quieta en la calma) y la del
  tronco queda quieta (2026-11-25:
  la sombra de un árbol es una segunda malla sobre las mismas tiras; "Sombras de los
  objetos", abajo). Con "Animaciones reducidas" la sombra sigue, quieta.
- **Estandartes y bandera** siguen con su bucle de frames de ART-7 (una onda que recorre
  la tela): ya se mueven bien y no son plantas.

**Reglas para dibujar una planta** (propia, de un pack o de Gemini), para que se deforme
bien; las revisa `make spritegen` (`tools/spritegen/src/wind.ts`):
1. **Tronco y copa bien separados:** el tronco visible mide menos del 60 % del ancho de
   la copa, y el pivot va justo donde termina. Una palmera: tronco largo, pivot bajo.
2. **Ningún píxel suelto:** hojas, pétalos, frutos y semillas unidos a la planta (aunque
   sea por un tallo de 1 px). Lo suelto quedaría flotando al lado mientras se mece.
3. **Margen a los lados:** 2 o 3 px transparentes a cada lado de la copa (1 como mínimo).
4. **La copa lee bien corrida 2 px:** nada de detalles que dependan de una columna exacta
   contra el tronco (una rama que entra a la copa se corta en escalón: que entre poco).
5. Toda planta declara su **tipo** (`tree`, `palm`, `bush`, `tall_grass`, `reed`,
   `flower`, `vine`, `cactus`, `dead_tree`) y, si tiene tronco, su **pivot**. Después,
   `make sway-preview` y mirar `build/spritegen/sway.png` con Read: debe leerse sutil y
   orgánico, nunca de goma. `make validate` no deja pasar una planta sin viento.

Revisado el 2026-11-25 con `make sway-preview` (cada planta en 8 momentos) y `make
sway-preview SCENE=forest` y `SCENE=town` (cuatro momentos de un bosque y de una plaza con
árboles, a zoom 2): los troncos quietos, las copas a 1 o 2 px de su lugar, cada árbol en
su fase, ninguna silueta rota. Falta mirarlo en movimiento en el juego (E2E del lote).
Revisado otra vez el 2026-11-26 con las ráfagas: `make sway-preview` muestra ahora cada
planta quieta y en 10 momentos de **una** ráfaga plena (se inclina, se balancea, termina
quieta) y `SCENE=forest|town` cuatro momentos alrededor de un frente (1,5 s antes: todo
quieto; después, el frente cruzando).

### Mundo vivo (hecho, 2026-11-23, rama `feat/living-ground`, lote 17)
Pedido del dueño: "el entorno reacciona a los jugadores que pasan, para que el mundo se
sienta vivo". La parte visual es del cliente y vive en `livingworld/client`
(`livingworld/README.md` tiene el contrato; aquí, la dirección de arte):
- **Huellas** sobre arena, arena mojada, nieve, barro y ceniza: una marca por cada pie que
  se apoya, en el lugar de ese pie y en el frame en que la animación lo apoya (el dueño,
  2026-11-24: "tienen que coincidir con los pasos que da el personaje; si no, se ve muy
  falso"; `livingworld/README.md` "Huellas que coinciden con los pasos"). Pies
  alternados a cada lado de la línea del camino, giradas a la dirección real (las 8) y
  separadas por la zancada real (16 px al este, 9 al norte o al sur, 8 y 8 en diagonal:
  "La regla de la zancada" abajo); las bestias dejan cuatro patas por ciclo, las grandes
  más grandes y más hondas, arañas y cangrejos dos líneas de puntos, y las voladoras nada.
  Ninguna con el pie en el aire, quieto, girando en el lugar, deslizándose por una
  corrección ni al teletransportarse. El sonido del paso, la onda en el agua, el polvo al
  correr y las motas de MOV-7 salen de la misma pisada. Son máscaras blancas
  (`livingworld/fx/footprint_*`) teñidas con el `tint` de su superficie, un tono más oscuro
  del suelo: se leen sin contorno. No tienen tiempo de vida: en la arena las borra el
  viento, de a una ráfaga (entre dos ráfagas quedan como están).
- **Plantas que reaccionan:** hierba, hierba alta, flores, juncos, arbustos y jardineras se
  doblan hacia donde va quien pasa y vuelven con un resorte corto (900 ms). Los árboles
  se sacuden 1 px y sueltan alguna hoja (también de vez en cuando, solos). Desde el lote
  20 el doblez se suma al viento sobre las mismas tiras del sprite (abajo).
- **Agua y polvo:** anillos achatados que se abren en el agua baja; una nube de polvo al
  correr (paso de 260 ms o menos) por tierra, arena o ceniza, las dos bajo el pie que pisa.
  Las motas de MOV-7 siguen, también desde la pisada.
- **Bichos:** pájaros y mariposas por el pasto que huyen cuando el jugador se acerca,
  luciérnagas de noche y sombras de peces en el agua. Pocos (10) y
  donde el hash de la casilla diga: el mismo lugar siempre tiene el mismo bicho.
- **Desgaste de senderos** (estado del servidor, docs/02 "Senderos"; rama
  `feat/trail-wear`): tres etapas sobre el pasto, arte de color (no máscara) de
  `tools/spritegen/src/recipes/trail.ts` con los verdes de `ground/grass` y los marrones de
  `ground/dirt`: 1 pisoteado (hojas aplastadas, más pálidas, en vetas a lo largo del
  sendero y alguna mota de tierra), 2 gastado (manchas de tierra entre el pasto aplastado),
  3 tierra pelada (la tierra con terrones y un fleco de pasto aplastado). Cada etapa tiene
  16 formas según qué vecinas (N, E, S, O) están gastadas: un lado con vecina llega al
  borde y los otros se deshacen en un borde roto (alfa 0 o 255, sin tramado regular, con
  las esquinas redondeadas), así un sendero se lee como una franja continua y una casilla
  suelta como una mancha blanda. Va sobre los suelos y sus bordes (la capa de bordes no
  cambia) y bajo items y criaturas. La hierba alta, las matas y las flores de una casilla
  gastada se dibujan aplastadas (más bajas, con el pie fijo).
- Capa: huellas, ondas, polvo, peces y desgaste sobre el suelo y bajo sombras, items y
  criaturas (`MapView.groundOverlay`); hojas y bichos sobre el mapa.
- Arte propio 32x32 de `tools/spritegen/src/recipes/living.ts` en
  `assets/livingworld/sprites/`; plantas nuevas como items (`data/items/plants.yaml`).
- Todo se apaga con "Animaciones reducidas" o `prefers-reduced-motion`.


### Día y noche y sombras proyectadas (hecho, 2026-11-24, rama `feat/day-night-shadows`)
Pedido del dueño (2026-11-23): "los personajes todavía parecen flotar: sombras dinámicas
que sigan la forma real de cada uno; un ciclo de día y noche; y que las sombras sigan al
sol: a la mañana para un lado, a la tarde para el otro". Contrato en `livingworld/README.md`
"Día y noche"; aquí, la dirección de arte.
- **El ciclo:** 180 minutos reales de día y 60 de noche (decisión del dueño). El amanecer y
  el atardecer son los primeros y los últimos 15 minutos del día. La luna cambia de fase
  cada día, en 8 días.
- **La luz sobre la superficie** (multiply, la misma capa de luz de las cuevas): neutra de
  día (sin pasada de más), cálida al amanecer (`#ffc9a8`), naranja al atardecer
  (`#ffa86e`) y azul de noche: plateada con luna llena (`#8494c4`), más oscura con luna
  nueva (`#58648c`). **Nunca demasiado oscuro:** la noche no baja de una luminancia de 0,5
  (`floor`); un color más oscuro se mezcla hacia el blanco hasta llegar. Las transiciones
  son continuas (también al cambiar de día: la noche usa la luna del día en que cayó). Las
  cuevas no cambian.
- **Lámparas:** de noche (y subiendo durante el atardecer) brillan el jugador (una luz más
  suave que en la cueva) y todo item con `light` del atlas: fogatas, antorchas, faroles y
  ventanas.
- **Sombra proyectada de las criaturas:** la silueta de lo que se dibuja (cuerpo, ropa,
  equipo, en su frame), oscura (`CAST_SHADOW_TINT`, el mismo violeta casi negro de las
  sombras de árboles y casas), apoyada en los pies y tumbada en el suelo hacia el "norte"
  de la vista 3/4 (el sol está del lado de quien mira), torcida hacia donde no está el
  sol: larga al oeste a la mañana, corta bajo los pies al mediodía, larga al este a la
  tarde. Más larga cuanto más bajo el sol (hasta 1,4 alturas) y más tenue al salir y al
  ponerse. De noche la proyecta la luna, tenue (0,16) y según su fase (nada con luna
  nueva). Toda la capa se desvanece junta (un `AlphaFilter`): dos sombras que se cruzan o
  las capas de un muñeco no hacen manchas más oscuras. Un cuerpo que cae muerto conserva su
  sombra hasta desvanecerse a la mitad. "Animaciones reducidas" **no** apaga las sombras
  (una sombra quieta no es movimiento): solo detiene el vaivén del viento.
- **Sombra de contacto (la elipse), solo sin sombra proyectada** (dueño, 2026-11-25: "la
  sombra circular abajo del personaje arruina la nueva" y "está muy alejada del personaje
  y parece que flota"). Una criatura que proyecta sombra no dibuja la elipse; la elipse
  queda bajo tierra, bajo techo y en una noche sin luna, y para un cuerpo a menos de media
  opacidad (que no proyecta). Entre una y otra hay un fundido corto cuando la sombra
  proyectada es casi invisible (`CONTACT_GONE`, opacidad 0,06: el sol asomando, una luna
  fina), sin saltos. Donde queda, **toca los pies**: va en la línea donde el cuerpo está
  parado mirando hacia donde mira (`stance` de `atlas.json`, abajo), centrada bajo los
  pies y tan ancha como ellos más 8 px (entre 12 y 56 px): chica bajo una rata, ancha bajo
  el custodio.
- **Dónde está parado cada sprite (`stance`):** `foot` de `atlas.json` es lo más bajo que
  llega la caminata, y el pie que avanza hacia la cámara baja 3 a 5 px más que el cuerpo
  parado (el humanoide del motor: `foot` 3, parado a 6-8). Por eso la elipse quedaba
  despegada. `tools/spritepack` mide ahora, por orientación (las 8 del humanoide), la pose
  parada (los frames de `idle`, o los de `walk`): `stance: { s: [pie, x0, x1], … }`, las
  filas vacías bajo el píxel más bajo y las columnas que ocupa su base (el 15 % inferior
  del dibujo, mínimo 3 filas). La elipse y la sombra proyectada salen las dos de esa
  línea: la sombra arranca en las suelas, sin hueco. Un muñeco de capas se apoya en su
  cuerpo y su calzado (la punta de una espada no pisa el suelo).

#### Sombras de los objetos (hecho, 2026-11-25, rama `feat/object-shadows`)
Pedido del dueño: "quiero asegurarme que consideraste esta sombra dinámica para todos los
objetos, incluidos los árboles".
- **Todo objeto del mapa con altura proyecta la suya**, con la misma pose del sol o de la
  luna que las criaturas (dirección, largo, opacidad) y en la misma capa (un solo
  `AlphaFilter`: la sombra de un árbol que cruza la de un muro o la de un personaje hace
  un tono parejo, nunca una mancha más oscura): árboles, arbustos, rocas, postes,
  faroles, carteles, barriles, cajas, mesas, puestos, pozos, fuentes, fraguas, cofres,
  muros, portones, los objetos del mundo vivo (rompibles, empujables) y los restos de las
  criaturas. Sale de la **silueta dibujada** del objeto, apoyada en su base (la fila
  donde termina su dibujo: `feet` de `atlas.json`).
- **Qué proyecta lo dicen los datos**, no una lista en el código:
  `data/livingworld/shadows.yaml` (docs/06). Por defecto según el `kind` del item
  (`decoration` y `container`: silueta; `wall`: bloque), luego por familia (una palabra
  del id: `gate` es bloque; `border`, `stairs`, `rubble`, `torch`… no proyectan) y por
  último el item. Solo proyecta lo que está fijo en el mapa (`pickupable: false` y los
  muros): una espada tirada queda plana. Lo plano (bordes, placas, escombros, pasto,
  flores, telarañas) y lo colgado de un muro (antorchas, estandartes) no proyecta. Un
  cuerpo tendido (los restos) proyecta corto (`length: 0.4`).
- **Muros y edificios: sombra de bloque.** Cada casilla de muro proyecta la caja que
  ocupa (32 px de alto, lo que su dibujo sube sobre su casilla): el barrido de su borde
  norte y el de su borde este u oeste a lo largo de la sombra. Los barridos de casillas
  vecinas coinciden exactamente, así una pared entera hace una sola sombra continua, sin
  huecos; y como toda la capa se desvanece junta, donde se pisan no oscurecen el doble.
  Es una proyección de verdad (gira y se alarga con el sol), no la sombra horneada
  movida a pasos. Un portón se une a la sombra de su muro.
- **Árboles con viento:** la sombra es una segunda malla sobre las mismas tiras de la
  copa (`LivingWorld.windStrips`): se mece con ella y la del tronco queda quieta, sin
  costo por frame de más. Con "Animaciones reducidas" es un sprite quieto.
- **Bajo techo y bajo tierra, ninguna.** Bajo tierra no hay cielo. Los mapas no tienen
  techos: "adentro" son las casillas que los muros encierran (`indoorTiles` en
  `packages/renderer/src/tile-art.ts`). Una puerta, un portón o un vano de hasta 3
  casillas en un muro cierran el cuarto (casi todos los edificios tienen un vano sin
  puerta); un pasillo entre dos edificios no es un vano; un patio amurallado de más de
  400 casillas es cielo abierto. Adentro ni los muebles ni las criaturas proyectan (las
  criaturas llevan la elipse), y el suelo de adentro se dibuja **encima** de la capa de
  sombras, así la sombra de un muro o de un árbol nunca entra a la casa.
- **Sobre qué caen:** solo sobre el suelo. La capa va bajo los items y las criaturas; una
  sombra que llega a un muro más alto queda tapada por el dibujo del muro (se corta ahí,
  no trepa). Decisión tomada así por simple y porque se lee bien.
- **Límites conocidos** (docs/14): las huellas y ondas del mundo vivo no se ven bajo techo
  (el suelo de adentro las tapa); las criaturas con sombra pintada en el sprite (las de
  Dungeon Crawl) la conservan además de la proyectada; un objeto apilado sobre una mesa
  proyecta desde su altura, no desde el suelo.
- Capturas del E2E: `99a-daynight-indoors` (dentro del templo: elipse, sin sombra),
  `99b…99g` y `99d2-daynight-afternoon` en la plaza de Thimblewick (muros del templo,
  robles, arbustos, cartel), y `124-shadows-forest-morning`,
  `125-shadows-forest-afternoon`, `126-shadows-forest-full-moon` y
  `127-shadows-forest-noon` en el bosque de Ivernel.
- La sombra gira en la **línea de los pies** del sprite, no en el borde de abajo de la
  textura: un lobo o un thornling tienen filas vacías bajo los pies (`foot`) y su sombra
  sale de las patas a cualquier hora. Si el cuerpo se dibuja inclinado (`skewX` de la
  pose), la sombra se inclina con él.
- Capturas del E2E, una por hora: `99b-daynight-noon`, `99c-daynight-night` (luna llena),
  `99d-daynight-morning`, `99d2-daynight-afternoon`, `99e-daynight-dusk`,
  `99f-daynight-new-moon` y `99g-daynight-dawn`. **Pendiente mirarlas** en el E2E final del lote (docs/14): la
  revisión visual de esta rama se hizo sobre una vista previa local, sin capturas
  guardadas.
## 3. Animación de criaturas y personajes (ANI)

### ANI-1 Direcciones
**Los humanoides del motor, 8 (N, NE, E, SE, S, SO, O, NO)** desde el 2026-11-24 (pedido del
dueño del 2026-11-23: la diagonal se sentía más lenta y el personaje caminaba al noreste
mirando al este): todas las capas del muñeco (los dos cuerpos de los dos sexos, pelo, barba,
cabeza, torso, piernas, pies, escudos y armas; los cosméticos son tintes de esas capas, sin
píxeles propios) tienen quieto, caminar, atacar, disparar y conjurar en las ocho; morir sigue
cayendo al sur. Las diagonales salen del mismo modelo girado, nunca espejadas: la luz sigue a
la izquierda y el escudo en la mano izquierda. Giran **60°** desde el eje este-oeste, no 45°:
en la proyección 3/4 una casilla al este y una al sur son 1 unidad de ancho por 1/0,58 de
profundidad, así el modelo mira por donde su paso se desliza en pantalla (45° ahí) y el pie
apoyado se queda (`DIAGONAL_TURN`, `FACING_YAW` de `style.ts`). El resto de las criaturas
sigue en 4 (N, E, S, O). Qué dirección dibuja el cliente lo decide `turnTo`
(`packages/renderer/src/anim.ts`): una figura con diagonales en todas sus capas
(`ClipSet.eight`, `CreatureBody.eight`) gira a la diagonal en que camina o ataca; una de 4
direcciones **conserva la mitad de la diagonal que ya mira** (al noreste después de mirar al
norte sigue al norte; después de mirar al este, al este) y si no mira a ninguna de las dos
toma la horizontal, como antes. **Al atacar** (`faceTo`, que el canvas llama por criatura y
por frame): el servidor no gira a un jugador que ataca (su `dir` solo cambia al caminar o
con `Turn`), así que el giro es del cliente: la figura mira hacia su ataque (el octante del
objetivo: lejos al este y una casilla al norte es este, no noreste; `startAttack`,
`attackDir`) mientras dura el clip o la embestida, y después **sigue mirando ahí** hasta que
camina o cambia de dirección, para no volver a girar entre golpe y golpe. Es solo dibujo:
`dir` del servidor no cambia. La regla de 4 direcciones depende de hacia dónde miraba la
figura en *este* cliente (`AnimState.facing` arranca al sur cuando la criatura entra en
vista), así que dos clientes pueden ver al mismo monstruo de 4 direcciones mirando distinto
en una diagonal; es cosmético y se acepta. Si a una figura de 8 le falta un frame diagonal en
el atlas, se arma entera en 4 con sus frames rectos (`spriteClips`), sin perder la acción. Nunca se mezclan: si una capa no tiene diagonales (un arte
nuevo sin ellas), la figura entera va en 4. E puede ser el espejo de O solo si el sprite
declara `mirror: true`: con un escudo en un brazo, no. **Hecho** (2026-11-18) para los frames de archivos:
spritepack agrega los del lado que falta espejados (`assets/README.md`, "Sprites
animados"); lo usan las criaturas de Gemini. El motor de sprites dibuja las cuatro desde su
modelo, así el este conserva la luz desde la izquierda ("Motor de sprites", al final de
§3).

### ANI-2 Acciones, frames y tiempos

| Acción | Frames por dirección | Duración | Qué la dispara | Bucle |
|---|---|---|---|---|
| Quieto | 2–4 | 400–600 ms por frame (ciclo de 1,6–2,4 s) | 150 ms sin paso | sí, con fase por id de criatura |
| Caminar | 4 (mínimo 2) más la pose quieta | 2 frames por casilla: un ciclo cada 2 pasos | `CreatureMove` | por distancia, no por tiempo |
| Atacar cuerpo a cuerpo | 3–4 (anticipación, golpe, recuperación) | 300–400 ms | `CreatureAttack{MELEE}` (ANI-7) | no |
| Atacar a distancia | 3 | 300 ms | `CreatureAttack{RANGED}` (ANI-7) | no |
| Conjurar | 3–4 | 400 ms | `CreatureAttack{SPELL}` (ANI-7); curar y conjurar, el efecto sobre ella | no |
| Recibir golpe | 1 (o el procedural) | 150 ms | `Effect` 1 o `FloatingText` de daño en su casilla | no |
| Morir | 4–6 | 500–700 ms, después el cadáver | `CreatureDisappear{reason: DEATH}` (ANI-7) | no |
| Aparecer | procedural | 300 ms | `CreatureAppear` que no viene del borde de la vista | no |

- **Equivalencias con LPC** (convención de las hojas LPC clásicas; LPC Revised cambió en
  algunos casos la cantidad y el orden de los frames, así que se cuentan en la hoja al
  integrarla):

  | Hoja LPC | Frames | Nuestra acción | Cómo se usa |
  |---|---|---|---|
  | walk | 9 por dirección (1 quieto + 8) | caminar | 4 frames por casilla |
  | slash | 6 | cuerpo a cuerpo | |
  | thrust | 8 | lanza | |
  | spellcast | 7 | conjurar | 7 x 60 ms (`cast`) |
  | shoot | 13 | arco | una columna sí y una no: 7 x 50 ms (`shoot`) |
  | hurt | 6, solo hacia el sur | morir | |

- **Quieto y atacar, solo hacia sus lados** (2026-11-18): una criatura con frames de
  `idle` o `attack` en algunas direcciones y no en otras usa, en esas otras, el frame
  parado de esa dirección y la embestida de ANI-5 (`OWN_FACINGS`), en vez de girar hacia
  un lado que sí tiene frames. Caminar y morir siguen tomando el sur.
- **Caminar por distancia** (como hace `outfitFrame` hoy): el frame sale del avance del
  paso, así los pies no patinan si cambia la velocidad. En pasos encadenados no vuelve al
  frame quieto (ANI-3).

### ANI-3 Continuidad
- El frame quieto aparece solo después de 100 ms sin paso. Hoy, entre dos pasos, puede
  aparecer un frame quieto suelto.
- Girar sin caminar cambia el sprite al instante.
- La fase del ciclo quieto sale de un hash del id de la criatura, para que una manada no
  respire al unísono.

### ANI-4 Nombres en el atlas
`<sprite>/<acción>_<dir>_<n>`, por ejemplo `creatures/wolf/walk_s_0` o
`outfits/citizen/attack_e_2`.
- Los nombres T0.5 de los atuendos (`outfits/<id>/<dir>_<0|1|2>`) se siguen leyendo como
  `walk`, con el 0 como pose quieta, sin migrar nada. Desde A12 los cuatro atuendos son de
  LPC y esos nombres son alias de sus frames (`assets/README.md`, "Sprites animados").
- Un monstruo con `sprite: creatures/wolf` usa sus frames si el atlas los tiene, y si no,
  la imagen única con el procedural (ANI-5). Los frames salen de capas de un pack
  (`animations` en `assets/sprites.yaml`) o de archivos propios con esos nombres (los del
  motor de sprites: el jabalí, el ciervo y el eco de la forja; o las hojas de Gemini).

### ANI-5 Animación procedural para sprites de un solo frame
Es para los monstruos y NPCs de Dungeon Crawl de hoy, y para cualquier sprite futuro sin
frames. Todo se redondea a píxel entero de sprite, para que siga siendo pixel-perfect.

**Hecho (A8, 2026-11-17)** en `packages/renderer/src/anim.ts`, con estas diferencias con la
tabla: el golpe destella en rojo (un tinte multiplicado: sin textura ni filtro extra) en vez
de una silueta blanca, y morir y aparecer se desvanecen con alfa en vez del tramado Bayer.
El golpe, la embestida y la aparición también valen para los sprites con frames; la muerte
de un sprite con `death` juega su clip y se desvanece.

| Estado | Qué hace | Tiempos |
|---|---|---|
| Caminar | Salto: y = −round(2 · sin(π·t)) px, con t el avance del paso. Inclina la parte de arriba 1 px hacia donde va (skew) | Un salto por casilla |
| Mirar al costado | Espejo horizontal al ir al este o al oeste si el monstruo declara `facing: left \| right` (dato en `data/monsters`). Al norte o al sur conserva el último | Instantáneo |
| Quieto | "Respira": sube 1 px | 400 ms cada 1,6–2,4 s, fase por id |
| Volador (`flying: true`) | Oscila ±2 px siempre, y su sombra de contacto se achica cuando sube | 600 ms por ciclo |
| Atacar | Embestida: avanza 6 px hacia el objetivo y vuelve | 90 ms de ida y 160 ms de vuelta |
| Recibir golpe | Silueta blanca (textura generada al cargar el atlas) y retroceso de 2 px | 60 ms y después 120 ms |
| Morir | Destello blanco, se aplasta hasta la mitad del alto contra el piso y se disuelve con tramado ordenado (Bayer 4x4). Después aparece el cadáver que manda el servidor (los restos de su familia: "Hecho: proyectiles, restos por familia y la fuente del canvas") | 400 ms |
| Aparecer | La disolución al revés | 300 ms |

### ANI-6 Atuendos y cosméticos
Con humanoides de LPC (SRC-4), un atuendo era una **pila de capas** (cuerpo, ropa, pelo,
arma) compuesta en spritepack y guardada como frames ya armados en el atlas. Desde el
2026-11-19 la pila se arma en el cliente: el humanoide del motor es un muñeco de capas en un
tono neutro que el cliente tiñe y apila por dirección, y el equipo puesto se ve ("Humanoides
del motor", al final de §3). Los tintes de T5.7 (`tintFor`) tiñen la ropa del atuendo.

### ANI-7 Lo que falta del servidor
**Hecho (A9, 2026-11-18;** E2E del lote 7 con las capturas `07b-attack-pose` y
`11b-death` revisadas). El servidor dice quién ataca a quién y por qué sale
una criatura (docs/05, "Quién ataca y por qué sale una criatura"; `server/internal/
session/attack.go`), y el cliente anima con eso (`client/src/render/creature-events.ts` y
`game-canvas.ts`):
- **`CreatureAttack{id, kind, target_id, to, radius}`** antes del `Projectile`, el
  `Effect` y el `FloatingText` del ataque: `MELEE`, `RANGED` o `SPELL`, con el objetivo (si
  el cliente lo conoce), su casilla (o el borde de la ventana de su lado) o el centro y el
  radio de un área. El atacante juega el clip de ese tipo hacia el objetivo: `MELEE` el
  `attack` (el `slash` de LPC), `RANGED` el `shoot` (el arco) y `SPELL` el `cast`
  (`spellcast`); un sprite sin ese clip juega `attack`, y uno sin ninguno la embestida de
  ANI-5. Un área se juega hacia donde mira. La víctima retrocede alejándose del atacante o
  del centro del área.
- **`CreatureDisappear.reason`**: `OUT_OF_VIEW`, `DEATH`, `DESPAWN`, `TELEPORT`,
  `LOGOUT`. `DEATH` deja el cuerpo cayendo (LPC: el clip `death`, el `hurt` de la hoja;
  un solo frame: la caída de ANI-5); `TELEPORT` y `LOGOUT` lo desvanecen donde estaba
  (`VANISH_MS`, 350 ms: se angosta, sube un poco, pálido y parpadeando; nunca la caída);
  `OUT_OF_VIEW` y `DESPAWN` lo sacan en el momento. Cada salida se juega una vez, también
  si la criatura ya volvió en el mismo batch: un jugador que muere a la vista y despierta
  en un templo también a la vista deja su cuerpo cayendo donde murió y aparece (con su
  fundido) en el templo.
- **Sin filtrar nada:** el ataque llega solo a quien conoce al atacante (el de un
  invisible lo hace visible antes), nunca habla de un objetivo invisible y de uno fuera de
  la ventana da solo el lado. Volverse invisible sale como `TELEPORT`.
- **Servidor viejo:** `Welcome.attack_events` en `false` y el cliente sigue deduciéndolo
  como antes (abajo).
- **Lo que quedaba pendiente** (clips de disparo y de conjuro, la muerte con reaparición a
  la vista y el desvanecerse) está hecho: "Hecho: disparar, conjurar, desvanecerse, pasos
  y girar" (§7). `DESPAWN` sigue saliendo en el momento.

Lo que había antes, y queda como respaldo con un servidor sin `attack_events`:
- **Quién ataca a quién.** `Effect` solo trae la casilla. Para animar el golpe del atacante
  hace falta `attacker_id` (y la víctima) en un mensaje nuevo o en `Effect`. Es protocolo:
  docs/05 y revisión con `code-reviewer`. Mientras tanto el cliente lo deduce
  (`client/src/render/creature-events.ts`): el `Projectile` sale de la casilla del
  atacante, y un golpe cuerpo a cuerpo se atribuye a la criatura del otro bando que está al
  lado (primero el jugador propio si su objetivo está ahí, después la que mira esa casilla).
  Puede equivocarse con varios monstruos alrededor de un jugador.
- **Muerte o salida de la vista.** Si `CreatureDisappear` no lo distingue, se suma un
  motivo. Mientras tanto el cliente toma como muerte la salida de una criatura con la barra
  en 0 (el servidor manda `CreatureHealth` 0 antes de `CreatureDisappear`).

### Motor de sprites (hecho, 2026-11-18, rama `feat/sprite-engine`)
Pedido del dueño (2026-11-18): *"podrías poner un agente que arme el motor de generar
sprites, basándose en las referencias que habíamos hablado"*. El motor está en
`tools/spritegen/src/engine/` y convierte las referencias de §1 y las reglas ART y ANI en
maquinaria: un sprite nuevo se **describe** (partes con volumen, materiales de
`palette.ts` y, si es una criatura, un rig con acciones) y sale coherente con el resto, sin
poner píxeles a mano y sin Gemini. Cómo escribir un spec y un rig: `tools/CLAUDE.md`,
"spritegen: el motor".

**Cómo dibuja.** Cada sprite es un modelo chico en píxeles de sprite (x al este, y al
norte, z arriba) hecho de primitivas con volumen: elipsoides, cajas, cilindros, cápsulas
que se afinan (patas, cuellos, colas, cuernos, llamas), extrusiones de un perfil (el
cuerpo del yunque) y tarjetas finas. Un trazador de rayos ortográfico (un rayo por centro
de píxel y un buffer de profundidad) resuelve qué se ve; después vienen las pasadas de
pixel art: sombreado por umbrales, limpieza de píxeles sueltos, pliegues (la línea oscura
donde una parte tapa a otra), marcas de un píxel (ojos, fosas, bayas), el borde iluminado
y el contorno selectivo. Es determinista: el ruido de textura sale de la ruta del sprite y
vive en el marco de cada parte, así acompaña a la parte y no hierve entre frames.

**Cada regla, de dónde sale y dónde está** (todo en `engine/style.ts`, un solo lugar que
leen el renderer, las puertas y las hojas de revisión):

| Regla | Referencia (§1) | En el motor |
|---|---|---|
| ART-1 3/4 frontal | LPC: ortográfica, cámara a unos 60° | `PROJECTION`: la altura sube recta (1:1) y la profundidad se ve a tan 30° ≈ 0,58: se ven la cara de arriba y la sur |
| ART-5 luz | LPC: desde arriba y apenas desde la izquierda | `LIGHT`: arriba, izquierda y un poco del lado de la cámara (el flanco que mira a la cámara queda en el tono base), con la misma curva que `domeLight` de las recetas; `depthCue` oscurece lo lejano (la pata de atrás, la grupa vista de frente) |
| ART-5 3-4 tonos y un brillo | Realm of the Mad God y Stardew: pocos colores bien puestos | `SHADES`: umbrales que eligen el tono claro, base, sombra u hondo del material; `glint` en lo brillante (ojos, metal); `GLOW` para el fuego (lo que mira a la cámara, más claro) |
| ART-5 contorno selectivo | LPC: fuerte en personajes, suave en objetos; RotMG: contorno oscuro que separa del fondo | `OUTLINE`: en criaturas, casi negro abajo y a la derecha (`outline`, nunca `#000`) y un tono más claro arriba y a la izquierda (`deep`); en objetos, más suave; `GLOW_OUTLINE`: el fuego lleva el suyo en cualquier sprite, su tono hondo (el rojo del borde de una llama) arriba y a la izquierda y su contorno (una brasa oscura) del otro lado, y su pliegue en el tono de sombra (una llama más oscura, nunca una línea negra); `CREASE_DEPTH`: el contorno interno donde una parte tapa a otra; `RIM_LIGHT`: el borde iluminado, un tono más claro |
| ART-6 paleta, valores, tramado | LPC Revised: paleta limitada; tramado casi nunca | solo las rampas de `palette.ts` (los materiales de las criaturas del motor se sumaron ahí); `VALUE_BAND` por tipo; umbrales duros y `DITHER_MAX_SHARE` (10 %); alfa 0 o 255 |
| ART-2 tamaños y anclas | Tibia: lo grande crece hacia arriba; LPC: frames de 64x64 | `SIZES`: lienzo, ancla (`bc` o `br`), fila del suelo y alto y largo de la figura por clase; cada spec puede pedir un rango más angosto (las notas de "Animales medianos") |
| ANI-1 direcciones | Diablo II: cada dirección sale del mismo modelo | el modelo mira al oeste y se gira para cada dirección (`FACING_YAW`): las cuatro se dibujan, el este **no** es el oeste espejado y la luz sigue viniendo de la izquierda; `mirror` no hace falta |
| ANI-2 acciones y tiempos | Diablo II: muchos modos por monstruo; RotMG: ciclos cortos que se leen | `ACTIONS`: quieto 2-4 frames de 400-600 ms, caminar 2-4 (2 por casilla, por distancia), atacar 3-4 en 300-400 ms, disparar 3, conjurar 3-4, morir 4-6 en 500-700 ms; el validador los exige |
| ANI-3 continuidad | — | el ciclo de caminar empieza en un frame de contacto y el quieto respira desde la pose parada |
| ANI-4 nombres | — | `frameName`: `<sprite>/<acción>_<dir>_<n>`; spritepack arma los clips de esos archivos y el `CreatureBody` del cliente los juega sin cambios |
| ART-7 tiles e items animados | Stardew: el mundo se mueve en lo chico | `LOOP`: un objeto con `loop` sale como el sprite y `<sprite>/frame_<n>` (2 a 8 frames de 80 a 900 ms, `sync` world, tile o random), los nombres que spritepack ya arma como tile animado; el renderer lo juega con el `ms` y el `sync` de su entrada de `tiles` |
| "Un mundo que respira" | Stardew | quieto con respiración, orejas, colas y llamas que se mueven; chispas que suben |

De ningún juego se tomó un sprite, una forma ni una paleta: solo estas reglas de estilo.
Los modelos son diseños propios (el jabalí, el ciervo y el yunque son los de spritegen
llevados a volumen; el eco de la forja es nuevo).

**Puertas de calidad** (`engine/gates.ts` y `engine/check.ts`; corren en `make test` y en
`spritegen check`, que también corre al final de `make spritegen`): colores solo de sus
materiales y nunca `#000`, alfa 0 o 255, tramado bajo el 10 %, nada recortado contra el
borde del lienzo, contorno en al menos el 85 % de la silueta, una sola figura (aparte,
solo chispas de hasta 10 px), al menos el 20 % de su caja lleno, media de L* en la banda
de su tipo, alto y largo de perfil en el rango de ART-2, centrado de frente y de
espaldas, de frente y de espaldas al menos el 45 % de ancho de lo que mide de perfil
(`frontWidth`: un perfil girado hacia la cámara se lee como una raya a 1x; lo agregó la
revisión del jabalí), pies en la fila del suelo, un caminar que cambia de silueta, un
ataque y una muerte que se distinguen del parado, sur y oeste distinguibles, y las pistas de
`assets/sprites.yaml` iguales al rig (`anchor`, `shadow: ellipse`, `flying`, los `ms`; sin
`facing` ni `mirror`; sin entrada en `sprites`; un objeto con `loop`, su entrada de `tiles`
con el mismo `ms` y `sync`). Un `loop` se mueve (algún frame cambia al menos 4 px respecto
del 0) sin irse de su lugar (la caja de cada frame a 3 px o menos de la del 0). Más el
determinismo (mismo spec, mismos píxeles).

**Revisión:** `node --experimental-strip-types tools/spritegen/src/cli.ts sheet [--only
<prefijo>]` escribe en `build/spritegen/` la hoja de contacto de cada sprite del motor
(todos los frames a 4x en una grilla, una fila por acción y dirección) y su lineup a 1x
(como lo pone el cliente, con la sombra de contacto, al lado del lobo de Gemini y de una
persona de LPC). Se miran con Read.

**Hechos con el motor:**
- **Jabalí espinudo y ciervo de zarza:** quieto, caminar, atacar (embestida con los
  colmillos; carga con las astas) y morir (tambalea, se le doblan las patas y cae de lado)
  en las cuatro direcciones: 68 frames cada uno. Antes: un trote de 4 frames mirando al
  oeste (el este espejado; al norte y al sur, el mismo perfil), sin ataque ni muerte
  propios. El jabalí mide ~38 px de largo, 29 de alto y 22 de ancho visto de frente; el
  ciervo, ~35 de largo y 46 de alto con las astas (una persona de LPC).
  Revisión del 2026-11-18: de costado el jabalí del motor ya era mejor que el de antes,
  pero de frente y de espaldas se leía como una raya de 16 px a 1x. Se le ensancharon el
  cuerpo, los hombros, la cabeza y el hocico, las orejas y los colmillos salen hacia los
  lados y las patas se abren un poco (`SPLAY`): de frente es una cabeza ancha con el hocico
  y los colmillos delante del lomo con su cresta, y de espaldas la grupa con las patas
  abiertas. La puerta `frontWidth` lo cuida desde entonces.
- **Eco de la forja** (`npcs/forge_echo`, "lo que queda del último herrero de la
  forja"): un espíritu de fuego con forma de herrero que flota. El pecho, la cabeza y la
  mandíbula son un núcleo al rojo blanco (`fireCore` de `palette.ts`), con dos ojos de
  carbón; los brazos, la barba, el pelo que sube y se va hacia atrás, las lenguas de los
  hombros y la cola son llama (`flame`: amarillo, naranja y un borde rojo); en vez de
  piernas, el cuerpo se afina en una llama que se enrosca; con la mano derecha alza el
  martillo de herrero (mango de madera, cabeza de hierro con su brillo) delante de la
  cara, y la izquierda cuelga con el puño cerrado. De costado se ve girado 20° hacia la
  cámara (`views: { w: 20, e: -20 }`), para que se vean la cara, el pecho y el martillo.
  Quieto (las llamas lamen hacia arriba, suben chispas y el martillo se mece) y caminar
  (se desliza con la cola y el pelo hacia atrás) en las cuatro direcciones; se revisa
  sobre el suelo donde está, la tierra de la mina del Volcán (`seenOn: ground/dirt`).
  Antes: el elemental de fuego de Dungeon Crawl, un solo frame. Revisión del 2026-11-18:
  la primera versión del motor (un herrero de brasas con delantal de cuero) se leía peor
  que ese elemental: sobre la roca era una mancha naranja sobre dos palitos oscuros (el
  delantal y el martillo colgando) y de costado, un tronco ardiendo. Se rehízo sin nada
  oscuro abajo, con el núcleo claro, la cabeza, los brazos y el martillo alzado legibles y
  una silueta de costado de figura con el martillo en alto; se compararon las tres
  versiones lado a lado sobre su suelo y quedó la nueva.
- **Íconos de items** (2026-11-19): las 86 piezas de equipo; ver "Íconos de items", abajo.
- **Libros y cofres** (2026-11-19, lote 12, docs/02 "Libros y cofres";
  `specs/lore.ts`): un libro cerrado forrado en tela roja con su broche de latón y el borde
  de las páginas a la vista (`decor/book_closed`), un atril de madera con el escritorio
  inclinado hacia quien lee y un libro abierto con sus renglones y la cinta que marca la
  página (`decor/lectern_book`), un pergamino enrollado con sus perillas de madera, la cinta
  y el sello de cera (`decor/scroll`) y un cofre de tablones con la tapa redonda, dos bandas
  de hierro, las esquinas de hierro y la cerradura de latón (`decor/reward_chest`; siempre
  cerrado: el mapa es el mismo para todos). Revisión: los renglones del primer atril,
  apretados, se juntaban a 1x en dos manchas que se leían como una cara; quedaron tres por
  página, separados. El primer pergamino tenía la hoja suelta y se leía como un hueso.
- **Kit de props de pueblo** (2026-11-19, lote 12, `specs/town.ts`): doce props de una
  casilla para amueblar templos, depósitos, plazas y casas; ver "Kit de props de pueblo",
  abajo.
- **Yunque** (`decor/anvil`): el mismo yunque como modelo (pie, cintura redonda, bloque,
  cuerno y la cara pulida con su brillo y el agujero), con la luz del motor.
- **Props de una casilla** (2026-11-18, pedido del dueño: *"si bien las gráficas no están
  mal siento que necesitamos mejorarlas ... todo debiese tener animaciones"*). Cada uno se
  comparó con el dibujado a mano sobre cada suelo donde está en el mapa, a 1x, al lado de
  una persona de LPC, y quedó el del motor solo donde se leía claramente mejor:
  - **Tablero del mercado** (`decor/market_board`, 32x64): postes cuadrados con volumen,
    tablero de tablas en su marco, techito a dos aguas con hileras de tejas y cinco notas
    con sus renglones y su chinche (rojo o de hierro). Sobre la tierra del Bosque las patas
    finas del viejo desaparecían. Es el primer prop animado del motor: con el viento se
    levanta el pie de la nota de abajo a la derecha (`loop`: 4 frames de 180 ms, `sync:
    tile`), así el tablero donde se abre el mercado llama la vista.
  - **Cartel** (`decor/signpost`, los carteles de Cinderstead y de la puerta de la mina): dos
    tablas con renglones tallados y clavos, en un poste que sube por encima de ellas, en
    madera clara. El viejo, de madera oscura, se perdía sobre la tierra de la mina y el
    basalto.
  - **Cajón** (`decor/cargo_crate`, 29 en muelles, playas y depósitos de las cuatro
    islas): madera cálida, la tapa iluminada con dos juntas, listones más oscuros en el
    borde del frente, la riostra en diagonal y un clavo en cada esquina. El primer intento
    del motor (marco gris alrededor de la tapa, juntas en el frente) se leía peor que el
    viejo: la tapa perdía el borde y el marco se fundía con las tablas del muelle; el que
    quedó usa un solo material cálido y la tapa lisa. Gana sobre el muelle, la arena, la
    tierra y la piedra; sobre el piso de madera de los depósitos contrasta menos que el
    viejo de marco gris, pero se lee por la tapa clara y el contorno.
  - **Bolardo** (`decor/mooring_post`): se probó tres veces (tapa en hongo con faja de
    hierro y cabo suelto; poste claro; poste oscuro con dos vueltas de cabo) y ninguna le
    ganó al dibujado a mano, que tiene la tapa más nítida y el cabo suelto: sigue en
    `recipes/terrain.ts`.

**Decisiones:**
- **Un modelo con volumen y no recetas 2D:** las cuatro direcciones, la luz, el contorno y
  los pliegues salen solos y siempre iguales; con recetas 2D cada dirección se dibuja a
  mano.
- **Specs como datos en TypeScript** (objetos planos, sin funciones): tipados y validados
  (`validateSpec`); pueden salir de un helper (`motion.ts`: el trote en pares diagonales)
  o, más adelante, de un JSON o un YAML.
- **Sin acción de recibir golpe:** el cliente no la tiene (`AnimAction`) y el golpe
  procedural de ANI-5 (destello y retroceso) ya se ve; sumarla es un cambio del cliente y
  de spritepack.
- **El eco no tiene ataque ni muerte:** es un NPC (los NPCs solo están quietos y caminan).
- **La gaviota sigue a mano** hasta que el dueño elija su arte.
- **Un prop del motor reemplaza al dibujado solo si se lee claramente mejor** en su suelo,
  a 1x, junto a una persona de LPC; si empata, queda el de antes (el bolardo). Para
  objetos chicos rinden pocas piezas, un material cálido que contraste con el suelo y
  textura baja; el detalle (juntas, marcos de otro color) a 1x se vuelve ruido.
- **Props animados con `loop` y no con `actions`:** un objeto no tiene direcciones ni
  acciones; sus frames llevan los nombres de ART-7 (`frame_<n>`) y la temporización vive
  en `tiles` de `sprites.yaml`, como la de los props de `recipes/props.ts`: ni spritepack
  ni el cliente cambian.

**Pendiente:** otros props animados con `loop` (la bandera, el farol y el puesto de
mercado ya lo son, lote 12; el estandarte y la antorcha siguen en `recipes/props.ts`), la gaviota si el
dueño quiere, sumar primitivas si hacen falta (cajas redondeadas; los anillos de los
íconos de items salieron bien con un aro de cápsulas, sin toro) y
mirar en el juego el jabalí, el ciervo, el eco de la forja, el yunque y los cajones: el E2E
del lote 9 (verde) solo los muestra de pasada (los carteles de Cinderstead se leen claros) y
ningún screenshot los tiene (docs/14).

### Íconos de items (hecho, 2026-11-19, rama `feat/item-icons`, lote 11)
Pedido del dueño (2026-11-18, al rehacer el catálogo de equipo, docs/02 "Catálogo de
equipo"): pocas piezas, **cada una con su propio sprite dibujado con el motor de
sprites**. Eso reabre SRC-4, que dejaba los íconos de Dungeon Crawl: desde esta rama
ninguna pieza de equipo usa uno. Se dibujaron **86 íconos**: las 78 piezas del catálogo,
las 6 retiradas (siguen en inventarios viejos: el garrote de deriva, la espada corta
forjada, la hoja de espino, la rodela remachada, el jubón de cuero y el chaleco de piel) y
las dos municiones. La mochila, el único contenedor del equipo, ya era arte propio.

**La clase `icon`** (`engine/style.ts` `SIZES.icon`): una sola imagen de 32x32 con el
origen del modelo en el centro del lienzo (sin fila de suelo), que el cliente muestra
centrada en un slot del inventario (a 1x, o a 2x en los slots grandes de la figura) y en
su casilla cuando está en el suelo. Es de tipo `item`: el contorno oscuro de las criaturas
(`OUTLINE.item`: el slot es un pozo casi negro y el pasto es oscuro; con el contorno suave
de los objetos se perdía) con el pliegue suave de un objeto, y la banda de valor de los
objetos (ART-6, L\* 25-65). Puertas propias además de las de siempre (`GATES`): la caja
de la figura centrada a 1,5 px o menos en los dos ejes (`iconCentre`) y su lado más largo
de 16 px o más (`iconSpan`: más chico es una mancha a 1x); de alto y de ancho, de 8 a 30.

**Cómo se arman** (`engine/specs/items/`: `kit.ts`, `weapons.ts`, `armor.ts`,
`jewelry.ts`; `index.ts` los registra y arma las filas de la hoja de revisión):
- **Un constructor por línea** (espada, hacha, maza, arco, ballesta, varita, vara,
  escudo, torso pesado, túnica, cabeza, piernas, pies, amuleto, anillo, munición) y una
  llamada por banda con su forma y sus materiales: así una banda mejor se reconoce de un
  vistazo, y una pieza nueva es una llamada más.
- **Armas** a lo largo de +z, inclinadas 45° (`lean`): la cabeza arriba a la derecha y el
  lado -x (el filo de un hacha, el lomo de un arco) arriba a la izquierda, donde pega la
  luz. Una hoja son dos placas (`blade`): la mitad de arriba a la izquierda iluminada y la
  otra en sombra, así se lee la arista del medio.
- **Armaduras** de pie y de frente a la cámara, con un poco de `bulge` para que la luz
  de arriba a la izquierda las redondee: escudos con borde, cara, tablas, bandas y umbo;
  torsos con cuello, cinturón, hombreras; túnicas largas con mangas de campana y capucha;
  yelmos con la visera por delante de la cúpula; un par de botas de costado, una detrás de
  la otra.
- **Joyas:** el amuleto cuelga de frente (cordón o cadena de cuentas y el colgante
  abajo); el anillo, acostado e inclinado 15° hacia la cámara, con el agujero a la vista y
  la piedra arriba, es un aro de cápsulas (no hizo falta un toro). **Munición:** un atado
  de tres flechas o virotes, que se lee como una pila.
- `centred` mueve el modelo de a píxeles enteros hasta centrar la figura (un movimiento
  entero solo traslada los píxeles); `resized` agranda o achica una línea entera y la
  vuelve a centrar (`grow`, `specs/grow.ts`, compartido con los restos).

**Las bandas** (los materiales nuevos están en `palette.ts`, sección "Equipment icons"):

| Banda | Niveles | Metal y materiales | Acento | Silueta |
|---|---|---|---|---|
| 1 | 1–4 | hierro picado de óxido (`rust`), madera, lona, cuero alquitranado | ninguno | chica y simple |
| 2 | 5–9 | hierro (`iron`), madera clara | ninguno | un poco más grande |
| 3 | 10–29 | acero frío (`steel`), olmo, cuero de ciervo, musgo, espino | cristales de hielo y vidrio de tormenta en las de magos | más larga, guarnición, umbo, barba |
| 4 | 30–49 | acero de ascua (`darkIron`), ceniza, obsidiana, basalto | brasa que brilla (`ember`, `glow`) en el filo, las ranuras y las juntas | ancha, con púas, aletas o hombreras |
| 5 | 50–74 | hueso y escamas de dragoncillo (`bone`, `wyrmScale`) | oro y jade (`gold`), hielo grande | cuernos, colmillos, pavés alto |
| 6 | 75–100+ | acero de marea (`tidesteel`), madera ahogada, nácar (`pearl`) | runas que brillan (`rune`, `glow`) y perlas | la más grande y trabajada |

Un test (`engine/items.test.ts`) exige que cada banda de una línea cambie la imagen y no
use los mismos materiales que la anterior.

**Revisión:** `spritegen sheet` escribe, además de la hoja y el lineup de cada ícono (que
lo pone junto a una persona de LPC sobre el pasto y debajo en un slot del inventario a 1x
y a 2x), `build/spritegen/icons.slots.png` (todos, una fila por línea y una columna por
banda: en el slot a 2x, a 1x y sobre una casilla de pasto) e `icons.detail.png` (a 4x).
`make ui-preview`: la escena `inventory` y `inventoryfloat` llevan la figura completa con
la banda 3 y la mochila con piezas de las bandas siguientes; la tienda (`shop`) es casi
toda de equipo.

**Lo que aprendió la revisión** (2026-11-19, hojas a 1x, 2x y 4x): las hojas cortas y
anchas se leían como hojas de árbol (se alargaron hasta llenar ~26 px en diagonal); el
alfanje de óxido puro parecía de madera (hierro oscurecido con manchas de óxido); el acero
de marea muy claro tapaba sus runas (más oscuro, y la runa un cian saturado); las túnicas
con mangas cortas eran camisetas (mangas de campana, falda que se abre y capucha); el hacha
de doble filo parecía un martillo (un pico curvo como una ola atrás); las botas
alquitranadas, el anillo de zarza y el amuleto de brasa quedaban bajo L\* 25 (más claros).

**Siguen de Dungeon Crawl:** la comida, los materiales, las pociones, los items de quest,
el hacha de leñador, el martillo de herrero, la runa y las escaleras. El pack queda entero
en `assets/vendor/dungeon-crawl/` (se guarda tal como se bajó).

### Kit de props de pueblo (hecho, 2026-11-19, rama `feat/town-props`, lote 12)
Auditoría del 2026-11-19 (art.items[0] y [3]): lo primero que ve un jugador nuevo es
Lanternby, y el templo, la plaza, el depósito y las casas tenían el piso vacío; las minas eran
salas oscuras donde solo alumbraba el jugador, con arte animado y con luz (antorcha y
estandarte de pared, brasero, fuente, muros con ventana) que no estaba en ningún mapa.

**El kit** (`tools/spritegen/src/engine/specs/town.ts`, `data/items/decoration.yaml`):
doce props de una casilla dibujados con el motor, en materiales cálidos (madera clara,
madera oscura, piedra, tela) que se despegan de los suelos de los pueblos.

| Prop | Lienzo | Bloquea | Elevación | Animación |
|---|---|---|---|---|
| Barril (`barrel`): duelas que se abren en el medio, cuatro aros de hierro, tapa oscura | 32x32 | sí | 8 | — |
| Mesa (`table`): tapa de tablas con dos juntas sobre cuatro patas cuadradas | 32x32 | sí | 8 | — |
| Banco (`bench`): asiento de tablas sobre dos patas de tabla y un travesaño | 32x32 | no | — | — |
| Estante (`shelf`): estante abierto contra el fondo de su casilla, con tarros, botellas, una tela doblada y libros | 32x64 | sí | — | — |
| Cama (`bed`): cabecera redonda, colchón, frazada roja doblada y almohada | 32x32 | no | — | — |
| Farol (`lamp_post`): poste de hierro sobre un pie de piedra y un farol abierto | 32x64 | sí | — | la llama se mece: 3 frames de 130 ms, `tile`; `light: 3` |
| Pozo (`well`): brocal redondo de piedra con agua oscura, dos postes, techito, torno con soga y balde | 32x64 | sí | — | — |
| Sacos (`sacks`): dos sacos de arpillera atados y un tercero acostado delante | 32x32 | sí | — | — |
| Red de pesca (`fishing_net`): red en malla de rombos colgada de un bastidor, que se comba, con corchos rojos | 32x32 | sí | — | — |
| Jardinera (`flower_box`): cajón de tablas con hojas y flores rojas, amarillas y blancas | 32x32 | no | — | — |
| Puesto de mercado (`market_stall`): mostrador con canastas de manzanas y pan y una pieza de tela, toldo a rayas rojas y crema | 32x64 | sí | — | el fleco flamea: 4 frames de 160 ms, `tile` |
| Mástil con bandera (`flag_pole`): mástil en un pie de piedra con remate dorado; bandera azul con franja dorada y cola de golondrina | 32x64 | sí | — | 4 frames de 170 ms, `tile` |

- **La bandera son cuatro tarjetas colgadas una de otra** (cada una `parent` de la
  siguiente, con la articulación en el borde de la anterior): en cada frame cada tarjeta
  gira sobre la vertical un cuarto de vuelta de fase detrás de la anterior, así la onda
  corre a lo largo de la bandera. El fleco del toldo, igual: una parte por festón, cada
  una colgada del borde del toldo, y la ráfaga las levanta de oeste a este (un giro en x
  hacia atrás: las puntas suben y se acortan, que es lo que se lee a 1x; hacia la cámara
  casi no cambian).
- **Lo que no bloquea** (banco, cama, jardinera) es lo que puede ir en una casa que se
  alquila: no le quita casillas al inquilino (docs/03 "Muebles y luces"). Barril y mesa
  levantan lo que se apila encima (ART-8).
- **El farol da luz** en las cuevas como una antorcha (`light: 3`); en la superficie la
  capa de luz no dibuja nada (no hay noche), así que ahí es decoración.
- **Revisión:** `spritegen sheet --only decor/` escribe, además de la hoja y el lineup de
  cada uno, `build/spritegen/town.floors.png`: los doce sobre cada suelo de los pueblos
  (piedra, madera, tierra, basalto, pasto, arena y tablones de muelle), al lado de una
  persona de LPC, a 1x (mostrado a 2x). Lo que aprendió la revisión: los sacos de tela
  clara eran una nube sobre cualquier suelo y pasaban la banda de valor (L\* 68): son de
  arpillera (`sand`), más altos, con el cuello atado oscuro y separados; la primera red,
  una grilla recta de hilos, se leía como la reja de una ventana: es una malla de rombos
  que se comba hacia el medio, y sus hilos son de 2 px (de 1 px en diagonal salía un
  damero de más del 10 %); el fleco del toldo que giraba hacia la cámara no se veía
  moverse.
- **Tests:** `tools/spritegen/src/engine/town.test.ts` (el kit, los `loop` en el rango de
  ART-7 y la luz del farol en `sprites.yaml`, la onda que recorre la bandera sin mover el
  mástil, la hoja de revisión) y `packages/map-format/src/town-props.test.ts` (los items
  del kit, lo que tiene cada pueblo, las antorchas de las minas y que nada bloquee donde no
  debe; docs/03 "Muebles y luces"). Las puertas del motor corren sobre los doce como sobre
  todo spec.

**Dónde está** (con `mapcli ops apply`; reglas en docs/03 "Muebles y luces"):
- **Templos** de Lanternby, Ivernel y Cinderstead: braseros a los lados de las puertas, dos
  estandartes en el muro norte, muros de piedra con ventana, bancos como reclinatorios y
  una mesa de altar.
- **Plazas:** una fuente en cada una (3170,6387; 4159,6111; 3656,5791), puestos de
  mercado, faroles, bancos, un mástil con bandera; un pozo en Ivernel y en Cinderstead.
- **Depósito de Lanternby, armería, curtiduría de Ivernel y archivo de Casia:** estantes,
  barriles, sacos, cajones y mesas. El libro cerrado del archivo (`book_smith_notes`) quedó
  sobre una mesa.
- **Las 13 casas:** una cama (no bloquea) y dos ventanas de madera cada una; jardineras
  afuera en las de Lanternby que dan a la calle.
- **Minas:** una antorcha de pared cada 7 casillas en las caras de la roca (28 en la de
  Puerto, 8 en la cueva del Bosque, 19 en la del Volcán) y braseros en las salas hondas
  (7, 3 y 7), que las antorchas del muro norte no alcanzan.

**Lo que queda:** la muralla (`rampart_wall`) no encajó en Lanternby (el frente de mar es
una playa abierta con el muelle; una muralla ahí cortaría el paso) y queda para un pueblo
amurallado de una isla nueva; los props del kit en las islas que vengan; ver la luz de
las antorchas y los braseros en el juego (el E2E del lote, docs/14).

### Humanoides del motor (hecho, 2026-11-19, rama `feat/humanoid-art`, lote 13)
Pedido del dueño tras jugar Thimblewick (2026-11-19): los personajes y los NPCs eran
*"muy grandes y desproporcionados, tienen la cabeza y el cuerpo gigante"*; *"quiero que sea
proporcionado y que se vean los items que tiene equipados"*; *"los sprites de ataque tienen
que ser con el arma que esta utilizando"*; *"el personaje se ve como que esta flotando"*. Las
criaturas del motor sí le gustaron ("son mas realistas"). Jugadores, NPCs y monstruos
humanoides eran personajes de LPC (figura de ~46 px con la cabeza enorme) armados por
spritepack; ahora son **un humanoide del motor** con un muñeco de capas (*paper doll*), en
`tools/spritegen/src/engine/specs/humanoid/`.

**Proporciones** (`skeleton.ts`; `humanoid.test.ts` las mide): 36-40 px de los pies a la
coronilla (37-42 con el contorno; la clase `humanoid` de `style.ts`), la cabeza un sexto
(6-7 px), los hombros de 11 a 13 px, las piernas la mitad del alto y la punta de los dedos a
media pierna; la misma vista 3/4, la luz y el contorno de las criaturas del motor. Dos
cuerpos (`sturdy` y `slender`) sobre **el mismo esqueleto**: cambian el torso (pecho,
cintura, cadera, hombros) y el grosor de los brazos, así una misma capa de casco, arma,
piernas o botas les sirve a los dos; la ropa del torso se dibuja por cuerpo. Seis tonos de
piel para jugadores (más dos solo para criaturas: ceniza y ahogado), seis peinados y calvo,
nueve colores de pelo y tres barbas (ninguna, corta, cerrada): datos de `data/looks.yaml`
(docs/06 "Looks"). Al lado del jabalí y el ciervo el humanoide queda más chico que la
persona de LPC: los animales se dibujaron contra esa persona (~25 px por metro) y se dejan
como están, porque al dueño le gustan.

**Hombre o mujer** (2026-11-20, rama `feat/character-sex`; el dueño: "ojo el personaje
principal puede ser hombre o mujer"): el sexo es una elección aparte del cuerpo, así que hay
**cuatro cuerpos** (`TRUNKS` de `skeleton.ts`, por sexo y build) sobre **las mismas
articulaciones**. La mujer: hombros más angostos y caídos (la línea del hombro del tronco 1,5
a 2 px más adentro; los brazos cuelgan de la misma articulación, así un escudo o una espada
le quedan igual), cintura más fina y la línea de la cadera más ancha que ella (un reloj de
arena a 1x: el tronco de frente va 10, 8, 6, 10 px de los hombros a la cadera, el del
hombre 12, 10, 8, 10), un pecho sugerido por dos ondulaciones suaves que se notan en uno o
dos píxeles de perfil, brazos, piernas y cuello un poco más finos, la mandíbula más chica y
redonda y la nariz menor; nada sexualizado. **Misma altura**: un esqueleto más bajo pediría
otra versión de cada casco, arma, bota y peinado. Lo que más la distingue en el juego es la
ropa del torso, que se dibuja sobre su cuerpo (`worn/torso_<forma>_<cuerpo>_female`): el
cinturón ciñe la cintura en vez de ir sobre la cadera y la túnica cae un poco más larga y más
abierta (un vestido corto). El resto de las capas (pelo, barba, cabeza, piernas, pies,
escudos, armas) es compartido: se dibujan con el hombre robusto de oclusor, y en otro cuerpo
un píxel que el hombre tapaba y ese cuerpo no cubre es un hueco; `humanoid.test.ts` acota
los huecos a 3 px por frame (hoy: 0 en el hombre robusto, 2 en el esbelto y en la mujer
robusta, 3 en la esbelta, en el borde de una capucha o una vara). Los sprites del hombre no
cambiaron (mismas rutas y frames); los de la mujer suman 12 capas (2 cuerpos y 10 torsos,
1008 frames). Atlas (docs/07): sigue en 2 páginas, la segunda pasa de 2048x399 a 2048x569;
+414 KB de PNG, +373 KB de JSON de páginas y +113 KB de `atlas.json`. Tests: proporciones
de los cuatro cuerpos, la silueta de ella distinta de la de él con la cabeza y los pies en
las mismas filas, los huecos de las capas compartidas y que cada combinación de sexo, cuerpo,
peinado, barba y torso tiene sus capas con todos sus frames.

**Acciones** como el jugador de antes: quieto (2 frames de 500 ms), caminar (8), atacar (4 de
90 ms: el brazo arriba atrás, el golpe adelante y abajo con medio paso, el seguimiento y la
vuelta; el brazo izquierdo adelanta el escudo), disparar (3 de 100 ms: el izquierdo sube el
arco, el derecho tensa hasta la mejilla y suelta), conjurar (3 de 130 ms: los brazos suben y
empujan) en las cuatro direcciones, y morir (4 de 150 ms: tambalea, se le doblan las
rodillas, cae de costado) hacia el sur, como antes. Visto de costado se gira 10° a la cámara
(`views`): se leen la cara, los dos hombros y lo que tiene la mano lejana.

**La regla de la zancada** (lo que hacía flotar al de LPC: abría los pies 18-21 px y el
preset daba 4 frames por casilla, un paso por casilla de 32 px; el pie apoyado patinaba ~45 %
de cada paso). Las piernas son de cinemática inversa (`legsTo`): cada frame pone el tobillo
donde debe estar y deja la cadera tan alta como la pierna apoyada lo permite. Un ciclo por
casilla: cada pie está apoyado medio ciclo, mientras el cuerpo pasa sobre él media casilla
(`STRIDE`, 16 px), así el pie se corre hacia atrás exactamente lo que el cuerpo avanza.
Frames por casilla = frames × 32 / (2 × zancada) = 8 (`walkPerTile`); los frames están medio
frame corridos del contacto, así en cada uno hay un pie apoyado (a +6, +2, −2 y −6 px de la
cadera). Mirando al norte o al sur, la vista 3/4 acorta la profundidad del modelo (0,58 px por
unidad) y la casilla del mapa no: el ciclo dura más en pantalla, 8 / 0,58 = 13,86 frames por
casilla (`perTileNS`, `per_tile_ns` en `assets/sprites.yaml`, que el cliente usa con
`AnimActionMeta.perTileNS`). Un paso en diagonal recorre una casilla de ancho y una de alto en
pantalla: el ciclo avanza por distancia, hypot(8; 13,86) = 16 frames por paso
(`walkPerStep`, también para las criaturas de 4 direcciones: un animal hace √2 veces su
`perTile`). `humanoid.test.ts` mide el contacto del pie, píxel por píxel, en las ocho
direcciones contra lo que avanza el cliente: se queda a 1 px de su punto del suelo (en las
diagonales, en x y en y).
La cadera baja ~1 px cuando la pierna apoyada está más lejos (contacto) y sube cuando pasa por
debajo; los brazos van contra las piernas (22°) y el tronco se inclina 4°. **La pausa de 100 ms entre pasos (ANI-3)** no cambió: con pasos encadenados
el siguiente empieza donde termina el anterior (el colchón de jitter y la predicción de
`state/world.ts`) y el ciclo sigue sin repetir ni volver (`anim.test.ts`: un frame cada 50 ms
de un paso de 400 ms da 0..7, 0..3 en dos pasos); solo un hueco real de la red la muestra, con
el último frame de caminar y no el quieto. **Girar en medio de una caminata** no hace saltar
las piernas: la fase del ciclo se cuenta en frames (`AnimState.walkPhase`, cada paso suma los
frames por casilla de su dirección), no en pasos por el ritmo de la dirección de ahora (con 5
pasos al este, el primero al norte empezaba en el frame 5 en vez del 0).

**El muñeco de capas** (`layers.ts`; el orden y el modelo, en `packages/renderer/src/look.ts`):
cuerpo → piernas → pies → torso → pelo y barba → cabeza → escudo → arma, cada capa en las
mismas poses del rig, así sigue cada frame. Cada capa es un spec del motor con `layer`: se
dibujan sus partes y **el cuerpo las tapa** donde están detrás (`renderSpec`: las partes de
`occlude` se proyectan sin pintar; el borde de una capa contra el cuerpo lleva el pliegue,
así se ve el ruedo de la túnica sobre las piernas o la línea del pelo en la frente). Por eso
el orden solo decide lo que cae fuera del cuerpo, por dirección (`LAYER_ORDER`). **Lo que se
lleva en la mano va sobre la ropa en las cuatro direcciones**, sea cual sea la mano y haga lo
que haga el frame: bajo el cuerpo, un arma sostenida delante de él desaparecía (el arco, en
la mano izquierda, mirando al oeste: tapado entero; la hoja levantada sobre el hombro en el
impulso del ataque mirando al norte) y su borde perdía píxeles contra el contorno del cuerpo;
sobre la ropa, una pieza sostenida detrás del cuerpo pinta como mucho unos píxeles del ruedo
de una túnica larga. El arma va sobre todo; el escudo también, salvo mirando al este (en el
brazo lejano): sobre el torso y bajo el pelo y lo de la cabeza. Al este el arma (mano cercana)
va sobre el escudo, al oeste bajo él. El pelo va bajo el torso mirando al sur (lo que cae por
la espalda) y la barba bajo todo mirando al norte. Las diagonales toman la ropa y el pelo de la
dirección recta hacia la que se inclinan (sur o norte) y las piezas de la mano de su lado: al
sureste el arma sobre el escudo, al suroeste el escudo sobre el arma; al noreste el escudo
(brazo lejano) bajo la cabeza y sobre el pelo; al noroeste el arma va arriba de todo menos el
escudo, aunque esté en la mano lejana: bajo la ropa, una lanza levantada perdía 12 px contra
una túnica, y sobre una túnica larga o una coraza pinta 1,35-1,45 veces los píxeles errados del
mejor lugar (la única excepción del 10 % del test). Una lanza mirando al noreste deja hasta 6
píxeles de hueco en los cuerpos de mujer (el tope de 3 sigue en las rectas). Una falda (túnica, túnica larga) no deja
que la atraviesen las piernas (`occlude` sin piernas). `humanoid.test.ts` lo mide contra el
modelo: dibuja la figura entera como una sola (las partes de la pieza con el cuerpo y la ropa
de tres aspectos como oclusores, un solo buffer de profundidad: lo que se debe ver de la
pieza) y la compara con las capas apiladas como el cliente, con la pieza en cada lugar de la
pila, en todas las formas de arma y escudo y en cada frame de quieto, caminar, atacar,
disparar y conjurar. Ningún otro lugar puede quedar más de un 10 % más cerca del modelo (los
buenos difieren unos pocos por ciento de un aspecto a otro; el arma bajo el cuerpo, como
estaba, costaba de 1,3 a 3,7 veces más al oeste y al norte), y ninguna capa de arriba tapa más de 2 px de un arma
que el modelo muestra. **Un muñeco se desvanece entero:** Pixi multiplica el alfa de un
contenedor en cada hijo, así que al aparecer, caer, desvanecerse o ser invisible se veían unas
capas a través de otras (la piel bajo la túnica); las capas van en un contenedor propio que,
mientras no es opaco, se dibuja a través de un `AlphaFilter` (`CreatureBody.opacity` para la
invisibilidad del jugador propio).

**Formas, no piezas** (presupuesto de docs/07): no se dibuja una capa por pieza del catálogo
sino unas pocas formas por lugar, en un tono neutro (`palette.ts` `look*`, hechos con
`neutral`, que `tools/gemini/import_art.py` no toma como colores de la paleta) que el cliente
tiñe (un multiply) con el material de la pieza: cabeza (gorro, capucha, yelmo abierto, yelmo
cerrado, diadema), torso (túnica, túnica larga, cuero, malla, placas), piernas (pantalón,
grebas), pies (zapatos, botas, escarpes), escudos (rodela, redondo, de cometa, pavés) y armas
por clase (espada, hacha, maza, daga, lanza, arco, ballesta, vara, varita). Cada pieza de
`data/items` dice su `worn: {shape, tint}` (las 76 que se ven: el equipo de las bandas del
lote 11 y las anteriores; las joyas no); una pieza sin `worn` no se dibuja. La capucha
esconde el pelo y el yelmo cerrado también la barba (`hides` de `data/looks.yaml`).

**El ataque con el arma en la mano:** el golpe del cuerpo es uno solo y cada clase de arma
gira su empuñadura por frame (`Grip` de `layers.ts`): la espada sigue el arco del brazo, el
hacha y la maza cargan más atrás y pegan más abajo, la daga y la lanza quedan horizontales y
apuntan adelante (una estocada), la vara se levanta derecha y se empuja hacia el objetivo. El
arco va en la mano izquierda, siempre vertical; la ballesta en la derecha, horizontal al
disparar. El cliente elige el clip por el arma (`attackActionFor`): arco y ballesta
disparan, varita y vara conjuran, un hechizo conjura siempre y el resto (o el puño) golpea.

**Atuendos:** el atuendo por defecto (`citizen`) da el cuerpo y la ropa de un jugador hasta
que llegue su aspecto propio (rama `feat/character-look`), y su ropa se ve solo donde no hay
nada equipado; los atuendos de la tienda son disfraces (`costume: true`) que tapan torso,
piernas y pies aunque haya armadura (el casco, el escudo y el arma se siguen viendo). El
color de la tienda (`outfit_color`) tiñe la ropa del atuendo; el estilo del nombre, igual
que antes. `outfits/<atuendo>/<dir>_0` es un quieto compuesto (la vista previa de la tienda y
el respaldo del cliente) y cada NPC que es una persona tiene su retrato quieto `npcs/<npc>`
(el del diálogo): los arma `previews.ts` de las capas con los colores de `data/looks.yaml`.

**NPCs y monstruos humanoides** tienen su `look` en `data/npcs` y `data/monsters` (cuerpo,
piel, pelo, barba y lo que llevan): los 19 NPCs que eran de LPC y el saqueador, el
contrabandista, el minero de obsidiana y el minero ahogado. Las composiciones de LPC, las
paletas `palettes` de `assets/sprites.yaml` y el pack `assets/vendor/ulpc/` (con sus filas de
`CREDITS.md` y los textos de `/credits`) salieron: nada los usa. El preset `lpc` de
spritepack queda (es una capacidad de la herramienta, con sus tests).

**Revisar:** `node --experimental-strip-types tools/spritegen/src/cli.ts sheet --only humans/
[--ref persona.png]` escribe `build/spritegen/humanoid.<aspecto>.sheet.png` (cada frame de un
aspecto compuesto, a 4x) y `humanoid.lineup.png` (los aspectos de `REVIEW_LOOKS` quietos,
caminando y golpeando, a 1x y a 2x sobre la grilla de casillas, al lado del jabalí, el ciervo
y la persona de referencia). Lo que se aprendió: una serie completa de un material se lee
como una estatua (el acero de ascua era marrón y parecía cuero: quedó gris cálido); las armas
son finas a 1x (la espada mide 13 px, el arco 20).

**Pendiente:** las piezas de un juego de armadura son de un solo tinte (el cinturón de la
coraza, del mismo color); el arco no se tensa con la mano (la cuerda queda recta); los
jugadores ajenos se ven con su atuendo hasta que `feat/character-look` mande su equipo (sus
ataques juegan el clip de su tipo, `figureAttack`: uno a distancia dispara); la silueta
translúcida (tapado por un muro o por otra criatura) muestra solo el cuerpo.

## 4. Sensación de movimiento (MOV)

### Hecho: A6, primera parte (2026-11-18, rama `feat/movement-feel`)
Lo que se hizo y lo que cambió respecto del plan de abajo. El detalle técnico está en
`client/CLAUDE.md` ("Movimiento fluido"), `server/CLAUDE.md` ("Caminar") y docs/05
("Caminar"). **Donde el plan y esto no coinciden, vale esto.**
- **El servidor sí cambió** (el plan decía que no hacía falta). Con "`Walk` reemplaza la
  cola por un paso", el cliente tenía que esperar la confirmación de N para mandar N+1 y
  calcular con el RTT cuándo mandarlo; con RTT alto igual quedaban huecos. Ahora:
  - **Cola de teclado en el servidor.** Cada `Walk` se encola detrás de los pasos de
    teclado que esperan, con tope `movement.max_queued_steps` (`balance.yaml`, 4; el
    `Welcome` se lo dice al cliente). Si en la cola hay un camino por click o un paso de
    persecución, se descarta. Uno más que el tope reinicia la caminata (`WalkRejected` con
    `dir` `UNSPECIFIED`). El ritmo sigue siendo del servidor (`readyAt` por paso).
  - **Época de la caminata (`walk_epoch`).** Cada `WalkRejected` y cada teletransporte
    (`FullMapView`) empiezan una época nueva. Un `Walk` de otra época se descarta sin
    contestar.
  - **Número de cada paso** (`Walk.seq`, que vuelve en `CreatureMove.walk_seq` solo en la
    copia del propio jugador). El cliente empareja cada respuesta con su predicción aunque
    el servidor haya dado antes un paso de un camino o de persecución, o se haya perdido un
    `Walk`.
  - **Sin `StopWalk` al soltar la tecla.** Soltar no manda nada: los pasos ya mandados se
    dan. Garantía (docs/05): todo `Walk` aceptado termina en `CreatureMove`, `WalkRejected`
    o `FullMapView`. **Ningún camino nuevo puede vaciar la cola en silencio**
    (`server/CLAUDE.md`). Un `StopWalk` con pasos sin confirmar deja al cliente esperando
    respuestas que no llegan, hasta que las abandona a los 3 s (`PREDICT_TIMEOUT_MS`).
- **MOV-1, cambio.** El cliente va hasta `max_queued_steps` pasos sin confirmar (4, no 2).
  Manda cada `Walk` apenas lo decide, `STEP_LEAD_MS` (50 ms) antes de que termine el paso
  dibujado, sin esperar la confirmación del anterior ni medir el RTT. Cada paso empieza en
  el `fin` del anterior.
- **MOV-2, en parte.** Un toque durante un paso camina apenas termina
  (`MovementKeys.take`), y soltar en los últimos 50 ms todavía da el siguiente. El toque
  corto que solo gira se hizo después ("Hecho: disparar, conjurar, desvanecerse, pasos y
  girar", §7).
- **MOV-5, cambio.** No es `scheduleStep`: es un colchón de jitter (`Playout`) sobre la
  línea de ticks del servidor. Cada paso se encadena tras el que se dibuja y, si va
  atrasado, se dibuja hasta 25 % más rápido. Vale para las demás criaturas y para el
  camino propio por click.
- **MOV-6.** Cámara y criaturas a píxel de pantalla (la prueba que proponía); quedó.
- **Además:**
  - dos flechas perpendiculares caminan en diagonal y, contra un muro, se desliza por la
    mitad libre;
  - toda corrección se desliza en 160 ms (`SLIDE_MS`), también la del propio jugador desde
    los 4 pasos predichos;
  - un giro (`Turn`) sale solo sin pasos sin confirmar: el servidor gira en el acto y cada
    paso de su cola vuelve a fijar la dirección;
  - las criaturas sin frames de caminar dan un saltito de 1 px por paso (`walkBob`; después
    lo reemplazó el salto procedural de ANI-5, `packages/renderer/src/anim.ts`).
- **Quedaba** (hecho en la segunda parte, abajo): MOV-3, MOV-4, MOV-7, el E2E de MOV-9 con
  latencia y una flecha durante un camino por click, que casi nunca entraba.
- MOV-8 es una decisión del dueño: no se tocó.

### Hecho: A6, segunda parte (2026-11-18, rama `feat/movement-more`)
Solo cliente: el servidor y el protocolo no cambian. El detalle técnico está en
`client/CLAUDE.md` ("Movimiento fluido"). **Donde el plan de abajo y esto no coinciden,
vale esto.**
- **MOV-4, cambio: el click ya no manda `WalkPath`.** El cliente arma el camino con A*
  (`state/steering.ts`, `Steering.walkTo`) desde donde lo tiene: después de los pasos que
  ya mandó, que se siguen dando. Lo camina como una tecla mantenida: cada paso se predice
  y sale como `Walk` (época y `seq`) 50 ms antes de que termine el dibujado, por la misma
  cola. El servidor valida cada paso y marca el ritmo (`readyAt`, `max_queued_steps`),
  igual que con el teclado. El primer paso sale en el acto: al apretar el botón sobre
  una casilla sin un item para arrastrar, o al soltarlo si lo hay.
  - **Por qué `Walk` y no predecir los pasos de un `WalkPath`:** un `WalkPath` reemplaza
    la cola del servidor (vacía en silencio los `Walk` sin confirmar) y sus pasos vuelven
    sin `walk_seq`. Con `Walk`, cada respuesta se empareja con su predicción y el click no
    espera a que no queden pasos sin confirmar.
  - **El rodeo lo hace el cliente.** El servidor no recalcula un `Walk` bloqueado por una
    criatura: lo rechaza. El cliente vuelve deslizándose, anota esa casilla y arma el
    camino de nuevo sin ella. Un segundo rechazo lo termina (`ROUTE_REFUSALS`): la puerta
    de una casa o una zona de protección con el bloqueo de PvP mandan un aviso por
    rechazo, y el camino no lo repite casilla por casilla. También lo rearma si una
    criatura que ve se mete en el próximo paso, o si el servidor le dio otro paso
    (persecución); como mucho `ROUTE_REPLANS` (10) veces por click. Sin camino, se
    detiene.
  - Una flecha durante un camino por click entra en el próximo borde de casilla y termina
    el camino (antes casi nunca entraba: el frame solo leía las teclas sin camino).
  - El doble click en el mapa (controles de menú) ya no manda `StopWalk`: termina el
    camino que empezó su primer click y los pasos ya mandados (normalmente uno) se dan.
    Un `StopWalk` dejaría al cliente esperando respuestas de pasos que el servidor borró.
  - `WalkPath` sigue en el protocolo: lo usan los bots (`tools/bots`).
- **MOV-3, como el plan, con un rodeo que se mantiene.** El botón izquierdo mantenido sobre
  el mapa camina hacia el cursor: después de `HOLD_WALK_MS` (200 ms) quieto, o apenas se
  arrastra si la casilla no tiene un item para arrastrar.
  - En cada borde de casilla elige la dirección (de 8) por el ángulo del cursor respecto
    del personaje dibujado: cada dirección toma sus 45°. Con el cursor sobre la casilla
    propia no camina. Una diagonal bloqueada se desliza por su mitad libre, como la tecla.
  - Si la dirección está bloqueada, da el primer paso de un A* hacia la casilla bajo el
    cursor y **sigue ese rodeo mientras el cursor apunte al mismo lado**. Con solo el
    primer paso, en una U de muros el personaje salía y volvía a entrar. Sin camino, gira.
  - No pisa en línea recta una escalera, un agujero o un teletransporte salvo que sea la
    casilla bajo el cursor, igual que el camino del click: arrastrar el cursor por encima
    de un agujero no cambia de piso sin querer (un agujero puede pedir soga para volver).
  - La cámara sigue al personaje: el cursor quieto en la pantalla sigue apuntando igual y
    se camina en línea, como en Diablo 2.
  - El puntero queda capturado (`setPointerCapture`): soltar fuera del canvas también
    termina. Al soltar se dan los pasos ya mandados, sin `StopWalk`. Un click corto (menos
    de 200 ms y sin arrastre) sigue siendo "caminar hasta ahí".
  - Sobre una casilla con un item para arrastrar, arrastrar antes de los 200 ms sigue
    moviendo el item: es lo que docs/14 dejaba para decidir.
  - Con el dedo no hay mantener: el toque largo es el menú (T5.6) y está el pad.
- **MOV-7, en parte.**
  - Un anillo de 300 ms en la casilla del click, que se cierra y se desvanece
    (`render/walk-mark.ts`): dorado si hay camino; rojo si no (y el camino de antes
    termina).
  - El texto de la acción por defecto junto al mouse sobre el mapa (UI-5), apenas pasa por
    la casilla y sin esperar a que se quede quieto: "Atacar
    a lobo", "Hablar con Tilde", "Trepar", "Abrir mochila" (`client.action.*`). Sale de
    `defaultAction` (`input/actions.ts`): la primera opción del menú de esa casilla. No
    aparece sobre el suelo pelado ni sobre un adorno que no hace nada al usarlo (un árbol,
    un muro); sí sobre una estación, el tablero del mercado o una puerta. Es un `attr()`
    de CSS: no es texto de la página para los lectores de pantalla ni para los tests. Se
    oculta mientras hay un menú abierto (lo tapaba).
  - El primer paso sale en el acto (MOV-4).
  - **Polvo y ondas al pisar:** no se hicieron acá; después, con las partículas de A13
    ("Hecho: disparar, conjurar, desvanecerse, pasos y girar", §7).
- **MOV-9, hecho.** E2E en `client/e2e/movement.spec.ts` con ~150 ms de RTT y jitter. Es
  un proxy en Playwright (`page.routeWebSocket`): 75 ms más 0–40 ms por sentido, en orden.
  El cliente no tiene un parámetro de latencia.
  - Una flecha mantenida 10 casillas tarda la suma de sus 10 pasos ± un frame, sin frames
    quietos.
  - El mouse mantenido y un click de 5 a 7 casillas caminan sin frames quietos ni hacia
    atrás, y arrancan menos de 150 ms después del botón. Antes, el click esperaba un RTT y
    un tick.
  - `state/walking.test.ts` simula además el mouse mantenido y el click previsto, en
    enlaces de 2 a 300 ms con jitter.

### Por qué se sentía "paso, pausa, paso" (antes de A6)
- **El cliente espera la confirmación.**
  - `Game.frame` (`client/src/game.ts`) no hace nada mientras `world.pending` exista, y
    `WorldState.canStep` exige `pending === undefined`. El paso siguiente sale cuando
    terminó la animación del anterior **y** llegó el `CreatureMove` que lo confirma.
  - Al nivel 1 un paso dura 500 ms (`base_step_ms` 1000, velocidad 205, terreno 100,
    redondeado a ticks de 50 ms), así que casi no se nota.
  - A nivel alto o con haste (pasos de 200–300 ms), un RTT de 150 ms más la espera al tick
    alcanzan para frenar al jugador en cada casilla.
- **Cada paso pierde un frame.** `predictStep` empieza el paso nuevo en `now` (la hora del
  frame), no donde terminó el anterior. Se pierden hasta 16 ms por casilla a 60 Hz, o 33 ms
  a 30 FPS: un tirón chico y regular, más un atraso que se acumula.
- **Los demás arrancan cuando llega el paquete.** `WorldState.move` empieza el paso de otra
  criatura al recibirlo. Los batches salen cada 50 ms y con jitter de red:
  - si el paso siguiente llega antes de que termine el anterior, la criatura salta hacia
    adelante;
  - si llega tarde, se para.
- **Click para caminar sin predicción.** El cliente arma el camino con A* (`findPath`) y lo
  manda como `WalkPath`, pero no mueve nada hasta el primer `CreatureMove`.
- **Cámara y criaturas a píxel de sprite.** `followCamera` y el dibujo redondean a píxel de
  sprite: a 2x se mueven de a 2 px de pantalla. A velocidad baja y 144 Hz, unos frames no
  se mueven y otros sí.

### Propuestas
El plan, con lo que A6 hizo marcado. Antes de A6, `Walk` reemplazaba la cola por **un**
paso y por eso el plan era solo del cliente. Ya no: el servidor encola los pasos de
teclado (ver "Hecho: A6, primera parte" y docs/05 "Caminar").

- **MOV-1 Pasos encadenados (✅ A6, distinto del plan original).**
  - El paso N+1 previsto empieza exactamente en `fin(N)`, no en `now`. Si el frame llega
    tarde, la interpolación arranca ya avanzada.
  - El cliente puede ir **hasta `max_queued_steps` pasos sin confirmar** (4) delante del
    servidor. Con ese tope, espera.
  - `Walk(N+1)` sale cuando el cliente decide el paso, `STEP_LEAD_MS` (50 ms) antes de
    `fin(N)`, **sin esperar la confirmación de N**: el servidor lo encola detrás de N (no
    lo reemplaza) y lo da el tick en que N termina. Cada `Walk` lleva la época y su número
    (`walk_epoch`, `seq`).
  - Si el jugador cambia de dirección, el paso siguiente va hacia la nueva; los ya
    mandados se dan. Al soltar la tecla **no** sale `StopWalk`: los pasos ya mandados se
    dan. `StopWalk` vacía la cola sin contestar y el cliente se quedaría esperando sus
    confirmaciones.
  - `WalkRejected` descarta todo lo previsto y vuelve a la posición del servidor,
    deslizándose.
- **MOV-2 Buffer de entrada (✅ A6 y `feat/lpc-actions`: el toque durante un paso, y el
  toque corto que solo gira con el teclado y con el pad).**
  - Una tecla apretada en el último 40 % del paso (o en sus últimos 150 ms) se guarda y se
    ejecuta en el borde de la casilla.
  - Cambiar de dirección con la tecla mantenida vale en el próximo borde.
  - Un toque de otra dirección de menos de 80 ms estando quieto solo gira (o Ctrl+flecha,
    como en Tibia).
- **MOV-3 Mantener el mouse (Diablo 2) (✅ A6, con un rodeo que se mantiene).**
  - Con el botón izquierdo mantenido sobre el mapa, en cada borde de casilla el cliente
    elige la dirección (de 8) hacia la casilla bajo el cursor. Si está bloqueada, usa el
    primer paso de su A* hacia ella. Lo predice y lo manda como un paso de teclado
    (`chooseStep` y `Walk` con época y `seq`, MOV-1).
  - Al soltar, se dan los pasos ya mandados, como con la tecla: nada de `StopWalk`.
  - Un click corto (menos de 200 ms y sin arrastre) sigue siendo "caminar hasta ahí".
- **MOV-4 Click para caminar, previsto (✅ A6: cada paso es un `Walk` y el rodeo lo hace
  el cliente).** El camino lo arma el cliente, que manda los pasos. Puede ir prediciendo
  esos pasos con MOV-1 (como mucho `max_queued_steps` adelante, cada uno como `Walk`)
  mientras los `CreatureMove` coincidan. Antes, un `WalkPath` reemplazaba la cola: el
  click lo mandaba solo sin pasos de teclado sin confirmar. Si el servidor rodea a una
  criatura (recalcula con A*), el cliente acepta sus pasos con la corrección de siempre.
  Como mínimo, predecir el primer paso para que el click responda en el acto.
- **MOV-5 Línea de tiempo para los demás (✅ A6, como colchón de jitter: `Playout`).**
  El plan era una función pura `scheduleStep(prev, move, now)`, con tests:
  - un `CreatureMove` empieza en `max(llegada, fin del paso anterior de esa criatura)`;
  - si va atrasado más de un paso, empieza ya y dura hasta un 40 % menos, para alcanzar;
  - nunca se salta hacia atrás. Solo se teletransporta si `from` no es el último `to`
    conocido;
  - opcional: retraso de dibujo de 50 ms (un tick) para absorber el jitter de los batches.
- **MOV-6 Cámara y redondeo (✅ A6).**
  - Velocidad constante dentro de la casilla: nada de suavizado por casilla, que frena y
    acelera en cada una.
  - Cámara clavada en la posición interpolada del jugador (Tibia y Diablo 2 la centran
    igual). Sin "mirar adelante", para que la vista sea igual para todos.
  - Probar a redondear cámara y criaturas a **píxel de pantalla** en vez de píxel de
    sprite, y comparar en 60 y 144 Hz. Si se ve mejor, queda.
- **MOV-7 Respuesta visual (✅ A6, y el polvo y las ondas en `feat/lpc-actions`).**
  - Una marca animada en la casilla destino del click (anillo de 300 ms).
  - Polvo y ondas al pisar (ART-7).
  - El texto de la acción por defecto junto al cursor (UI-5).
- **MOV-8 Velocidad (👤 decisión del dueño, no cambia sin él).** Al nivel 1 se camina a 2
  casillas por segundo. Bajar `base_step_ms` de 1000 a 800 da 400 ms por paso (2,5
  casillas/s). Toca balance:
  - la persecución de los monstruos;
  - el kiteo de los arqueros;
  - el ritmo de horas por nivel que usa la detección de bots (`balance.yaml` `pace`).

  Por eso queda propuesto y no aplicado.
- **MOV-9 Criterio de aceptación (✅ A6: E2E con un proxy de latencia en Playwright, no un
  parámetro de desarrollo del cliente).**
  - Con 150 ms de latencia simulada en el WebSocket (parámetro de desarrollo), mantener una
    flecha 10 casillas tarda 10 × la duración del paso ± 1 frame, y no hay frames con el
    sprite propio quieto.
  - Tests unitarios con reloj falso para MOV-1, MOV-2 y MOV-5.
  - Un E2E que muestree `__rpgClient` por frame.

## 5. UI (UI)

### UI-1 Principios
- **El mapa primero.** No hay UI opaca fija sobre casillas visibles. Las ventanas flotan,
  se mueven y se cierran.
- **Oscura y gótica** (piedra, hierro y oro viejo, como referencia Diablo 2) con **todas**
  las funciones de hoy. Nada de lo que hoy se puede hacer se pierde.
- **Sin scroll para elegir:** conversación, tienda y botonera entran enteras.
- **Animaciones cortas** (≤ 240 ms), solo `transform` y `opacity`. Se apagan con
  `prefers-reduced-motion` y con la opción "Animaciones reducidas".
- **Accesible y traducible:** contraste ≥ 4.5:1 en el texto, foco visible, todo con
  teclado, textos con i18n y lugar para un 25 % más de largo, ventanas con
  `role="dialog"`. Excepción del dueño (2026-11-23): mover y cambiar el tamaño de las
  ventanas es solo con el mouse (UI-5).
- **Táctil:** la lógica de `ui/layout.ts` (T5.6) se mantiene. En teléfono, la botonera es
  la barra de pestañas y las ventanas son hojas.

### UI-2 Tokens de diseño
Van en `:root` de `client/src/ui/client.css` y reemplazan a `--bg`, `--panel`, `--text`,
`--muted`, `--accent` y `--error` (que se vuelven alias durante la migración).

| Token | Valor | Uso |
|---|---|---|
| `--ui-void` | `#090807` | Fondo detrás del mapa y de la página |
| `--ui-stone-950` | `#0f0d0b` | Fondo de slots y pozos |
| `--ui-stone-900` | `#171410` | Fondo de ventana |
| `--ui-stone-800` | `#211c17` | Barra de título, HUD |
| `--ui-stone-700` | `#2e2720` | Botón |
| `--ui-stone-600` | `#40362c` | Botón con hover |
| `--ui-iron-900` | `#1a1816` | Contorno exterior de los marcos |
| `--ui-iron-600` | `#4a4540` | Marco |
| `--ui-iron-400` | `#7a7268` | Bisel claro (arriba a la izquierda) |
| `--ui-iron-200` | `#a9a094` | Remaches, brillo |
| `--ui-gold-700` | `#6e5422` | Oro en sombra |
| `--ui-gold-500` | `#b8923f` | Títulos, borde activo |
| `--ui-gold-300` | `#e2c47a` | Hover, foco, selección |
| `--ui-text` | `#ddd2b8` | Texto (pergamino); 12:1 sobre `stone-900` |
| `--ui-text-muted` | `#9c917c` | Texto secundario; 5,9:1 |
| `--ui-text-dim` | `#6f6656` | Solo lo deshabilitado (3,2:1, no para texto que haya que leer) |
| `--ui-life-700` / `-500` / `-300` | `#5a0f0f` / `#a3201b` / `#e0523f` | Orbe y barras de vida |
| `--ui-mana-700` / `-500` / `-300` | `#0e1e4d` / `#2347a8` / `#5d86e6` | Orbe y barras de maná |
| `--ui-xp` | `#c9a646` | Barra de experiencia |
| `--ui-ok` / `--ui-warn` / `--ui-danger` | `#5f9e4f` / `#d29a2e` / `#e5574a` | Estados y requisito no cumplido; los tres ≥ 5:1 sobre `stone-900` |
| `--ui-item-quest` | `#e2c47a` | Nombre de item de misión |
| `--ui-chat-party` / `-guild` / `-private` / `-system` / `-broadcast` | `#7fb2ff` / `#7fd07a` / `#d48cff` / `#d9b44a` / `#ff8a5c` | Canales del chat |
| `--ui-radius` | `2px` | Esquinas casi rectas (gótico, no "app") |
| `--ui-slot` | `36px` | Slot de item (32 de ícono + 2 de borde) |
| `--ui-shadow` | `0 6px 18px rgb(0 0 0 / 0.6)` | Ventana flotante |
| `--ui-dur-fast` / `--ui-dur` / `--ui-dur-slow` | `80ms` / `140ms` / `240ms` | Duraciones |
| `--ui-ease-out` / `--ui-ease-in` | `cubic-bezier(.2,.8,.2,1)` / `cubic-bezier(.4,0,1,1)` | Curvas |

**Marco de hierro** (CSS puro, el respaldo de todo):
`border: 2px solid var(--ui-iron-600)` y
`box-shadow: 0 0 0 1px var(--ui-iron-900), inset 1px 1px 0 var(--ui-iron-400), inset -1px -1px 0 var(--ui-iron-900), var(--ui-shadow)`.

**Texturas y ornamentos.** Todo es propio: nada se toma de Diablo.
- **Piedra:** un SVG en línea con `feTurbulence` (`baseFrequency` ≈ 0.9, 2 octavas) como
  `data:` en el CSS, al 6–8 % de opacidad sobre el color de piedra. La CSP de escritorio
  permite `img-src data:` y prohíbe `<style>` en línea: va en `client.css`.
- **Esquinas con remaches:** `border-image` 9-slice de un PNG propio de spritegen
  (`ui/frame/iron`, 24x24 con esquinas de 8 px), a 2x con `image-rendering: pixelated`. Si
  no está, queda el marco de CSS de arriba.
- **Orbes:** gradiente radial más una ola SVG que se desplaza (bucle de 4 s), brillo de
  vidrio arriba a la izquierda y el nivel con `clip-path`.
- **Íconos:** pixel art propio de 16x16 o 24x24 dentro de lienzos de 32x32
  (`ui/icons/*`), como las marcas PvP de hoy (`UI_ICON_BOX`).

### UI-3 Fuentes (OFL)
Rutas verificadas el 2026-11-17 en `https://github.com/google/fonts`. Las cinco elegidas
**no tienen nombre reservado** (Reserved Font Name) en su `OFL.txt`, así que se pueden
recortar y pasar a woff2 con su nombre.

| Uso | Familia | Ruta en google/fonts | Archivos |
|---|---|---|---|
| Títulos de ventana, botones principales | Cinzel | `ofl/cinzel` | `Cinzel[wght].ttf` |
| Logo, pantalla de muerte, subida de nivel | Grenze Gotisch | `ofl/grenzegotisch` | `GrenzeGotisch[wght].ttf` |
| Texto de interfaz (listas, botones, chat) | Alegreya Sans | `ofl/alegreyasans` | `AlegreyaSans-Regular.ttf`, `-Italic`, `-Medium`, `-Bold` |
| Diálogos de NPC, descripciones, libros | Alegreya | `ofl/alegreya` | `Alegreya[wght].ttf`, `Alegreya-Italic[wght].ttf` |
| Canvas: números de daño, globos de diálogo | Pixelify Sans | `ofl/pixelifysans` | `PixelifySans[wght].ttf` |
| Canvas: nombres sobre las criaturas (desde el 2026-11-25) | Alegreya Sans 700 y 500 | `ofl/alegreyasans` | los de la interfaz |

- **Alternativas** (también OFL):
  - Spectral (`ofl/spectral`), para cuerpo.
  - Silkscreen (`ofl/silkscreen`) y Tiny5 (`ofl/tiny5`), pixel de 5 px. Tiny5 es la
    alternativa para nombres a zoom 1x si Pixelify Sans no queda nítida.
  - Fondamento (`ofl/fondamento`) y Almendra (`ofl/almendra`) **tienen nombre reservado**:
    no se recortan ni se convierten con su nombre. Se usan tal cual o no se usan.
- **Exocet,** la de Diablo, es propietaria: ni se usa ni se imita.
- **Auto-alojadas** (la CSP de escritorio dice `font-src 'self'`; nada de Google Fonts por
  red):
  - los `.ttf` originales con su `OFL.txt` en `assets/vendor/font-<familia>/` (§6, SRC-3);
  - un plugin de build genera woff2 recortados (latín básico, Latin-1 y Latin
    Extended-A: alcanza para "¿¡ñáü" y para el inglés) y los sirve en `/fonts/`;
  - `font-display: swap` y fallback `Georgia, serif` o `system-ui`.
- **Escala:** títulos de 15–16 px en Cinzel 600 con `letter-spacing: .04em`; interfaz de 14
  px con interlineado 1.35; diálogos de 16 px con 1.45. Números con
  `font-variant-numeric: tabular-nums` (vida, oro, pesos).
- **Tamaño de fuente** como opción: del 90 % al 130 %, en `rem`. **Hecho**, con una escala
  de la interfaz aparte ("Hecho: lo que quedaba de A3, A4 y A5").

### UI-4 Layout de escritorio y "ver más pantalla"
**Hoy (A14, pantalla completa, "Hecho: A14" en §7):** lo que pidió el dueño el 2026-11-18
("Lo que pidió el dueño", arriba): el mapa ocupa toda la pantalla, sin marco ni columna;
abajo, la barra gótica, lo único fijo; todas las ventanas flotan y se acomodan donde el
jugador quiera, con imán. Antes (A3, "Hecho: A2 y A3") los orbes, la botonera, las
ventanas acopladas y el chat iban en una columna a la derecha del mapa (el dock).
```
┌──────────────────────────────────────────────────────────────────────────────┐
│[Batalla]  [Grupo]          [avisos, intercambio]          [Gremio] [Inventario]│
│                                                                    [Contene-] │
│[Habilidades]          MAPA a pantalla completa                     [ dores  ] │
│                    (el jugador al centro, sobre la barra)                    │
│ [estados] [Chat translúcido]  [Diálogo / tienda / estación abajo al centro]  │
│ [▣▣▣]                          ┌ Nombre · Nivel 15 ┐                         │
│ ╭─────╮════ barra de experiencia ═══════ 62 % ═════════════════════ ╭─────╮ │
│ │ Vida│ F1 … F12 (hotbar)                       [I][K][B][P][G][O]  │Maná │ │
│ ╰─────╯                                         [⚙][?][M][Salir]    ╰─────╯ │
└──────────────────────────────────────────────────────────────────────────────┘
```
- **La barra** (88 px a la escala 100 %, `client/src/ui/HudBar.tsx`): piedra en sillares
  bajo una banda de hierro con remaches y filo dorado; los orbes en engastes de hierro que
  salen de la barra, con dos pináculos cada uno; pilares de hierro a los lados del medio y
  una cresta de pináculos al centro. Sobre el orbe de vida, una placa con nombre, nivel,
  experiencia y condiciones. La escala de la interfaz la agranda como a las ventanas; a
  960 px de ancho entra igual (la hotbar pagina sus slots con flechas). **Desde el lote 13**
  (abajo, "Hecho: bandeja de estados y placa del nombre") la placa se fue: el nombre y el
  nivel van al medio, sobre la barra de experiencia (la placa del nombre reemplaza a la
  cresta), y sobre el orbe de vida queda la bandeja de estados.
- **El mapa** es la pantalla sobre la barra: el jugador queda al centro de esa área y nada
  del mapa se esconde bajo la barra. La vista ajustada siempre la cubre a escala entera
  (tabla de abajo).
- **Las ventanas** flotan sobre el mapa y nunca bajan de la barra ni salen de la pantalla
  (UI-5).

**El plan de antes (UI-4 original, A3),** que A3 cambió por el dock y A14 retomó a su modo:
- **Se va el encabezado de hoy:**
  - nombre, nivel y experiencia pasan al HUD (sobre la barra de XP, o al pasar el mouse por
    los orbes);
  - idioma, sonido y "Salir del juego" van a la ventana Opciones (y Escape la abre si no
    hay nada que cerrar);
  - la ayuda de controles va a un botón "?".
- **HUD abajo, de 88 px:** orbes de 76 px que sobresalen 16 px por arriba del HUD, como en
  Diablo 2; en el centro la hotbar y a la derecha la botonera.
- **La columna derecha** (lista de batalla, grupo y ventanas acopladas) se oculta con un
  botón y vuelve con otro. Oculta, el mapa gana sus 230 px.
- **Casillas visibles (decisión del dueño: hasta 31x21):**
  - la vista es la más grande que entra en el área del mapa, con lados impares para que el
    jugador quede al centro, **mínimo 15x11 y máximo 31x21**. Lo que sobra queda en
    `--ui-void`;
  - la escala por defecto es la más grande que muestra al menos 15x11;
  - el jugador puede alejar hasta la escala más chica disponible, sin pasar de 31x21, y
    acercar hasta 7x5 como hoy (`render/zoom.ts`);
  - además de las escalas enteras, se propone **1,5x** con escalado "sharp-bilinear":
    dibujar a 2x (vecino más cercano) y bajar a 1,5x con filtro lineal. Los píxeles quedan
    parejos con un desenfoque mínimo. Es una opción de Opciones → Gráficos, apagada por
    defecto.

  Ejemplos del plan, con la columna visible (230 px) y el HUD (88 px), en CSS px con el
  escalado del sistema al 100 % (los de hoy, a pantalla completa, en "Hecho: A14"):

  | Ventana | Por defecto | Alejando | Con la opción 1,5x |
  |---|---|---|---|
  | 1280x800 (la del E2E) | 2x: 15x11, como hoy | 1x: 31x21 | 21x13 |
  | 1280x720 | 1x: 31x19 (a 2x no entran 11 filas) | — | 21x13 |
  | 1920x1080 | 2x: 25x15 | 1x: 31x21 | 31x19 |
  | 2560x1440 | 3x: 23x13 | 2x: 31x21 | — |

- **Servidor (A7):**
  - el cliente pide su vista (de 15x11 a 31x21) y el servidor manda esa área más 1 de
    margen;
  - hoy `server/internal/session/aoi.go` fija 15x11 + 1 (17x13 = 221 casillas). A 31x21
    son 33x23 = 759 casillas por `FullMapView`, y cada `MapSlice` lleva una fila o columna
    de 33 en vez de 17. También hay más criaturas a la vista;
  - hay que volver a medir "< 4 KB/s por jugador" (`docs/07`) con bots a 31x21;
  - ni el rango de hechizos ni el de los monstruos cambia;
  - ver más lejos es igual para todos los que eligen la vista grande.

### UI-5 Botonera y ventanas separadas
- **La botonera** (a la Tibia: botones de 32x32 con marco de hierro e ícono propio; la
  tecla va en el tooltip y en `aria-keyshortcuts`):

  | Botón | Tecla | Abre |
  |---|---|---|
  | Inventario | I | Ventana de equipo y contenedores |
  | Habilidades | K | Nivel, experiencia, skills y oficios |
  | Grupo | P | Grupo (miembros con vida y maná, invitar, salir) |
  | Gremio | G | La ventana del gremio (UI-7) |
  | Mercado | M | La ventana del mercado si hay un tablero al lado. Si no, deshabilitado con el tooltip "Usa un tablero de mercado" |
  | Apariencia | O | Cosméticos (T5.7), con vista previa animada en 4 direcciones |
  | Opciones | Esc | Sonido, Gráficos, Controles, Interfaz, Idioma, Créditos y Salir |
  | Ayuda | H | Controles y teclas |

  Ninguna tecla choca con WASD. Las teclas valen solo si el foco no está en un campo de
  texto (`takesText`, `input/keyboard.ts`). Los números 1–9 siguen siendo de los diálogos.
- **`GameWindow`** (componente nuevo): título con ícono, ×, arrastre, foco y orden
  (z-index).
  - Escape cierra la ventana de arriba.
  - Se acopla a la columna (estilo Tibia: se pliega a su título) o flota sobre el mapa.
    **Desde A14 no se acopla:** flota siempre, se suelta en cualquier lugar y un imán la
    alinea con los bordes de la pantalla, el techo de la barra y los bordes de las otras
    ventanas (a menos de 10 px). Se pliega a su título como antes.
  - Recuerda posición, tamaño y si estaba plegada en `localStorage` `rpg.windows`
    (comodidad de cada jugador: si se pierde, vuelve al valor por defecto).
  - Tiene un tamaño mínimo y nunca queda fuera de la pantalla.
  - **Cambio del dueño (2026-11-23): se cambia el tamaño desde las cuatro esquinas, como en
    Ragnarok Online.** Solo las esquinas (una zona de agarre de unos 12 px sobre cada
    adorno de esquina); los bordes no. Arrastrar una esquina de arriba o de la izquierda
    mueve la `x`/`y` de la ventana y deja quieta la esquina contraria. Se respetan el
    mínimo (160x72), el área sobre la barra y el imán (los bordes que se mueven se pegan a
    los de la pantalla, el techo de la barra y las otras ventanas). Se quitó el botón ✥
    (mover y cambiar el tamaño con las flechas y Mayús+flechas): al dueño le resultaba
    confuso. Las ventanas se mueven por su barra de título y cambian de tamaño desde las
    esquinas; con el teclado ya no se mueven (excepción a "todo con teclado" de UI-1,
    decidida por el dueño). Hecho en la rama `feat/window-resize` (§7, "Hecho: cambiar el
    tamaño desde las cuatro esquinas").
- **Inventario:**
  - el equipo va sobre una **figura** (como el paperdoll de Ultima Online): cabeza arriba,
    las manos a los costados, el torso al centro, piernas y botas abajo, munición y
    mochila al lado;
  - barra de capacidad;
  - cada contenedor abierto es **su propia ventana** (como hoy, una por contenedor), con
    una grilla de 4 o 5 columnas de `--ui-slot`.
  - **Cambio del dueño (2026-11-18): al estilo Diablo II.** "Por ahora el menú de items
    equipados lo hiciste como en tibia, pero creo que sería más cómodo estilo Diablo II".
    De Diablo II se toma solo la idea del panel (nunca su arte, sus nombres ni sus textos):
    - una grilla de 8x9 celdas cuadradas con cada slot en su lugar y de su tamaño: cabeza
      2x2 arriba al centro con el cuello 1x1 al lado; las manos 2x4 a los costados (la
      izquierda a la izquierda, como antes); el torso 2x3; el anillo 1x1 a la altura de la
      cadera; las piernas 2x2; la mochila y la munición (un carcaj con su cantidad) 2x2 a
      los lados de las piernas; los pies 2x2 abajo. La silueta propia de siempre detrás;
    - slots grandes: el ícono al mayor múltiplo entero que entra (2x en los de 2x2 o más
      desde que la ventana mide unos 286 px), y los slots vacíos con su silueta a esa
      escala;
    - mientras se arrastra o se elige (toque) un item, los slots que lo aceptan brillan y
      el que no lo acepta se tiñe de rojo bajo el puntero; el de la mochila no hace
      ninguna de las dos con lo que no se lleva en la espalda: lo guarda en la mochila o,
      sin ella, en los bolsillos (lote 13);
    - la grilla de la **mochila equipada abajo de la figura**, en la misma ventana (como la
      grilla del inventario de Diablo II), abierta sola al abrir el inventario; los
      contenedores de adentro y los del suelo siguen siendo ventanas propias;
    - la capacidad como una barra fina con su texto, abajo.

    Hecho en la rama `feat/equipment-d2` (§7, "Hecho: el equipo y el tooltip al estilo
    Diablo II").
- **Las ventanas que ya existen** pasan a `GameWindow` con el mismo marco: diálogo,
  tienda, crafteo, casa, intercambio, presencia, tutorial, reporte y muerte. Los
  `data-testid` y los `data-tutorial` se mantienen.
- **Texto de la acción por defecto** junto al cursor sobre el mapa ("Hablar con Tilde",
  "Atacar a lobo", "Trepar"), con `client.action.*` en i18n. Sale de las mismas reglas
  puras de hoy (`mapPress`, `useMode`).

### UI-6 Click derecho en items: menú y ficha
**Hecho (A4), con cambios:** ver "Hecho: A4, A5 y los botones del gremio" en §7. Sobre todo:
el click derecho sobre una criatura sigue atacando o hablando (el menú de la criatura es
Mayús+click derecho), y en el menú las acciones van arriba y la ficha debajo.
- **Opción de controles** (Opciones → Controles, `localStorage` `rpg.controls`):
  - `menu`: **por defecto** para jugadores nuevos, porque es lo que pidió el dueño;
  - `classic`: click derecho = usar, como hoy y como en Tibia.
- **En modo `menu`:**
  - el click derecho sobre un item (mapa, equipo, contenedor, tienda, intercambio,
    mercado) abre el menú del item, que extiende el `ui/ActionMenu.tsx` del toque largo
    (T5.6). Arriba va el ícono a 2x con el nombre, debajo **la ficha**, y después las
    acciones: Usar, Abrir, Equipar, Comer, Usar con…, Mirar, Mover parte (pendiente m1) y
    Cancelar. La acción por defecto va primera y en negrita;
  - el doble click izquierdo sobre un item = su acción por defecto (como en Ultima Online);
  - el click izquierdo sobre el mapa sigue siendo caminar;
  - el click derecho sobre una criatura abre su menú: Atacar, Seguir, Hablar, Mirar,
    Invitar al grupo, Comerciar, Reportar (las mismas reglas de hoy deciden qué aparece).
- **En modo `classic`:** todo como hoy. La ficha sale igual en el tooltip, y Mayús+click
  derecho abre el menú.
- **Tooltip** en los dos modos: después de 350 ms de mouse sobre un item del DOM sale la
  ficha. También con el foco del teclado. Se va al salir o con Escape.
  - **Cambio del dueño (2026-11-18): como en Diablo II.** "Al poner el mouse sobre un item
    muestra su descripción como en diablo, también sería bueno agregarlo". Desde la rama
    `feat/equipment-d2` sale **al instante**, centrado **arriba** del item (abajo si no hay
    lugar, nunca bajo el cursor), en una caja compacta casi negra con borde fino, cada línea
    centrada y sin ícono (el item está ahí abajo): el nombre claro, el de un item de misión
    en su color y el del dinero dorado; los stats en blanco ("Ataque: 13"); los efectos en
    azul; los requisitos que no se cumplen en rojo; la descripción apagada y al final. Igual
    en el equipo, la mochila, los contenedores, la tienda, el intercambio y lo que está en
    el suelo (arriba de su casilla). El menú del click derecho sigue con la ficha entera.
    Idea para después, solo si el dueño la pide: mantener Alt para ver los nombres de los
    items del suelo.
- **La ficha** (estilo Diablo 2, de 260–320 px de ancho, ubicada con `menuPlacement` para
  no salirse):
  1. Nombre en Cinzel: `--ui-text`, o `--ui-item-quest` si es de misión. Cantidad si es
     una pila.
  2. Tipo: "Arma — espada, una mano", "Comida", "Material".
  3. Stats en `tabular-nums`: ataque, defensa, armadura, alcance, peso.
  4. Requisitos (nivel, vocación) en `--ui-danger` si no se cumplen.
  5. Efectos (cura, condición, duración).
  6. La descripción del item (`ItemDef.desc`) en Alegreya itálica.
  7. Marcas: "No comerciable", "No se vende en el mercado".
- **Datos:** hoy el cliente no tiene los stats. El plugin de Vite (`vite/content.ts`) suma
  al `ItemDef` lo que la ficha muestra, sacado de `data/items`. "Mirar" sigue mandando
  `LookAt`: el texto del servidor es el que manda, porque puede tener datos vivos (dueño de
  una casa, cargas).

### UI-7 Gremios: ventana propia
**Hecho:** A3 hizo la ventana; los botones con ícono (Resumen, Miembros, Rangos, Invitar,
Guerras, Mensaje) y el "⋯" por miembro están en "Hecho: A4, A5 y los botones del gremio".
- Sale de la columna lateral. El botón **Gremio** (G) abre su ventana, con pestañas:
  - **Resumen:** nombre, mensaje del día, rango propio y la acción de salir;
  - **Miembros:** lista con punto de conectado, insignia de rango y un botón "⋯" por fila
    con las acciones que `memberActions` permite;
  - **Invitar:** campo con el nombre;
  - **Guerras:** lo de `warActions`;
  - **Administración:** solo con poderes.
- **Sin gremio,** la ventana muestra "Fundar" (costo y nivel de `content.guild`) y las
  invitaciones pendientes.
- **Una invitación nueva** sale además como aviso con Aceptar y Rechazar, y el botón
  Gremio muestra un punto.
- `ui/Guild.tsx` sigue sin hooks y `ui/Guild.test.ts` sigue recorriendo su árbol (las
  reglas de T5.1).

### UI-8 Diálogo de NPC y tienda sin scroll
**Hecho (A5), con cambios:** ver "Hecho: A4, A5 y los botones del gremio" en §7 (retrato a
2x; categorías deducidas por NPC). El texto letra por letra y el retrato que respira, en
"Hecho: lo que quedaba de A3, A4 y A5".
**Diálogo:**
- **Lugar y tamaño:** abajo al centro, sobre el HUD, de `min(760px, 70vw)` de ancho y
  hasta el 65 % del alto. Retrato del NPC a la izquierda (su sprite a 3x, animado si tiene
  frames); nombre y título arriba.
- **Texto** en Alegreya de 16 px. Aparece a 90 caracteres/s; un click o Espacio lo
  completa, y con movimiento reducido sale entero. Si no entra, se pagina con "▼ más":
  nunca scroll.
  - Guía de escritura (docs/06): como mucho 300 caracteres por nodo.
- **Opciones como grilla de botones:**
  - `grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr))`, botones de 36 px con
    el número (1–9) a la izquierda y el ícono de su categoría;
  - el texto ocupa hasta 2 líneas (el botón crece a 52 px). Si es más largo, "…" y el
    texto completo en el `title`: precios y nombres tienen que verse enteros, por eso no
    se corta en una línea;
  - **ordenadas por categoría:** Misiones, Comercio, Viajes, Servicios (bendiciones,
    curación, entrenamiento) y Conversación. Sin encabezados, que robarían filas: la
    categoría la dicen el ícono y un borde de color a la izquierda del botón;
  - abajo, siempre en su fila: "Volver" a la izquierda y "Adiós" a la derecha (0 y
    Escape).
- **Garantía:** 18 opciones entran sin scroll a 1280x720. Son 3 columnas por 6 filas
  (de 250 a 340 px según las líneas), más 3 líneas de texto, el título y la fila de
  Volver/Adiós: como mucho ≈ 460 px, dentro del 65 % de 720 (468 px).
  - Con más de 9 opciones aparece "Buscar tema…", que filtra los botones por su texto. Es
    del cliente y no manda nada.
  - Si aun así no entran, la ventana se ensancha hasta el 90 % y suma columnas.
- **Categorías (dato, no código):**
  - una función pura `optionCategory(opción)` las deduce del `dialog` de
    `data/npcs/*.yaml`. Corre en el build: el plugin de Vite (que hoy solo lee el sprite
    de cada NPC) arma un mapa de clave de texto de la opción → categoría, y el cliente la
    busca con el `LocalizedText` que llega:
    - acción de tienda → Comercio;
    - viaje en barco → Viajes;
    - condiciones o acciones de `quest_*` → Misiones;
    - bendición o curación → Servicios;
    - `dialog.back` → Volver;
    - `close` o `dialog.bye` → Adiós;
    - lo demás → Conversación;
  - un `tag:` opcional en la opción del YAML manda sobre la deducción (esquema y
    docs/06). Si una misma clave cae en dos categorías, el test del plugin falla y se
    resuelve con `tag:`. El protocolo no cambia (`DialogOption` sigue con `option_id` y
    texto).

**Tienda:**
- **Ventana propia** junto al diálogo, con pestañas Comprar y Vender. Filtros por categoría
  con ícono (Todo, Armas, Armaduras, Herramientas, Consumibles, Materiales, según el `kind`
  del item) y búsqueda instantánea por el nombre traducido.
- **Grilla de celdas** de 72 px: ícono a 2x y precio debajo. 24 celdas a 1280x720 (6 por
  4). Si no entran, las categorías parten la lista, y como último recurso se pagina
  ("‹ 1/2 ›"): nunca scroll.
- **Barra de compra** abajo, fija: la ficha corta del item elegido, cantidad con −, campo,
  + y "Máx." (las reglas puras de `shopCount`), el total, el dinero que se tiene (en rojo
  si no alcanza) y "Comprar" o "Vender". Enter confirma. Se va el par campo + botón de cada
  fila.
- **Vender** muestra solo lo que se lleva, con la cantidad y el precio de venta. Lo que el
  NPC no compra se ve en gris.

### UI-9 Animaciones de la interfaz

| Elemento | Animación | Duración y curva | Con movimiento reducido |
|---|---|---|---|
| Abrir ventana | escala 0.96 → 1 y opacidad 0 → 1 | 140 ms, `ease-out` | solo opacidad, 80 ms |
| Cerrar ventana | opacidad 1 → 0 | 100 ms, `ease-in` | instantáneo |
| Botón | hover: borde oro; apretado: baja 1 px con sombra interior | 80 ms | igual, sin desplazamiento |
| Orbes | el nivel baja o sube; un "fantasma" claro marca lo que se perdió y se va | 250 ms; el fantasma espera 200 ms y tarda 400 | sin fantasma |
| Superficie de los orbes | ola que se desplaza | bucle de 4 s | quieta |
| Vida < 25 % | el orbe late y una viñeta roja en el borde del mapa | 1,2 s de bucle | viñeta fija |
| Subida de nivel | destello dorado en la barra de XP y aviso grande en Grenze Gotisch | 600 ms | aviso sin destello |
| Avisos | entran desde arriba y se desvanecen | 160 ms y 300 ms | solo opacidad |
| Tooltip o ficha | aparece | espera 350 ms y entra en 80 ms | igual |
| Hotbar | barrido cónico del cooldown y destello al quedar lista | continuo y 150 ms | sin destello |
| Arrastrar item | el ícono sigue al cursor al 90 % y el destino brilla | — | igual |
| Números de daño (canvas) | sale grande (1.2 → 1 en 100 ms) y sube 20 px | 800 ms, `ease-out`; un golpe fuerte sale más grande | sin crecer |
| Golpe fuerte al jugador | sacudida de cámara de 2 px | 120 ms | **apagada**, y es opción aparte como en D2R |

### UI-10 Chat
**Hoy (A14):** flota sobre el mapa abajo a la izquierda, sobre la barra y a la derecha de la
placa del personaje, como en Ragnarok Online: translúcido (la piedra al 50 %) y casi opaco
con el mouse encima o mientras se escribe. Es una ventana más (se mueve, se pliega, cambia
de tamaño, con imán), pero nunca se cierra. El log sigue como segunda pestaña
("Registro"), ahora en la barra de título. Mientras el log no se ve, todos los mensajes del
servidor flotan sobre el mapa (no solo los importantes). Antes (A3) iba abajo del dock.
**Desde el lote 10** tiene pestañas por canal y opacidad configurable ("Hecho: lugares de
fábrica, pestañas del chat y sonidos que reintentan", §7): Todo, Local, Grupo, Gremio,
Global y Registro, con un punto de no leído; la elegida fija el canal del selector; la
opacidad va del 30 al 100 % en Opciones → Interfaz. No hay pestaña de Comercio (no hay
canal de comercio en el protocolo) y plegado sigue mostrando solo su barra.
- Flota sobre el mapa abajo a la izquierda con pestañas por canal (Local, Grupo, Gremio,
  Comercio, Sistema).
- Fondo `--ui-stone-950` al 70 %, opacidad configurable. Plegado, muestra 1 línea; se
  despliega con Enter o con un click. Los colores son los tokens `--ui-chat-*`.
- El log del sistema es una pestaña más. Los avisos importantes siguen saliendo sobre el
  mapa (`ui/notices.ts`).

### UI-11 Globos de diálogo sobre las cabezas (hecho, 2026-11-24, rama `feat/chat-bubbles`)
Pedido del dueño del 2026-11-23: lo que alguien dice en el canal local aparece también sobre
su cabeza, para que la conversación se sienta natural.
- **Qué lleva globo:** decir, gritar y susurrar (`MessageKind` `SAY`, `YELL`, `WHISPER`) y
  la línea de un NPC en su diálogo (`DialogOpen`, solo la ve quien habla con él). Nunca el
  global, el grupo, el gremio, los anuncios de staff ni los mensajes del sistema
  (`bubbleStyle` de `client/src/render/bubbles.ts`). El cliente solo arma globo para un
  `Message` que trae `pos`: el servidor la manda solo a quien ve al que habla (un
  invisible o alguien fuera de la ventana se oye por nombre, sin globo). El alcance de
  cada modo lo pone el servidor (`balance.yaml` `chat.ranges`): un susurro solo llega a
  quien está cerca. Los mensajes propios también tienen globo (el servidor se los devuelve
  con `pos`). No hay lista de ignorados todavía; cuando exista, la misma regla la respeta
  (ver docs/14).
- **Cómo se ve:** una caja oscura redondeada con una colita hacia la cabeza, justo sobre
  el nombre (sobre la barra de vida si el nombre está oculto a zoom 1), en la fuente del
  canvas (Pixelify Sans 11 px, UI-3) con líneas de 13 px. Decir: pergamino sobre marrón;
  gritar: naranja con borde de 2 px y dura 1,5 veces más; susurrar: azul gris, caja más
  transparente y dura 0,8 veces; NPC: verde pálido. La fuente es de píxel: un grito no se
  agranda (se vería borroso), se distingue por color, borde y duración.
- **Cuánto dura:** 2,5 s + 60 ms por carácter, entre 3,5 y 9 s (por el factor del modo);
  se desvanece en sus últimos 600 ms (`bubbleLife`, `bubbleAlpha`).
- **Ajuste de línea:** a 150 px por línea, sin cortar palabras salvo una más ancha que la
  línea; como mucho 4 líneas por mensaje, la última con "…" (`wrapBubble`).
- **Varios mensajes:** los de un mismo hablante se apilan (el más nuevo abajo, junto a la
  cabeza), como mucho 3 mensajes y 6 líneas; al llegar otro se va el más viejo
  (`SpeechBubbles`).
- **Varios hablantes juntos:** el propio jugador primero y después los más cercanos quedan
  sobre su cabeza; un globo que taparía a otro ya puesto sube justo encima de él (2 px de
  separación), las veces que haga falta, sin pasar del borde de arriba del canvas
  (`stackBubbles`).
- **Sigue a la criatura** con la misma interpolación que el nombre y la barra (se ancla al
  nombre en cada frame). Una criatura que el canvas no dibuja (otro piso, fuera de la
  vista) no muestra su globo mientras dura.
- **Texto del jugador:** un `Text` de Pixi sin `tagStyles`, así nada se interpreta como
  marcado; el largo ya lo limita el servidor (255).
- **Opción:** Opciones → Interfaz, "Globos de diálogo sobre las cabezas"
  (`data-testid="chat-bubbles"`, `localStorage` `rpg.chat-bubbles`, encendida por
  defecto). Apagada, no se arma ninguno y se borran los que había.
- **Código:** reglas puras en `render/bubbles.ts` (con tests); `render/bubble-layer.ts`
  dibuja una pila por hablante (con tests sin canvas: mide con una función inyectada, nunca
  con `Text.width`); `game-canvas.ts` pone la capa entre los nombres y los números
  flotantes y la ancla al nombre; `WorldState.takeSpeech` guarda lo dicho (hasta
  `SPEECH_QUEUE`, 16) hasta el frame siguiente. Hook E2E `__rpgClient.bubbles()`.

### Minimapa (hecho, 2026-11-23, rama `feat/minimap`)
Pedido del dueño: un minimapa como el de Tibia (la mecánica: explorar para verlo), con los
puntos cardinales y la estimación del objetivo seguido (reglas en docs/02 "Minimapa").
- **Dónde:** en escritorio, arriba a la derecha del mapa, bajo las ventanas; el inventario y
  los contenedores en su lugar de fábrica empiezan debajo (`--minimap-h` de `windows.css`,
  con `:has(.minimap)`). En tablets y teléfonos, arriba a la izquierda del mapa (arriba a la
  derecha va el tutorial), y empieza plegado en los teléfonos. Plegado y zoom se recuerdan
  por dispositivo (`localStorage` `rpg.minimap`).
- **Marco:** el hierro de las ventanas (`--ui-frame-shadow`) con N, E, S y O en Cinzel dorado
  en sus cuatro lados, y debajo tres botones (acercar, alejar, volver a centrar; 44 px en
  pantallas táctiles). El terreno es un canvas de 160x160 px pintado píxel por píxel
  (`image-rendering: pixelated`), una a cuatro casillas por píxel; lo no explorado, negro.
  Encima, un SVG: la marca propia (una flecha clara que gira con la dirección), los puntos
  azules del grupo, y la estimación en dorado (círculo punteado translúcido, o flecha en el
  borde con "~N" y ▲/▼).
- **Colores:** `make sprites` (tools/spritepack `averageColor`) guarda en `atlas.json`
  `minimap` el promedio de los píxeles opacos de cada sprite (con su alfa); el cliente
  colorea una casilla con el de su item (`GameCanvas.itemColor`). Antes de que cargue el
  atlas, o sin color, un tono por tipo (bloquea, agua, suelo).
- **Código:** `client/src/state/minimap.ts` (puro, con tests: estado, niebla, proyección,
  flecha del borde, marca de la pista, puntos cardinales), `client/src/ui/Minimap.tsx` y
  `minimap.css`. Test ids: `minimap`, `minimap-fold`, `minimap-canvas`, `minimap-self`,
  `minimap-hint` (`data-kind` `area` o `arrow`, `data-floor`), `minimap-distance`,
  `minimap-top|right|bottom|left`, `minimap-zoom-in`, `minimap-zoom-out`,
  `minimap-recenter`, y en el diario `quest-track`. Vista previa: la escena `game` de
  `make ui-preview` lo muestra con una quest seguida fuera del minimapa (la flecha).

## 6. Assets: de dónde salen y cómo se registran (SRC)

### SRC-1 Licencias (desde el 2026-11-17, por decisión del dueño)
- **Se aceptan:**
  - arte y sonido: CC0, CC-BY 3.0/4.0, OGA-BY 3.0 y **CC-BY-SA 3.0/4.0**;
  - fuentes: **SIL OFL 1.1**;
  - arte y música **generados con la cuenta de Gemini del dueño** (desde el 2026-11-17,
    por decisión del dueño), con las reglas de SRC-5.
- **Se rechazan:** solo GPL (o GPL como única licencia del archivo), "no comercial" (NC),
  "sin derivados" (ND), "uso personal", licencias de tienda que no dejan redistribuir (el
  repo es público), lo que no tiene licencia clara y todo lo que sale de otros juegos.
- **Archivo con varias licencias:** se elige una aceptada y se anota cuál.
- **Obligaciones:**
  - **Atribución** (CC-BY, CC-BY-SA, OGA-BY): autor, título, licencia y enlace. Van en
    `assets/CREDITS.md` y en la página `/credits` del sitio, que se arma con ese archivo
    y con el `CREDITS.csv` de cada pack (A1, versión mínima: ver "Hecho: A1").
  - **CC-BY-SA:** lo que se derive de un archivo BY-SA (recoloreado, recortado o
    combinado) queda BY-SA y se dice en su fila de créditos. No contagia al código ni al
    arte propio CC0: una página del atlas que junta sprites es una colección, y cada
    sprite conserva su licencia.
  - **Medidas técnicas (DRM):** CC-BY y CC-BY-SA no dejan imponer restricciones técnicas
    al material. La web y la app de escritorio no tienen. Antes de publicar en tiendas
    móviles (docs/15), revisar esto; OGA-BY sí lo permite.

### SRC-2 Liberated Pixel Cup: repositorios y reglas
| Repositorio | Qué tiene | Licencias |
|---|---|---|
| `https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator` (organización oficial) | `spritesheets/`: cuerpos, ropa, pelo, armas y herramientas en frames de 64x64 (algunas armas en 128 o 192) | **Por archivo, en `CREDITS.csv`**: CC0, CC-BY-SA, CC-BY, OGA-BY y GPL. El código del repo es GPL-3.0: **no se copia código**, solo arte |
| `https://github.com/ElizaWy/LPC` (LPC Revised; el README del generador dice que "revised and expanded the LPC paradigm" y enlaza su guía de animación) | `Characters/`, `Terrain/`, `Structure/`, `Objects/`, `FX/`; 3/4 de 32 px y paleta de ~170 colores | Su README: "All of our assets are licensed under the Creative Commons Attribution 3.0 (CC-BY-3.0) or OGA-by 3.0 License". Autores en `Credits.txt` por carpeta |
| `https://github.com/LiberatedPixelCup/RPG_Maker_MZ_LPC_Starter_Kit` | Kit para RPG Maker MZ y Tiled | El repo no muestra licencia y pide respetar la de cada archivo: solo lo que tenga la licencia escrita al lado |
| `https://github.com/LiberatedPixelCup/LPC-list` | Lista de juegos que usan LPC | Texto CC0. No trae assets |

Las páginas de OpenGameArt de la colección LPC valen con las mismas reglas: la licencia se
lee en la página de cada entrada y por archivo.

### SRC-3 Cómo se integra un pack (pasos)
1. **Fijar el commit** de origen y anotarlo (URL con SHA).
2. **Elegir los archivos y buscar su licencia** uno por uno: fila de `CREDITS.csv`
   (generador) o `Credits.txt` (Revised). Se descarta el que solo tiene GPL o no tiene
   fila.
3. **Copiar sin modificar** a `assets/vendor/<pack>/` con las rutas de arriba, por
   ejemplo `assets/vendor/lpc-revised/Terrain/…` o `assets/vendor/ulpc/spritesheets/…`.
   La carpeta va en minúsculas y sin espacios; adentro se respetan los nombres del pack.
4. **Agregar los textos de licencia** en un archivo que empiece por `LICENSE` (spritepack
   y `make validate` lo exigen: `LICENSE.txt` con el texto de cada licencia que aparece) y
   el **subconjunto de créditos** de lo copiado (`CREDITS.csv` con solo esas filas, o los
   `Credits.txt`).
5. **Fila en `assets/CREDITS.md`:**
   - Autor: "varios, ver `CREDITS.csv` de la carpeta";
   - Licencia: "por archivo: CC-BY-SA 3.0, OGA-BY 3.0…";
   - Fuente: URL con commit;
   - Carpeta y "Atribución requerida: Sí".
6. **Derivados** (capas de LPC compuestas en un atuendo, recoloreados):
   - los genera `tools/spritepack` desde `vendor/` con la receta de `animations` en
     `assets/sprites.yaml` (capas y paletas), con tests del compositor. No se commitean como
     PNG: salen en el atlas generado (decisión del 2026-11-17, en vez de
     `assets/sprites/derived/<pack>/`: la receta es el dato y el atlas no se commitea);
   - tienen una fila en la sección "Obras derivadas" de `CREDITS.md` que dice su licencia
     (la del origen; BY-SA sigue BY-SA) y de qué archivos salen;
   - no van como "Obra propia CC0".
7. **Fuentes:**
   - `assets/vendor/font-<familia>/` con los `.ttf` de google/fonts tal cual, su `OFL.txt`
     y una copia como `LICENSE.txt`;
   - fila en `CREDITS.md` con el copyright de la primera línea del `OFL.txt`, licencia
     "OFL 1.1" y la fuente
     `https://github.com/google/fonts/tree/main/ofl/<familia>` con commit;
   - los woff2 recortados se generan en el build, no se commitean.
8. `make sprites STRICT=1`, `make validate`, revisión con Read a 1x y a 4x, y un
   screenshot del E2E en el PR.

### SRC-4 Qué reemplazar primero
Por impacto en pantalla y por costo:

| # | Hoy | Qué va | De dónde | Necesita |
|---|---|---|---|---|
| 1 | Muros `stone_wall` (`brick_gray0`), `rock_wall` (`lab-rock0`), `wooden_wall` (propio) | Juegos de piezas con altura (ART-3) | `Structure/` de LPC Revised, o recetas nuevas de spritegen | **Hecho** con spritegen (2026-11-18), también las vetas y las dos puertas |
| 2 | `ground/grass` (`grass0`), `dirt`, `sand`, `stone_floor` (`cobble_blood1`: revisar que no muestre sangre en el templo) | 4 variantes, textura de baja frecuencia y bordes | `Terrain/` de LPC Revised o spritegen | **Hecho** con spritegen, más `wet_sand`; los bordes de todos los suelos naturales, con 4 looks por pieza (lote 13, ART-4) |
| 3 | `water_shallow`, `water_shoal` (quietas) | Agua animada y espuma de orilla | LPC Revised o spritegen | **Hecho** con spritegen |
| 4 | Atuendos `citizen`, `noble`, `ranger`, `sailor` (3 frames, figura de ~10x25) | Humanoides de 64x64 con caminar, atacar, conjurar y morir | Capas de ULPC (solo archivos con licencia aceptada) | **Hecho** (quieto, caminar, atacar, disparar, conjurar y caer; disparar y conjurar desde `feat/lpc-actions`, ver "Hecho: disparar, conjurar, desvanecerse, pasos y girar") |
| 5 | NPCs (Dungeon Crawl, quietos) | Humanoides con el mismo pipeline, más idle | ULPC | **Hecho** (17 NPCs con quieto y caminar; el eco de la forja, desde el 2026-11-18, del motor de sprites: quieto y caminar en cuatro direcciones, flotando) |
| 6 | Monstruos más vistos: `wolf`, `bilge_rat`, `tide_crab`, `gloom_bat`, `moss_spider`, `mire_toad` | 4 direcciones con caminar y atacar | Hojas LPC de criaturas (licencia por archivo) o spritegen. Mientras tanto, todos con ANI-5 | **Parcial:** ANI-5 para todos; los cuatro humanoides (`wreck_looter`, `coffer_smuggler`, `obsidian_delver`, `drowned_miner`) son de ULPC con todo; jabalí y ciervo, trote de spritegen (desde el 2026-11-18, del motor de sprites con quieto, caminar, atacar y morir en cuatro direcciones). Ningún repo oficial de LPC en GitHub trae animales con licencia verificable (el lobo del Starter Kit no la tiene al lado). **Desde el 2026-11-18**, `wolf`, `bilge_rat`, `tide_crab`, `gloom_bat`, `moss_spider`, `mire_toad` y `thornling` son hojas de Gemini (SRC-5) con caminar, quieto, atacar y morir en 3 direcciones más el espejo ("Hecho: criaturas de Gemini"), y en la segunda tanda `hollow_crawler`, `ore_beetle` y los cinco del Volcán: solo la gaviota sigue con un frame (de spritegen) |
| 7 | Árboles (`mangrove1`, `mangrove3`, `tree2_yellow`) y arbustos | Árboles de 64x96 o 96x96 con sombra en capa y viento | LPC Revised o spritegen | **Hecho** con spritegen: copas 3/4 centradas, sombra y viento |
| 8 | Fragua (`makhleb_flame1`) y fogón (`return_vestibule`) | Estaciones que se entiendan, animadas | spritegen | **Hecho** |
| 9 | UI | Marcos, íconos de la botonera y orbes propios | spritegen y CSS | A2, A3 |

**Por qué spritegen y no LPC para el mundo (2026-11-18):** las recetas propias dan las 16
piezas de muro, los looks de suelo y los frames que pide el renderer con la paleta de
`palette.ts`, sin recortar ni recomponer hojas de terceros y sin sumar filas a
`CREDITS.md` ni atribución visible. Si más adelante se quiere LPC para algún suelo, entra por
la misma convención de nombres (`var_`, `frame_`, `wall_`, `shadow`) como entradas de
`sprites.yaml`.

Se quedan:
- los íconos de items de Dungeon Crawl que no son equipo (comida, materiales, pociones,
  items de quest, algunas herramientas). Los del equipo los reemplazó el motor de sprites
  por pedido del dueño (2026-11-18, lote 11: un sprite propio por pieza; "Íconos de
  items", en §3);
- los efectos propios (`effects/*`);
- las marcas PvP.

### SRC-5 Arte y música generados con IA (desde el 2026-11-17)
El dueño permite, desde el 2026-11-17, arte y música hechos con **su** cuenta de Gemini (la
app web; las herramientas, en `tools/gemini`, se manejan como en Ants of Neque, su otro
juego). Las reglas:
- **El prompt describe nuestro contenido** (qué es, qué ánimo tiene, qué instrumentos o
  materiales) y **nunca nombra otro juego, artista, compositor ni obra**, ni pide "al estilo
  de", "inspirado en" o "que suene como". La regla legal de arriba vale igual: de Tibia y
  de los demás se aprende el estilo con palabras propias, nunca se pide copiarlos.
  `tools/gemini/prompt_guard.py` frena los prompts que nombran o piden imitar.
- **Las referencias también son nuestras:** lo que se sube con el pedido (`--ref`, y con
  `--edit` se pide algo parecido a eso) es solo un archivo commiteado en `assets/`, ya
  acreditado. Nunca un sprite, una captura ni un audio de terceros u otro juego, aunque el
  prompt sea limpio. Los drivers rechazan otra ruta, y el registro nombra cada referencia
  con su sha256.
- **Registro:** cada archivo que se usa va en la sección "Generado con IA" de
  `assets/CREDITS.md` con la herramienta (Gemini, app web, y el modo), la fecha, las
  referencias y un **archivo de prompt commiteado** (`assets/prompts/<ruta>.txt`, el prompt
  exacto). Lo arma `tools/gemini/credit.py`. La dirección de la conversación de Gemini no se
  commitea: es el chat privado del dueño y queda en el sidecar de `build/`.
- **Se acredita a Gemini como herramienta**, nunca como obra hecha a mano. Google no reclama
  la propiedad de lo generado; su política pide no ocultar el origen.
- **Pasa por nuestras reglas antes de entrar:** el arte, por `tools/gemini/import_art.py`
  (fondo fuera, grilla en frames, escala por vecino más cercano a 32 o 64, paleta de
  spritegen dentro de la banda de ART-6 de su capa, contorno oscuro de ART-5 donde ART-5 lo
  pide, es decir no en suelos ni efectos, y alfa 0 o 255); la música, por
  `tools/gemini/music_convert.py` (desde el 2026-11-18 el tema entero, sin cortes, a
  -14 LUFS, Ogg Opus estéreo, con sus puntos de entrada medidos para el director de música).
  Nada se commitea sin mirarlo o escucharlo.
- **Un solo volumen para toda la música: -14 LUFS** (integrado, pico real ≤ -1,5 dBTP). Es
  el nivel de los temas que ya tiene el juego (soundgen: de -11,3 a -15,8, unos -14 en
  promedio), así un tema de Gemini no suena más bajo que los otros. Un tema nuevo, venga de
  donde venga, se lleva ahí; `make test-gemini` mide los de `assets/sounds/music/`. Los
  masters de Gemini traen picos de +1,5 a +5 dBTP; los loops mono del lote 7 quedaban
  entre -16 y -19,5 LUFS por el techo de pico, los temas enteros en estéreo del 2026-11-18
  llegan a -14 casi todos (el peor, -15). Donde no llega, `make music-gemini` compensa con
  el volumen de `sounds.yaml`, hasta 1.
- **Lo que sigue igual:** un pack de terceros sigue SRC-1 a SRC-3, y lo generado no reemplaza
  a spritegen donde una receta alcanza: Gemini sirve para lo que el código dibuja mal
  (criaturas con anatomía, retratos, música con instrumentos).

Cómo se usa, paso a paso: `assets/README.md`, "Arte y música hechos con Gemini", y
`tools/CLAUDE.md`, "gemini".

### SND-1 Dirección de sonido: el ambiente bajo la música (2026-11-23, lote 18)
El dueño: "la música está muy buena, pero en el pueblo se escucha el mar aunque el mar no
está tan cerca". Quiere la música de fondo y, debajo, detalles distintos según dónde está
parado: olas cerca del mar, viento en el desierto, árboles con viento en el bosque, agua
suave cerca de una fuente, crepitar cerca de una fogata. Reglas que salen de ahí:
- **El ambiente es del lugar, no de la isla.** Nada se oye si no está cerca: el mar a unas
  10 casillas del agua, una fuente a 7, una antorcha a 3. Lo que está de un lado suena de
  ese lado (paneo suave, nunca un solo oído).
- **Nunca un corte.** Una capa entra y sale en 2,5 s; si vuelve mientras se apaga, sube la
  misma (no se reinicia). Cada loop arranca en un punto distinto, así dos no coinciden
  siempre en el mismo segundo (lo mismo que el dueño pidió para la música).
- **La música manda.** El ambiente va en su canal (`ambient`, con su volumen y silencio),
  bajo la música; las capas de zona se mezclan bajas (0,15–0,6) y un detalle (antorcha,
  farol) apenas se nota. Un pueblo suena a gente lejos, sin palabras.
- **Loops naturales.** Ruido con forma (olas que suben y rompen, ráfagas, hojas que
  tiemblan, chasquidos del fuego, gotas con eco), sin melodía: si algo suena a música,
  compite con la música. Sin costura audible: la vuelta del loop se funde.
- **Liviano.** Pocas voces (6; 3 en un teléfono o con animaciones reducidas).
- **Origen:** se puede pedir a Gemini (SRC-5); si lo que vuelve es musical o no sirve, una
  receta propia de `tools/soundgen`. Los de hoy son de soundgen (Gemini no estaba abierto).
Cómo funciona y cómo agregar un sonido: `livingworld/README.md`, "Ambiente".

## 7. Plan de implementación propuesto
Cada tarea es un PR con sus tests y screenshots (CLAUDE.md, "Definición de terminado").
Las que tocan `server/` o `proto/` pasan por `code-reviewer`.

| Id | Tarea | Toca | Depende de |
|---|---|---|---|
| A1 ✅ | Página de créditos (sitio `/credits` desde `assets/CREDITS.md`) y enlace en Opciones. Hecho: la página, el enlace del pie del sitio y el de Opciones ("Hecho: A1") y los créditos dentro de la app de escritorio ("Hecho: el resto de A1, A10, A11 y A13") | cliente, sitio | — |
| A2 ✅ | Fuentes OFL auto-alojadas, tokens de UI-2 y marco de hierro (sin cambiar el layout) | cliente, `assets/vendor/font-*` | — |
| A3 ✅ | HUD con orbes, botonera, `GameWindow`; inventario, habilidades, grupo, gremio (UI-7), apariencia, opciones y mercado como ventanas; sin encabezado ni columna fija; chat flotante. Lo que quedó (cada contenedor y las ventanas del servidor como `GameWindow`, mover y cambiar el tamaño con el teclado y el mouse, escala y tamaño de texto, slots vacíos, sacudida y destello) en "Hecho: lo que quedaba de A3, A4 y A5" | cliente | A2 |
| A4 ✅ | Menú del click derecho, ficha, tooltip y opción de controles (UI-6); stats en `ItemDef` | cliente | A3 |
| A5 ✅ | Diálogo y tienda sin scroll (UI-8); `tag` opcional en el YAML de diálogos | cliente, esquema, docs/06 | A3 |
| A6 ✅ | Movimiento: MOV-1 a MOV-6, con latencia simulada para el E2E. Hecho: MOV-1 a MOV-7 y el E2E de MOV-9 con latencia (§4, "Hecho: A6, primera parte" y "segunda parte"; el toque corto que solo gira y el polvo y las ondas al pisar, "Hecho: disparar, conjurar, desvanecerse, pasos y girar") | cliente, servidor, proto, docs/02, 05 y 07 | — |
| A7 ✅ | Vista de hasta 31x21: el cliente pide su vista, el servidor ajusta el AOI, escala 1,5x opcional, medición de ancho de banda. Hecho, con una ventana para todos en vez de una por cliente ("Hecho: A7"). Falta: la escala 1,5x y `make bots` contra un servidor real | servidor, proto, cliente, docs/01, 05 y 07 | A3 |
| A8 ✅ | Animación procedural de criaturas (ANI-5) — **hecho** (2026-11-17) | cliente | — |
| A9 ✅ | Evento de ataque y motivo de desaparición (ANI-7); animaciones de ataque y muerte — **hecho** (2026-11-18; E2E del lote 7, capturas `07b-attack-pose` y `11b-death` revisadas). Después: disparo y conjuro de LPC, desvanecerse y la muerte con reaparición a la vista ("Hecho: disparar, conjurar, desvanecerse, pasos y girar") | servidor, proto, cliente | A8 |
| A10 ✅ | Renderer y atlas: anclas por sprite, frames por acción, tiles animados, variantes de suelo, sombra de contacto y capa de sombras, `elevation` — **hecho** (2026-11-18), con `elevation` (ART-8) y el click sobre la cabeza (ART-2) | renderer, spritepack, cliente, editor | — |
| A11 ✅ | Muros por piezas con autotile y silueta del jugador detrás de un muro (ART-3) — **hecho** (2026-11-18), con la muralla de 32x96, los muros con ventana y el marco de las puertas de casa (que todavía no se ponen en los mapas: la muralla y las ventanas esperan una tarea de mapa) | renderer, spritegen o LPC, `data/items` | A10 |
| A12 | Integración LPC: humanoides (jugador, NPCs, cosméticos), suelos, agua y árboles — **hecho:** humanoides de LPC; suelos, agua y árboles con spritegen (SRC-4) | assets, herramienta de composición, `CREDITS.md` | A10 y la política de §6 |
| A13 ✅ | Luz en cuevas y partículas de ambiente — **hecho** (2026-11-18): la luz y las partículas de brasas, polen, rocío y polvo; los efectos al pisar después ("Hecho: disparar, conjurar, desvanecerse, pasos y girar"); falta la niebla (ART-7) | cliente | A10 |
| A14 ✅ | Pantalla completa (pedido del dueño del 2026-11-18): el mapa en toda la pantalla, la barra gótica de abajo con los orbes, la experiencia, la hotbar y la botonera, y todas las ventanas flotantes con imán ("Hecho: A14") | cliente | A3, A7 |

### Hecho: disparar, conjurar, desvanecerse, pasos y girar (2026-11-18, rama `feat/lpc-actions`)
Lo que quedaba de ANI (A9) y de MOV (A6). Solo cliente y herramientas: el servidor y el
protocolo no cambian.
- **Disparar y conjurar (ANI-2, ANI-7).** Las 23 capas de LPC suman sus hojas `shoot` y
  `spellcast` (46 archivos del mismo commit fijado del Universal LPC, con sus filas de
  `CREDITS.csv` copiadas tal cual: todas listan OGA-BY 3.0 o CC-BY-SA 3.0; se bajaron del
  repo oficial y se compararon byte a byte). El preset `lpc` de spritepack suma `shoot`
  (las 13 columnas de la hoja, una sí y una no con la clave nueva `step: 2`: 7 x 50 ms,
  350 ms) y `cast` (7 x 60 ms, 420 ms). Los atuendos tienen todas las acciones; los
  monstruos humanoides solo las de sus ataques en `data/monsters`: `wreck_looter`,
  `coffer_smuggler` y `obsidian_delver` (tiran botellas, cuchillos o esquirlas de
  obsidiana: `distance`) disparan, `drowned_miner` (un hechizo de muerte) conjura. El
  cliente elige el clip por `CreatureAttack.kind` (`render/creature-events.ts`
  `attackAction`; `packages/renderer/src/anim.ts` `attackClip`): sin ese clip juega
  `attack`, y sin ninguno la embestida. Con un servidor viejo (sin `attack_events`) todo sigue siendo `attack`: no
  hay cómo distinguir un arco de un hechizo por el `Projectile`. Hojas sin arco: el
  `shoot` de LPC es el gesto de tensar y soltar, sin el arma (no hay capas de armas). Se ve
  como un tiro o un lanzamiento, que es lo que hacen esos monstruos.
- **Desvanecerse (ANI-7).** `TELEPORT` y `LOGOUT` dejan el cuerpo donde estaba 350 ms
  (`VANISH_MS`): se angosta (pierde el 70 % del ancho), se estira un 20 % hacia arriba, toma un tinte celeste
  (`SHIMMER_TINT`, multiplicado), parpadea cada 50 ms y se desvanece. Nunca la caída. Vale
  para la invisibilidad y las escaleras, que el servidor manda como `TELEPORT`.
- **Una muerte con reaparición a la vista.** El servidor manda `CreatureDisappear{DEATH}` y
  `CreatureAppear` del mismo id en el mismo batch. El canvas ya no pregunta "¿por qué se
  fue?" a las criaturas que dejó de ver: juega cada salida que llegó desde el frame
  anterior una vez (`DepartureFeed`), sobre el cuerpo dibujado entonces, aunque la
  criatura ya esté de vuelta. `WorldState` ya no borra la salida cuando vuelve: la marca
  (`back`), y `departureOf` la ignora. El cuerpo cae donde murió y el jugador aparece con
  su fundido de 300 ms en el templo.
- **Cuerpos tapados.** Un cuerpo que cae o se desvanece detrás de una criatura más alta (el
  lobo muerto justo al norte del mago) también tiene la copia translúcida de ART-2
  (`DrawnBoxes.covered`).
- **Polvo y ondas al pisar (MOV-7, ART-7).** Dato: la clave `steps` de un suelo en la
  sección `tiles` de `assets/sprites.yaml` (`dust` o `ripple`), que spritepack lleva a
  `atlas.json`. Hoy: polvo en arena, tierra, ceniza y senda de escoria; ondas en la arena
  mojada (el agua baja no se camina). Cuando una criatura empieza un paso, la casilla que
  deja patea lo suyo a la altura de los pies (`ParticleLayer.kick`): 6 motas de polvo que
  suben un poco y se asientan (220–340 ms) o un anillo de 8 gotas que se abre achatado
  (380–460 ms). Usa el pool de A13: las partículas de ambiente dejan 16 de las 100 libres
  para los pasos (`STEP_RESERVE`). Los voladores no patean nada; con movimiento reducido,
  nada.
- **El toque corto que solo gira (MOV-2).** Quieto, una tecla o el pad hacia un lado al que
  no se mira gira al personaje en el acto (`Turn`) y camina solo si sigue apretado 80 ms
  (`TURN_TAP_MS`, `input/keyboard.ts` `TurnTap`). Mirando ya hacia ese lado, o caminando,
  camina enseguida, como antes. Un segundo toque que llega antes de esos 80 ms (soltar y
  volver a apretar entre dos cuadros) es un paso, no la misma tecla mantenida: antes se
  perdía (lo encontró el E2E del lote 8, que da los dos toques en ~10 ms). Ctrl+flecha siempre solo gira (con WASD no: Ctrl+W cierra
  la pestaña). Un botón del pad activado con el teclado sigue siendo un paso. El E2E da un
  paso como lo daría un jugador: un toque para girar si hace falta y otro para caminar
  (`client/e2e/keys.ts`), y comprueba que el toque que gira no mueve.
- **`11b-death` reencuadrada.** La captura espera los últimos 300 ms de la caída (el efecto
  del golpe que mató termina) y recorta 9x7 casillas alrededor del cuerpo, que
  `__rpgClient.poses()` ahora ubica.

### Hecho: A1, versión mínima (2026-11-18, lote 6)
La revisión final del lote 6 lo marcó como importante: es el primer lote que entrega arte
que pide atribución (los personajes de LPC, OGA-BY 3.0 y CC-BY-SA 3.0) y fuentes OFL.
- **Página `/credits` del sitio** (`client/src/site/Credits.tsx`, sin hooks). Los datos los
  arma `client/vite/credits.ts` al construir, como parte de `virtual:rpg-site`. Salen de
  `assets/CREDITS.md` (tabla de packs, "Fuentes" y "Obras derivadas de terceros") y del
  `CREDITS.csv` de cada pack con licencia por archivo. Usa los mismos lectores que
  spritepack (`parseCreditsRows`, `markdownTableRows`, `usedLicense`).
- **Qué muestra:**
  - cada pack, con su licencia enlazada a su texto y su fuente;
  - los archivos de LPC agrupados por autores, con la licencia bajo la que se usan y sus
    enlaces;
  - los sprites compuestos, por licencia;
  - las fuentes, con su copyright;
  - una línea sobre la obra propia CC0.
- **Textos:** todo es i18n (`site.credits.*`). El nombre y el autor de cada pack van por
  su carpeta (`site.credits.pack.<pack>.*`, guiones como `_`); un test exige esas claves para cada pack de
  la tabla y un enlace para cada licencia nombrada. Solo se enlazan direcciones http(s)
  (`site/credits.ts` `safeLink`).
- **Enlaces:** desde el pie de cada página del sitio y desde Opciones en el juego, en la
  ventana de escritorio y en el panel del login y del menú ☰ (`ui/CreditsLink.tsx`). En la
  app de escritorio se muestra la dirección como texto, como la tienda.
- **Fuentes:** los woff2 servidos conservan el copyright (name id 0) y la descripción y la
  URL de la licencia (13 y 14), como pide la OFL (`KEPT_NAME_IDS` de
  `client/vite/fonts.ts`, con test).
- **Después** (2026-11-18): los créditos dentro de la app de escritorio, ver "Hecho: el
  resto de A1, A10, A11 y A13". Las apps móviles (docs/15) usan el mismo botón, sin probar.

### Hecho: el resto de A1, A10, A11 y A13 (2026-11-18, rama `feat/world-art-2`)
- **Click sobre la cabeza (ART-2).** `client/src/render/creature-hits.ts` guarda cada
  frame la caja de cada criatura dibujada: la columna de su casilla, del borde de abajo
  hasta lo más alto del dibujo (`lift`), en su posición interpolada y elevada. El click
  derecho, Mayús+click, el toque y el toque largo prueban primero esas cajas, de la
  dibujada última a la primera (la de adelante gana), y después la casilla. El propio
  jugador no entra: un click en la propia cabeza elige lo que está detrás. Caminar sigue
  yendo a la casilla. Una casilla con algo propio que usar (una puerta, un item, una
  escalera de mano: `Game.ownUse`) se queda con su click: ninguna cabeza que suba desde
  la casilla de abajo lo toma, y el click hace lo que dice el texto junto al cursor (antes,
  con otro jugador parado al sur de una puerta, el click derecho en la puerta lo atacaba).
- **Criaturas tapadas por otra más alta (`07-combat`).** El jugador de LPC mide ~1,4
  casillas y tapaba al lobo de la casilla de arriba. El orden de dibujo se queda (el de
  adelante tapa al de atrás, como pide ART-3); lo que se suma es la silueta: si una
  criatura dibujada después cubre una cuarta parte o más de la caja de otra
  (`HIDDEN_SHARE`), la de atrás se dibuja otra vez encima del mapa, aclarada y al 55 %
  (`HIDDEN_ALPHA`, `HIDDEN_TINT` en `game-canvas.ts`), como el jugador detrás de un muro.
  Vale para todas las criaturas, también para un NPC tapado por otro en el pueblo. Detrás
  de un muro, en cambio, los demás siguen ocultos.
- **Elevación (ART-8):** ver ART-8.
- **Muralla y ventanas (ART-3).** `tools/spritegen/src/recipes/walls.ts`: `drawPiece` toma
  la altura de la cara (`TALL_FACE` = 64 para la muralla) y un dibujo extra por pieza (la
  ventana). La muralla usa la piedra del muro liso y se une con él (todo muro cuenta como
  vecino). La ventana va solo en las piezas cuya cara cruza la casilla entera (un tramo
  este-oeste); en un tramo norte-sur no se ve la cara, así que tampoco la ventana.
  Bloquean el paso y la vista como cualquier muro.
- **Marco de las puertas de casa (ART-3), sin cambiar mapas.** `houses.yaml` `doors` sigue
  siendo un hueco en el muro que el servidor conoce por su casilla; poner un item ahí
  cambiaría qué usa el click derecho en la puerta. En vez de eso, el cliente, el editor y
  `mapcli render` dibujan el item `house_door_frame` en cada puerta, abajo de la pila
  (`DecoratedSource` de `packages/renderer/src/decorated.ts`, que envuelve la fuente de
  casillas de `MapView`). El marco tiene 16 piezas como un muro: los muros de los lados lo
  cuentan como vecino y corren hasta la puerta; en un muro este-oeste es una viga a la
  altura de las tapas y dos postes, en uno norte-sur la viga va a lo largo. El estado del
  juego (clicks, mirar, caminar) nunca lo ve.
- **Partículas (ART-7, A13).** `client/src/render/particles.ts`: hasta 100 partículas
  (`MAX_PARTICLES`) en arreglos tipados, dibujadas por un pool fijo de sprites de 1 px en
  el espacio del mapa (bajo las siluetas, sobre las criaturas). De dónde salen es dato: la
  clave `particles` de la sección `tiles` de `assets/sprites.yaml` (`embers`, `pollen`,
  `spray`, `dust`), que spritepack pasa a `atlas.json` y `MapView` junta por chunk
  (`forEachEmitter`). Hoy: brasas en la lava, la fragua, el fogón y el brasero; polen en
  roble, olmo, abedul y pino; rocío en el agua de mar donde toca otro suelo (un suelo
  `spray` solo emite en sus bordes); y en las cuevas (z ≥ 8) polvo en toda la vista.
  Cada tipo tiene su ritmo, vida, velocidad, vaivén y tres colores por edad (`STYLES`).
  Solo emiten las casillas en vista; un frame no asigna nada (generador con semilla, el
  callback se hace una vez, una partícula muerta deja su lugar a la última). Con
  "Animaciones reducidas" o `prefers-reduced-motion` no hay partículas.
- **Créditos en la app de escritorio (A1).** En la app (Tauri), Opciones muestra el botón
  "Créditos del arte y las fuentes", que abre la página de créditos en una ventana sobre
  el juego (`ui/CreditsLink.tsx`, `CreditsWindow` sin hooks y con test). Los datos vienen
  de un módulo aparte, `virtual:rpg-credits`, que se importa recién al abrirla; las frases
  `site.credits.*` viajan en los catálogos del juego. Las direcciones van como texto
  (`CreditsPage` con `plain`): un enlace abriría el sitio dentro de la app. Abajo sigue la
  dirección de `/credits` para el navegador. En el navegador no cambia: el enlace a
  `/credits`.
- **Opciones del login:** la casilla "Pad direccional en pantalla" quedaba sola en una
  línea sobre su texto (la regla global de `label` apila en columna); ahora va al lado,
  como los "Silenciar".

### Hecho: A2 y A3 (2026-11-17, rama `feat/ui-theme`)
Lo que se hizo, con las decisiones que cambian o dejan para después partes de UI-2 a UI-10
(el detalle técnico está en `client/CLAUDE.md`, "Notas de la UI oscura"):
- **Fuentes (UI-3):** Cinzel, Grenze Gotisch, Alegreya Sans y Alegreya, de google/fonts con
  commit fijo, en `assets/vendor/font-*/` con su `OFL.txt` y fila en `CREDITS.md`. El
  plugin `client/vite/fonts.ts` las recorta a latín y las sirve como woff2 en `/fonts/`.
  Pixelify Sans (canvas) llegó después: "Hecho: proyectiles, restos por familia y la
  fuente del canvas".
- **Tokens y marco (UI-2):** los de la tabla, con los nombres viejos como alias. El marco
  de hierro es CSS (sin el PNG 9-slice de spritegen), la piedra es una veta SVG en línea.
  Los íconos de la botonera son pixel art propio de 16x16 escrito como texto en
  `client/src/ui/icons.tsx` (no en el atlas: así se ven antes de que cargue).
- **Layout (UI-4), cambio:** sin encabezado ni columna fija. A la derecha del mapa, el
  **dock**: orbes de vida y maná con nombre, nivel y experiencia en el medio, la botonera,
  las ventanas acopladas y el chat. No hay HUD abajo: el mapa usa todo el alto y toma la
  escala entera más grande (2x a 1280x720, 3x a 1920x1080). La hotbar sigue sobre el borde
  de abajo del mapa, como una correa. Ocultar el dock no se hizo: con 15x11 casillas solo
  ganaría donde el ancho limita, y A7 (31x21) lo va a cambiar todo.
- **Botonera y ventanas (UI-5):** como se pidió, salvo:
  - el mercado no se abre desde la botonera (se abre con un tablero): su botón está
    deshabilitado con la pista "usa un tablero" y, abierto, lo cierra;
  - "Salir del juego" es un botón más de la botonera, no de Opciones;
  - el modo de combate (postura, perseguir, modo seguro) va arriba de la ventana Batalla;
  - los contenedores siguen dentro de la ventana Inventario, no como ventanas propias
    (después: ventanas propias, "Hecho: lo que quedaba de A3, A4 y A5");
  - las ventanas del servidor (diálogo, tienda, crafteo, mercado, casa, intercambio)
    tienen el mismo marco pero siguen donde estaban (A5 rehace diálogo y tienda; después
    son `GameWindow` acoplables);
  - mover ventanas con el teclado y cambiarles el tamaño no se hizo (después sí).
- **Gremio (UI-7):** ventana propia con pestañas Resumen, Miembros y Guerras. La
  administración quedó en Resumen (mensaje del día y disolver) y la invitación en Miembros.
  Una invitación al jugador sale sobre el mapa con Aceptar y Rechazar, como antes, y el
  botón Gremio muestra un punto mientras espera.
- **Chat (UI-10), cambio:** abajo del dock, no flotante (ver UI-10).
- **Animaciones (UI-9):** abrir y cerrar ventanas, botones, orbes con ola y "fantasma",
  latido y viñeta roja con poca vida, barras con `transform`, avisos que entran y se van,
  subida de nivel con destello en la barra de experiencia y aviso en Grenze Gotisch, y la
  pantalla de muerte. Se apagan con `prefers-reduced-motion` o con "Animaciones reducidas"
  (Opciones → Interfaz). La sacudida de cámara y el destello de la hotbar no se hicieron
  (después sí: "Hecho: lo que quedaba de A3, A4 y A5").
- **Teléfonos:** encabezado compacto, pestañas y cajón como en T5.6, con el tema.
- **Verificación sin servidor:** `make ui-preview` (docs/08) saca screenshots de la UI en
  varios tamaños sin levantar nada.

### Hecho: A6 (2026-11-18, ramas `feat/movement-feel` y `feat/movement-more`)
Está en §4, al principio, porque cambia el plan de MOV-1 y MOV-4: el servidor encola los
pasos de teclado (tope `max_queued_steps`, época `walk_epoch`, número `seq`/`walk_seq`) y
soltar la tecla no manda `StopWalk`; el click y el mouse mantenido caminan por esa misma
cola, con el camino armado y rearmado en el cliente (sin `WalkPath`). El E2E de MOV-9 corre
con ~150 ms de latencia simulada.


### Hecho: A4, A5 y los botones del gremio (2026-11-18, rama `feat/ui-interactions`)
Solo cliente: el servidor y el protocolo no cambian (`MoveItem.count`, `StopWalk` y
`LookAt` ya existían). El detalle técnico está en `client/CLAUDE.md`, "Notas de A4 y A5".
- **Controles (UI-6).** Opciones → Controles → "Clic derecho sobre objetos": `menu` (por
  defecto) o `classic` (`localStorage` `rpg.controls`). En los dos modos:
  - **sobre una criatura, el click derecho ataca o habla, como siempre**: pelear sigue
    siendo un click. Es un cambio sobre UI-6, que pedía un menú también para las
    criaturas; ese menú (atacar o hablar, mirar) sale con **Mayús+click derecho**;
  - **Ctrl+click derecho** usa al instante el item de arriba (en el mapa, también el que
    está sobre una escalera de mano, como antes);
  - **doble click** hace la acción por defecto: en el equipo, los contenedores, la tienda
    (compra o vende una unidad) y, en modo `menu`, en el mapa. En el mapa el primer click
    del doble ya empezó a caminar: el doble click termina ese camino (desde A6, segunda
    parte, sin `StopWalk`: los pasos ya mandados se dan) y después usa;
  - Mayús+click izquierdo sigue mirando (`LookAt`: el texto del servidor, con datos vivos).
- **El menú del item** (`ui/ActionMenu.tsx`, el del toque largo de T5.6): título con el
  ícono a 2x, **las acciones arriba** (la primera es la acción por defecto, en negrita y
  dorada) y **la ficha debajo**. Arriba y no abajo porque así la acción por defecto queda
  junto al cursor y, en un teléfono acostado, los botones nunca se cortan. Acciones:
  Abrir (contenedor), Usar con… (herramienta), Comer (comida), Equipar (lo mueve a su slot
  con `MoveItem`; el servidor revisa manos, nivel y vocación), Usar, Mirar, Mover (el
  siguiente click o toque en una casilla, un slot o una celda lo deja ahí) y Mover parte…
  (un campo con cuántos; manda `MoveItem.count`: resuelve el m1 de la prueba exploratoria
  para el inventario y el mapa). Los objetos fijos del mapa (estaciones, tableros:
  `pickupable: false`) no ofrecen Mover. Con el mouse el menú se abre en el cursor, con
  botones compactos; con el dedo, como antes.
- **La ficha** (`state/item-card.ts` puro + `ui/ItemCard.tsx`): tipo ("Arma — espada, una
  mano"), ataque, defensa, armadura, alcance, lugares, cargas, peso (y el de toda la pila),
  requisitos en rojo si no se cumplen (nivel, vocación, nivel mágico de una runa), efectos
  (cura, maná, comida, elemento, munición), la descripción en itálica y las marcas "No se
  puede intercambiar" / "No se vende en el mercado". Los datos los suma el plugin de Vite
  al `ItemDef` (`cardFields`). **No se hizo:** el color de item de misión
  (`--ui-item-quest`): `data/items` no marca los items de misión (después: `quest: true`).
- **Tooltip** (`ui/ItemTooltip.tsx`): la misma ficha a los 350 ms de mouse quieto sobre un
  item del DOM (equipo, contenedores, tienda, intercambio, recetas) o con el foco del
  teclado (los items del inventario toman el foco: Enter = acción por defecto, la tecla de
  menú o Mayús+F10 = menú). No toma clicks y se va con cualquier click, la rueda o Escape.
  Sobre el canvas no hay tooltip: ahí está el menú (después sí, para lo que se lleva).
- **Diálogo (UI-8):** abajo al centro, `min(47.5rem, 100%)` de ancho; retrato del NPC a 2x
  (no 3x: los sprites de NPC son de 32 px y a 3x tapaban texto); el texto entra con un
  fundido corto (**no** letra por letra: queda pendiente, y rompería las esperas de los
  E2E; después sí, sin romperlas: el texto entero sigue en la página); opciones en grilla `repeat(auto-fill, minmax(12rem, 1fr))` con número, ícono y
  borde de color por tema, hasta 2 líneas y el texto completo en el `title`. Orden:
  Misiones, Comercio, Viajes, Servicios, Conversación; dentro de cada tema, el orden del
  servidor. Fila de abajo: Volver (0) y Adiós (Escape; si el nodo no tiene "Adiós",
  cierra). Con 10 opciones o más aparece "Buscar tema…". 18 opciones entran sin scroll a
  1280x720 (`make ui-preview`, escena `dialog18`). Las teclas 1–9 eligen el botón con ese
  número (`state/dialog.ts` `dialogLayout`, el mismo orden que la ventana).
- **Temas de las opciones:** el plugin de Vite los deduce **por NPC** (no por clave global:
  `dialog.accept` es una misión en un NPC y podría ser otra cosa en otro) con
  `dialogTopics`: `tag` → Adiós (`close`, `dialog.bye`) → Volver (`dialog.back`) →
  Comercio (`open_shop`) → Misiones (condición o acción `quest_*`) → Servicios (`heal`,
  `bless`, `train_skill`, `restore_mana`) → Viajes (`teleport`, o un nodo con
  `boat_routes`) → Conversación. Una opción de conversación que lleva a otro nodo mira un
  paso adelante: si allí hay misiones, viajes o servicios, toma ese tema ("¿Bendiciones?" →
  Servicios). Las rutas de `boat_routes.yaml` son Viajes de su capitán. Una misma clave
  con dos temas en un NPC hace fallar `vite/content.test.ts`; se resuelve con `tag`
  (docs/06). Hoy no hay ningún conflicto.
- **Tienda (UI-8):** ventana propia; en escritorio va a la izquierda del diálogo (que se
  angosta a una columna). Pestañas Comprar y Vender, búsqueda por el nombre traducido (sin
  mayúsculas ni tildes), filtros con ícono solo de las categorías que hay (Todo, Armas,
  Armaduras, Herramientas, Consumibles, Materiales, por `kind`), grilla de celdas de 72 px
  (ícono a 2x y precio). Columnas: las que entran, hasta 6; filas: hasta 4 según el alto
  (24 a 1280x720 y 1280x800, 15 a 960x700). Lo que no entra se pagina ("‹ 1/2 ›"), nunca
  scroll. Barra de abajo: el item elegido con su tipo, −, cantidad, + y Máx. (lo que paga
  el dinero o lo que se lleva, hasta 100), el total (en rojo si no alcanza) y
  Comprar/Vender; Enter confirma. Vender muestra primero lo que se lleva (con su cantidad)
  y en gris lo que no. Click derecho en una celda: la ficha. En teléfonos la tienda va
  primero en la hoja y el diálogo deja solo sus botones; ahí la hoja sí se desplaza.
- **Gremio (UI-7):** una fila de botones con ícono propio (16x16, `ui/icons.tsx`):
  Resumen (tu rango, miembros en línea, guerras, salir o disolver), Miembros (punto de
  conectado, insignia de rango y "⋯" con lo que tu rango permite sobre cada uno), Rangos
  (quién tiene cada rango y qué puede hacer), Invitar (el campo y las invitaciones
  enviadas; a un miembro le dice quién invita), Guerras y Mensaje (el mensaje del día). Se
  abre con el botón Gremio de la botonera o la G.
- **Pendiente de esta parte:** texto letra por letra del diálogo; retrato animado;
  color de items de misión; arrastrar con Mayús para dividir una pila (hoy es "Mover
  parte…" del menú); el intercambio con cantidad (`TradeOffer` no la lleva, sigue en
  docs/14); tooltip sobre el canvas; cada contenedor como ventana propia. Todo hecho menos
  el intercambio con cantidad: "Hecho: lo que quedaba de A3, A4 y A5".


### Hecho: lo que quedaba de A3, A4 y A5 (2026-11-18, rama `feat/ui-windows-2`)
Solo cliente (más `quest` en `data/items` y los íconos de spritegen): el servidor y el
protocolo no cambian. El detalle técnico está en `client/CLAUDE.md`, "Notas de lo que
quedaba de A3, A4 y A5".
- **Cada contenedor es su ventana (UI-5).** Abrir una mochila (o los restos de un
  monstruo) abre una ventana propia con su título, plegable, que se cierra con su × (o
  Escape si es la flotante de arriba) y se acopla bajo el equipo, como en Tibia, o flota
  donde el jugador la deje. La grilla toma las columnas que entran (de 4 a 6 en el dock).
  El lugar se recuerda **por item** en el dispositivo (`container-backpack`; un segundo del
  mismo item es `container-backpack-2`), así la mochila vuelve a abrirse donde estaba. Los
  restos son la excepción (rama `feat/combat-visuals`): los de todas las familias y el
  cuerpo de un jugador comparten un lugar, `container-remains`, y el cadáver de un cangrejo
  se abre donde quedó el del lobo. En tablets y teléfonos siguen debajo del equipo, como
  antes.
- **Las ventanas del servidor son `GameWindow`.** Diálogo, tienda, crafteo, mercado, casa e
  intercambio tienen la barra de las demás (ícono, título, mover, plegar, cerrar), se
  acoplan, flotan, se apilan y recuerdan su lugar. El servidor las sigue abriendo y
  cerrando: su × hace lo que hacía el de antes (Adiós, cerrar la estación, cerrar el
  mercado o la casa, cancelar el intercambio). La tienda no tiene ×: se cierra con su
  diálogo. La primera vez salen donde estaban: el diálogo abajo al centro, con la tienda a
  su izquierda; crafteo, mercado y casa arriba a la izquierda; el intercambio arriba a la
  derecha. Los `data-testid` (`dialog`, `shop`, `crafting`, `market`, `house`, `trade`,
  `house-name`) y los nombres de los botones de cerrar se mantienen.
- **Mover y cambiar el tamaño, con el mouse y con el teclado (UI-1, UI-5).** La esquina de
  abajo a la derecha cambia el tamaño (una ventana acoplada, el borde de abajo, solo el
  alto), con un mínimo de 160x72 y nunca más grande que el área. El botón ✥ de la barra
  arrastra como la barra y, con el foco (Tab), toma el teclado: las flechas mueven la
  ventana 16 px, Mayús+flechas cambian su tamaño, en una acoplada arriba y abajo la cambian
  de lugar en la columna, y Enter o Espacio la acoplan o la sueltan junto a la columna. Alt
  queda para el navegador (Alt+← es "atrás"). La ayuda (H) lo cuenta. **Desde el
  2026-11-23 ya no:** el ✥ se quitó y el tamaño cambia desde las cuatro esquinas (UI-5).
- **Escala de la interfaz y tamaño del texto (UI-3).** Opciones → Interfaz (y el menú ☰ del
  teléfono): "Escala de la interfaz" de 80 % a 150 % (el dock y las ventanas crecen; el
  mapa toma lo que queda, así que a 125 % en 1280x800 baja a 1x; la hotbar no se escala:
  mide sus slots para paginarlos) y "Tamaño del texto" de 90 % a 130 % (en `rem`, como
  pedía UI-3). Cambio sobre el plan: son **dos**
  opciones, porque el texto más grande no debería quitarle un paso de zoom al mapa (el
  ancho del dock quedó en px) y la escala sí agranda los íconos y los slots. Se recuerdan
  por dispositivo.
- **Íconos de slot vacío (UI-5).** Diez siluetas propias de 20x20 (yelmo, amuleto, mochila,
  túnica, espada, escudo, pantalón, bota, anillo y flechas), color hueso y grabadas en la
  piedra, hechas con spritegen (`ui/slots/<slot>`, `kind: ui`); el equipo las muestra al
  30 % en el slot que no tiene nada.
- **Sacudida de cámara y destello de la hotbar (UI-9).** Un golpe que quita de una vez el
  10 % de la vida máxima o más sacude la cámara 2 px durante 120 ms (un patrón fijo que se
  apaga). Es opción aparte ("Sacudir la cámara con los golpes fuertes", encendida) y nunca
  pasa con movimiento reducido. Usar un hechizo de la hotbar (tecla o click) hace destellar
  su slot 150 ms; con movimiento reducido, no.
- **Texto del NPC letra por letra y retrato (UI-8).** El texto aparece a 90 caracteres por
  segundo; un click en él o Espacio lo completa y con movimiento reducido sale entero. La
  caja tiene su tamaño final desde el principio (lo que falta espera invisible) y el texto
  entero está en la página para los lectores de pantalla y para las esperas de los E2E. El
  retrato "respira": sube un píxel en un bucle lento de 3,2 s. No se hizo "▼ más" (paginar
  un texto que no entra): con los textos de hoy no hace falta.
- **Items de misión con su color (UI-6).** Un item marcado `quest: true` en `data/items`
  (esquema y docs/06; hoy `bosun_logbook`, `smuggler_tally`, `sealed_coffer`,
  `delver_chart`, `forge_seal` y `tarnished_locket`) se nombra en `--ui-item-quest` en la ficha, el tooltip y el menú,
  suma la marca "Objeto de misión" (el color no es la única señal) y tiene un anillo dorado
  en su celda. Como pide UI-6, los demás nombres pasaron de oro a `--ui-text`.
- **Tooltip sobre el canvas.** Con el mouse quieto 350 ms sobre una casilla sale la ficha
  del item que está ahí, debajo del texto de la acción junto al cursor. Solo para lo que se
  lleva y se puede levantar: ni suelos, ni muros, ni decoración, ni estaciones (de esos
  dice lo que importa el texto del cursor).
- **Mayús+arrastrar para dividir una pila.** Arrastrar con Mayús una pila (de un
  contenedor, un slot o el mapa) pregunta, donde se suelta, cuántas unidades mover (la
  mitad para empezar, de 1 a la pila menos una, como "Mover parte…"); Enter mueve, Escape
  cancela. Mayús+click sigue mirando: en el mapa, ahora mira al soltar.
- **Pendiente:** el intercambio con cantidad (`TradeOffer` no la lleva); el marco de
  hierro como PNG 9-slice; enfocar una ventana del servidor al
  abrirse. (Si el jugador camina con el mouse quieto, la ficha de la casilla anterior se va
  y la espera empieza de nuevo en la que queda bajo el cursor.)


### Hecho: el equipo y el tooltip al estilo Diablo II (2026-11-18, rama `feat/equipment-d2`)
Los dos pedidos del dueño del 2026-11-18 (UI-5 y UI-6, arriba). Solo cliente: el servidor y
el protocolo no cambian. El detalle técnico está en `client/CLAUDE.md`, "Notas del equipo y
el tooltip al estilo Diablo II". Solo la idea del panel y del tooltip: el arte, las fuentes,
los nombres y los textos son nuestros.
- **La figura.** Diez slots sobre una grilla de 8x9 celdas cuadradas (tabla de UI-5) que
  toma el ancho que tiene la ventana: acoplada en el dock (a 1280 y 1920 px de ancho los
  íconos de los slots grandes van a 2x; a 960 px, a 1x), flotando (crece al agrandarla) o
  en la pestaña del teléfono (de lado a lado, hasta 44 px por celda). Las celdas miden un
  número par de píxeles enteros, así cada ícono cae en píxeles enteros. Un ícono de 32 px
  en el anillo o el cuello, que a veces miden menos, sobresale un poco de su borde, píxel
  por píxel, en vez de achicarse.
- **Brillo y rojo.** Mientras se arrastra un item (desde el inventario, un contenedor o el
  mapa) o hay uno elegido con un toque o con "Mover", los slots que lo aceptan brillan en
  dorado; el que no lo acepta se tiñe de rojo bajo el puntero. La regla es la del servidor
  (un arma en la mano derecha, un escudo en la izquierda, cada armadura en su slot, la
  munición en el carcaj, un contenedor en la espalda); nivel, vocación y manos libres los
  sigue diciendo el servidor al soltar.
- **La mochila abajo de la figura.** La mochila equipada se abre sola cuando el inventario
  se muestra (una vez: si el jugador la cierra con su ×, queda cerrada hasta que el
  inventario se vuelva a abrir o se equipe otra) y su grilla va abajo de la figura, en la
  misma ventana. Si se la saca de la espalda y sigue al alcance, pasa a una ventana propia;
  al volver a equiparla sigue en su ventana (el cliente no sabe si es la misma u otra del
  mismo tipo, y con otra el botín arrastrado abajo iría a la del suelo: revisión final del
  lote 9), y un doble click en el slot la cierra y otro la abre abajo. **No se abre sola durante el tutorial**:
  su paso "abre tu mochila" enseña a hacerlo. Como `ContainerOpen` no dice dónde está el
  contenedor, el cliente toma como mochila equipada la ventana que contesta un uso del
  slot de la espalda (si alguna vez molesta, un campo en `ContainerOpen` lo haría exacto).
- **Capacidad.** Una barra fina de lo que se carga (dorada; ámbar desde el 85 %, roja sin
  lugar) y el texto de siempre abajo.
- **El tooltip.** Sin espera (antes 350 ms) y arriba del item, como dice UI-6. Al barrer una
  grilla con el mouse pasa de celda en celda sin parpadear (espera 80 ms al salir de un
  item por si entra en otro). Sobre el mapa, la ficha del item de la casilla bajo el mouse
  sale al instante arriba de esa casilla (abajo, si no hay lugar, pasando el texto del
  cursor). No sale mientras se arrastra algo.
- **Lo que no se hizo:** los items de dos manos no ocupan las dos manos a la vez en la
  figura (el servidor tiene un solo slot por mano); no hay guantes, cinturón ni segundo
  anillo (no existen esos slots); mantener Alt para ver los nombres de los items del suelo
  queda como idea.

### Hecho: criaturas de Gemini (2026-11-18, rama `feat/gemini-creatures`)
Siete monstruos que eran un sprite de Dungeon Crawl con la animación de ANI-5 ahora tienen
frames hechos con el Gemini del dueño (SRC-5): de Velmara `wolf`, `bilge_rat`,
`tide_crab`, `gloom_bat` y `moss_spider` (también en el Bosque), y del Bosque `mire_toad`
y `thornling`. Una hoja por criatura (diez pedidos en total: tres para probar el formato
con el lobo), cortada con `tools/gemini/import_art.py` y declarada como datos en
`assets/sprites.yaml` (`mirror`, `anchor: bc`, `shadow: ellipse`, `ms`). Cómo se pide, se
corta y se revisa: `assets/README.md`, "Criaturas animadas de una sola hoja".
- **Direcciones (ANI-1):** sur, norte y oeste dibujados; el este, el oeste espejado.
  Morir, solo hacia el sur, como LPC.
- **Lo que no vino:** Gemini casi nunca dibuja un ataque de frente o de espaldas. Con un
  frame de golpe usable se armó el clip (parado, golpe, parado); si no, esa dirección usa
  la embestida de ANI-5 con su frame parado (ANI-2, "Quieto y atacar, solo hacia sus
  lados"): el cangrejo no tiene mordisco al sur; el murciélago, el sapo y el espinoso, al
  norte (el sapo tampoco al sur ni quieto al norte).
- **Tamaño (ART-2):** rata y cangrejo en 32x32; lobo, araña, sapo, murciélago y espinoso en
  64x64 con los pies en la casilla, a la escala de los personajes de LPC (el lobo ~36 px
  de largo, el espinoso ~40 de alto). La escala mezclada con los monstruos de Dungeon Crawl
  que quedan sigue (docs/14).
- **Quedaron fuera:** la gaviota (`thieving_gull`) ya es arte propio de spritegen; su hoja
  de Gemini salió bien pero cambiarla es decisión del dueño. Los del Volcán y
  `hollow_crawler`, `ore_beetle` siguieron con ANI-5 hasta la segunda tanda (abajo).
- **/credits** lista lo hecho con Gemini ("Hecho con IA", desde `CREDITS.md`).

**Segunda tanda (2026-11-18, rama `feat/gemini-creatures-2`):** `hollow_crawler` y
`ore_beetle` (Bosque y Puerto) y los cinco del Volcán: `ash_hound`, `cinder_salamander`,
`slag_golem`, `ember_wyrmling` y el jefe `slagbound_warden`. Ya ningún monstruo usa un
solo frame de Dungeon Crawl. Trece pedidos: uno por criatura, uno más para el sabueso
(caminaba de costado hacia la cámara), el gólem (casi negro y chico en la hoja) y el
custodio (vino con líneas de grilla y el martillo cambiando de mano), y tres hojas nuevas
para los ataques que faltaban (abajo).
- **Tamaños** (ART-2, "Animales medianos"): escarabajo en 32x32; reptante, sabueso,
  salamandra, gólem y dragoncillo en 64x64; el custodio en **96x96**, ~77 px de alto, una
  vez y media una persona, con su martillo.
- **Los brillos:** las grietas de lava, la garganta y el fuego del dragoncillo, y el
  horno del custodio se perdían al reducir los colores de todos los frames juntos a 16 (son
  pocos píxeles). Los del Volcán se cortaron con `--colors 0`: cada color va directo a la
  paleta de spritegen (que tiene el naranja de `ember`) y el brillo queda.
- **Lo que no vino:** atacar al norte en todos menos el gólem y el custodio, al sur en la
  salamandra, el escarabajo y el dragoncillo, y a los lados en el custodio (no dibujó un
  martillazo de perfil) y el escarabajo (que no ataca con frames en ninguna dirección: sus
  mandíbulas no se ven a 32 px y queda la embestida); quieto al
  norte en el sabueso (su "quieto de espaldas" medía 9 px menos que su caminar y se encogía
  al parar: se queda con el primer frame de caminar). Esas direcciones usan la embestida
  de ANI-5, como en la primera tanda.
- **Las hojas nuevas del cangrejo, el sapo y el espinoso** (con un frame del juego como
  referencia, para tapar sus ataques que faltan): ninguna trajo el ataque que faltaba (el
  cangrejo de frente sigue sin pinza, el sapo y el espinoso no atacan de espaldas) y el
  sapo y el espinoso salieron con otro aspecto (más verde, más liso). No se usaron. El
  murciélago no se pidió: en tres intentos Gemini no dibujó un ataque de espaldas.

### Hecho: A7 (2026-11-18, rama `feat/wide-view`)
Las reglas de juego están en `02-game-design.md`, "La vista"; el protocolo en
`05-network-protocol.md` (`Welcome.view_width`/`view_height`, áreas de 33x23); el costo en
`07-performance-budget.md`, "Vista ancha"; el zoom en `client/CLAUDE.md`, "Zoom del mapa".
Cambios respecto de UI-4:
- **Una ventana para todos, no una por cliente.** El servidor manda a cada jugador 31x21
  + 1 de margen, tenga la pantalla que tenga. UI-4 pedía que el cliente eligiera su vista
  de 15x11 a 31x21 y el servidor mandara esa área. Con una sola, "A ve a B" sigue
  simétrico, un cliente modificado no gana nada pidiendo más y el ancho de banda entra en
  el presupuesto igual (1,7 KB/s por jugador en el peor escenario medido). Si algún día
  pesa (datos móviles), el `Hello` podría pedir una ventana menor y el servidor recortar
  solo lo que manda.
- **La escala por defecto.** UI-4 decía "la más grande que muestra al menos 15x11". Con el
  dock de A3 eso da 3x a 1920x1080, que muestra 16x11: casi nada más que antes. Quedó la
  **vista más grande que llena la caja del mapa a escala entera**: la escala más chica a la
  que la ventana de 31x21 cubre la caja, sin bajar nunca de las 15x11 (`render/zoom.ts`,
  `min(pixelScale, fillScale)`). Así se ve más sin franjas vacías y una pantalla chica
  conserva la escala de antes. Con el dock, en CSS px al 100 %:

  | Ventana | Por defecto | Alejando hasta |
  |---|---|---|
  | 1280x800 | 2x: 15x12 | 1x: 30x21 (la caja tiene 960 px) |
  | 1280x720 | 2x: 15x11 | 1x: 30x21 |
  | 1920x1080 | 2x: 24x16 (antes 3x: 16x11) | 1x: 31x21 |
  | 2560x1440 | 3x: 22x14 (antes 4x: 17x11) | 2x: 31x21 |
  | 960x700 (la app) | 1x: 21x21 | — |
  | Teléfonos | la escala de antes, con la caja llena hasta 31x21 | 1x |

- **Los bordes.** El canvas llena la caja con casillas fraccionarias en los bordes,
  centrado en el jugador, como el zoom de antes; no se recorta a lados impares con
  `--ui-void` alrededor. Solo alejado más allá de la ventana entera queda caja oscura.
- **Lo que no cambia** (como decía UI-4): ni los rangos de armas y hechizos ni lo que nota
  un monstruo, que sigue siendo la ventana clásica de 15x11 + 1 (`session.InSight`). Los
  rangos con que apunta un jugador quedaron topados en 6 (`content.MaxRange`): con la vista
  ancha se elige un objetivo a 15 casillas, pero no se le pega desde donde no lo nota.
- **Sin hacer:** la escala 1,5x "sharp-bilinear" y repetir `make bots` contra un servidor
  real (la medición fue en proceso, `TestCrowdBandwidth`). Están en docs/14.

### Hecho: A14, pantalla completa, ventanas flotantes y la barra gótica (2026-11-18, rama `feat/hud-fullscreen`)
Lo pidió el dueño el 2026-11-18 ("Lo que pidió el dueño", arriba: la cita y sus dos
respuestas). Solo cliente y solo escritorio: tablets y teléfonos siguen con las pestañas y
el cajón de T5.6; el servidor y el protocolo no cambian. El detalle técnico está en
`client/CLAUDE.md`, "Notas de la pantalla completa" y "Zoom del mapa".
- **Pantalla completa (UI-4).** Se fueron el dock (la columna derecha) y el marco del
  mapa. El mapa es toda la pantalla sobre la barra de abajo: el jugador queda al centro de
  esa área y la vista ajustada siempre la cubre a escala entera, sin franjas vacías. En
  teléfonos sigue la regla de antes (nunca menos de 15x11); en escritorio cubrir manda.
  En CSS px al 100 %:

  | Ventana | Caja del mapa | Por defecto | Alejando hasta |
  |---|---|---|---|
  | 1920x1080 | 1920x992 | 2x: 30x15,5 | 1x: 31x21 |
  | 2560x1440 | 2560x1352 | 3x: 26,7x14,1 | 2x: 31x21 |
  | 1280x800 (la del E2E) | 1280x712 | 2x: 20x11,1 | 1x: 31x21 |
  | 1280x720 | 1280x632 | 2x: 20x9,9 | 1x: 31x19,75 |
  | 960x700 (la app) | 960x612 | 1x: 30x19,1 | — |
  | 2560x1080 (ultra ancha) | 2560x992 | 3x: 26,7x10,3 | 1x: 31x21 |
  | 3440x1440 (ultra ancha) | 3440x1352 | 4x: 26,9x10,6 | 2x: 31x21 |

  A 1280x720 la vista ajustada muestra menos filas que las 11 clásicas: la otra opción
  era 1x con franjas oscuras a los lados, que es justo lo que el dueño no quiere. Alejando
  se ve casi toda la ventana. Lo mismo en las pantallas ultra anchas (21:9): cubrir el
  ancho pide una escala que deja unas 10 filas; alejando un paso se ve la ventana entera.
- **La barra gótica (UI-4, respuesta del dueño).** Orbe de vida abajo a la izquierda, de
  maná abajo a la derecha, cada uno en un engaste de hierro con remaches y dos pináculos que
  sale por encima de la barra; en el medio la barra de experiencia y, en un pozo tallado,
  la hotbar F1–F12 y la botonera (I K B P G O, opciones, ayuda, mercado y salir: dos filas
  de cinco, o una fila con los íconos a 2x desde 1600 px). Sobre el orbe de vida, una placa
  con nombre, nivel, experiencia y condiciones. Es lo único fijo. Los orbes conservan el
  llenado, el fantasma y el latido con poca vida (UI-9); los test ids (`health`, `mana`,
  `level`, `experience`, `conditions`, `toolbar-<id>`, `options-button`, `logout`) y las
  teclas no cambian. Crece con la escala de la interfaz y entra a 960 px (la hotbar pagina:
  6 slots a la vista).
- **Ventanas libres con imán (UI-5, respuesta del dueño).** Batalla, inventario,
  habilidades, grupo, gremio, apariencia, opciones, ayuda, el chat, los contenedores y las
  del servidor (diálogo, tienda, crafteo, mercado, casa, intercambio) flotan. Cada una se
  suelta donde sea y recuerda su lugar; a menos de 10 px de un borde de la pantalla, del
  techo de la barra o de un borde de otra ventana (de lado o alineada con él) se pega. Nunca
  queda fuera de la pantalla ni debajo de la barra, tampoco después de achicar la ventana
  del navegador o subir la escala, ni al abrirla de nuevo si se cerró antes de achicarla:
  una que queda aplastada a menos de su alto mínimo (72 px; desplegada contra la barra, o
  con su techo por debajo del área nueva) sube hasta verse entera, y una que todavía
  muestra eso se queda donde el jugador la dejó, con su cuerpo desplazable. Cambiar el
  tamaño desde una esquina también siente el imán (desde el 2026-11-23; antes lo sentían
  las flechas del ✥, que se quitó). Lugares de fábrica: batalla arriba a la izquierda con el
  grupo a su lado y las habilidades debajo; inventario arriba a la derecha con gremio y
  apariencia a su lado y los contenedores justo debajo de él (de lo que mida: con la
  figura y la mochila, unos 500 px; con el inventario cerrado o movido, desde arriba); el
  chat abajo a la izquierda; opciones y ayuda al medio; el intercambio arriba al
  centro; diálogo, tienda, crafteo, mercado y casa abajo al centro, sobre la barra (la
  tienda a la izquierda del diálogo, los dos sin pisar la columna del inventario).
  "Restablecer ventanas" las devuelve ahí. Un `rpg.windows` guardado con el dock se sigue
  leyendo: lo acoplado vuelve a su lugar de fábrica, lo que flotaba conserva el suyo.
  Escape cierra la de arriba (la última abierta o tocada); en una pantalla recién abierta
  sigue abriendo Opciones. Ninguna ventana tapa el chequeo de presencia (un chequeo
  escondido vencería y contaría como fallado, docs/02) ni la pantalla de muerte: las dos
  van por encima de todas, y también las invitaciones de grupo y de gremio (vencen, y el
  chat en su lugar de fábrica llega debajo de ellas a 1280 y 960 px), las del gremio más
  arriba que las del grupo; el tutorial, que se pliega y no vence, va por debajo (las
  ventanas que salen a su lado, como la ayuda, el gremio y la apariencia, lo tapan).
- **El chat (UI-10)** flota translúcido, como en Ragnarok Online, y se aclara con el mouse
  encima o al escribir; nunca se cierra (se pliega), y sus pestañas Chat y Registro van en
  su barra de título.
- **Arte gótico (UI-2), propio.** Marcos más ricos: hierro oscuro con un filo dorado por
  dentro, barra de título tallada y una escuadra de oro con un granate en cada esquina; la
  barra en piedra de sillares con su banda de hierro y remaches. Las piezas (esquina,
  pináculo, remache) son pixel art propio escrito como texto en
  `client/src/ui/ornaments.ts`, como los íconos, en el espíritu de piedra, hierro y oro
  viejo de §1, sin calcar nada de Diablo ni de Tibia (ni sus marcos, ni sus orbes, ni sus
  fuentes: las de UI-3 siguen). No se usó Gemini: con el CSS y estas piezas alcanzó, y el
  navegador del dueño queda libre para los otros lotes. Las reglas de movimiento reducido
  siguen (la ola de los orbes y el latido se detienen).
- **Queda:** las pestañas del chat, su opacidad y el lugar de fábrica que mira las
  ventanas abiertas se hicieron en el lote 10 (abajo). El E2E del lote 9 (verde) encontró
  los clicks del mapa que caían en una ventana (los specs saltan 5 columnas a 1280x800) y
  la página 7 px más ancha por los pináculos del orbe de maná (el cuerpo del juego
  recorta); lo que queda para el dueño está en docs/14 (íconos a 1x en el inventario de 16
  rem, pináculos cortados en los bordes).

### Hecho: lugares de fábrica, pestañas del chat y sonidos que reintentan (2026-11-19, lote 10, rama `feat/ui-polish`)
Lo que el E2E del lote 9 y la auditoría del 2026-11-18 dejaron de la UI (UI-5, UI-10) y del
sonido. Solo cliente, más una línea de diálogo y el arte del teletransporte.
- **Un lugar de fábrica que mira las ventanas abiertas** (`defaultPlace` de
  `client/src/ui/windows.ts`, puro y con tests; `placeOpened` de `ui/window-dom.ts`): una
  ventana que se abre en su lugar de siempre (windows.css) se mide ahí antes de pintarse;
  si tapa a otra ventana abierta, o (el intercambio) las 3 casillas al norte del jugador
  (`Game.selfTile`, donde suele estar el compañero), prueba una lista corta de lugares y
  toma el primero que no tapa nada, o el que menos tapa:
  - el **intercambio** se corre por la fila de arriba (contra los bordes, la columna del
    jugador u otra ventana, el más cercano primero, a 4 px; si así no entra en ningún
    lado, pegado a ellas: a 1280x800 entre la batalla y la columna del jugador hay justo
    su ancho) y nunca queda sobre esas casillas;
  - el **diálogo** (y crafteo, mercado y casa, sobre la barra) se acorta hasta el pie de lo
    que baja hasta él, con su fondo donde estaba, si le quedan al menos `GIVE_WAY_MIN_PX`
    (120): a 960x700 la pareja tienda + diálogo ya no pisa el pie del inventario. El
    diálogo se vuelve a medir cuando su lugar de siempre cambia estando abierto
    (`placeContext` y `toLookAt` de `windows.ts`): la tienda que llega después (el flujo
    real, "Quiero comerciar") lo pone al lado, más angosto, y se mide ahí (`usualBox` de
    `window-dom.ts` levanta el lugar que le dio la mirada anterior), y el diálogo de otro
    NPC, de otro alto, también;
  - las **habilidades** van bajo la batalla solo si entran sobre el chat; si no, al lado de
    la batalla o del grupo, a la izquierda de la columna del inventario, o acortadas sobre
    el chat.
  El lugar dura mientras la ventana sigue abierta y sin mover (no se guarda en
  `rpg.windows`); si cambia el área, todas vuelven a su lugar de siempre y se miran de
  nuevo. El panel del tutorial se oculta mientras la Ayuda, el gremio o la apariencia
  están en su lugar de fábrica (`tutorialCovered`).
- **La ficha espera al mouse** (`TipGate` de `ui/ItemTooltip.tsx`): después de que se abre,
  cierra o pliega una ventana no sale ninguna ficha hasta el primer `pointermove` que
  mueve el mouse (la tienda se abre bajo un mouse quieto y su ficha tapaba los filtros);
  el teclado la muestra igual.
- **Pestañas del chat** (UI-10, `client/src/state/chat.ts`, puro y con tests): ver UI-10.
  Una línea propia no marca nada; un anuncio del staff sale en todas. Con el chat plegado
  nada cuenta como visto (también la pestaña abierta se marca); con el texto al 130 % la
  rueda corre las pestañas de lado (`wheelAlong`).
- **Sonidos que reintentan:** `AudioEngine.load` usa `ASSET_RETRY` de
  `@rpg/renderer/retry` (por `AudioPorts.sleep`); agotado, el sonido se vuelve a pedir
  recién después de `STREAM_RETRY_MS`, como la música, y el ambiente vuelve solo. Un
  archivo que llega pero no se decodifica (un navegador sin Ogg) no se vuelve a pedir en
  la sesión: fallaría igual cada vez.
- **El teletransporte gira** (ART-7): 6 frames de 100 ms en `world`
  (`recipes/portals.ts`, `tiles` de `assets/sprites.yaml`).
- **Vista previa:** escenas `allwindows`, `trade`, `chattabs`, `tutorialhelp` y
  `tutorialshop` en `make ui-preview`.

Orden sugerido (de antes de A2, A3 y A6). A6 y A8 son lo que más se nota con menos riesgo
y se pueden hacer ya.
Después A2, A3, A4 y A5 (la UI), luego A10 y A11 (muros y suelos), y al final A12 y A7.

### Hecho: proyectiles, restos por familia y la fuente del canvas (2026-11-19, rama `feat/combat-visuals`)
Del pedido del dueño de un pulido como el de Tibia y "todo animado" (auditoría del
2026-11-18, `art.items[1]`, `[2]` y `[4]`). Detalle técnico en `client/CLAUDE.md` ("Sprites
de efectos" y "Notas de la UI oscura") y en `tools/CLAUDE.md` (spritegen).
- **Proyectiles con sprite.** Antes cada proyectil era un punto del color de su elemento.
  Ahora `tools/spritegen` (`recipes/effects.ts`, sección "missiles") dibuja la flecha
  (`missiles/arrow/e` y `missiles/arrow/se`: 14 px de punta a culatín, dentro de los 16x16
  del medio de un sprite de 32x32) y un orbe por elemento con 3 frames y su chispa de
  estela (`missiles/<elemento>/{0,1,2,trail}`: fuego, hielo, energía, tierra, sagrado y
  muerte). El cliente vuela un proyectil físico como la flecha apuntada al objetivo de a
  45°: el dibujo recto o el diagonal, girado y espejado solo de a cuartos de vuelta (cada
  píxel cae en un píxel) y con el lado iluminado arriba o a la izquierda; uno elemental es
  su orbe (un frame cada 80 ms) con hasta tres chispas detrás, del mismo pool de sprites
  (ninguna detrás de quien dispara). Sin arte, el punto de antes. Flechas, virotes,
  cuchillos, botellas y esquirlas de obsidiana vuelan todos como la flecha: distinguirlos
  necesita un campo nuevo en `Projectile` (docs/14, "Pendientes conocidos").
- **Restos por familia** (ART-2 y ANI-7). Antes todo monstruo dejaba el mismo cuerpo
  (`creature_remains`, el "crawling corpse" de Dungeon Crawl). Ahora `data/monsters` tiene
  `corpse:` (docs/06) y cada familia deja el suyo, dibujado con el motor de sprites
  (`engine/specs/remains.ts`) mirando la pose final de la muerte de esa familia: la bestia
  de costado con las patas hacia la cámara (`remains_fur`), el artrópodo panza arriba con
  las patas encogidas (`remains_chitin`), el reptil con la cola enroscada
  (`remains_scales`), el montón de escoria con dos grietas de brasa (`remains_slag`), el
  esqueleto en un charco (`remains_bones`), el ave con un ala abierta (`remains_feathers`),
  la persona boca abajo con un brazo tirado (`remains_humanoid`) y las zarzas secas
  (`remains_bramble`); `creature_remains` quedó como un montón neutro de huesos sobre un
  cuero (lo usan los monstruos sin `corpse` y los jugadores). Todos en 32x32, de 24 a 30
  px de largo: ocupan su casilla como los cadáveres de Tibia, así que son más chicos que la
  última pose de las criaturas de 64x64 (el lobo cae de 41 px). Duran y se abren como
  antes.
- **Pixelify Sans en el canvas** (UI-3). Nombres, gremios y números flotantes estaban en
  la `sans-serif` del sistema, suavizada y distinta en cada sistema operativo. Ahora usan
  Pixelify Sans (OFL, de google/fonts con el mismo commit que las otras), a 11 px: sus
  contornos van sobre una grilla de 1/11 de em (mayúsculas de 7 celdas, minúsculas de 5),
  así que a 11 px una celda es un píxel de pantalla de alto y los trazos miden un píxel.
  **No es píxel perfecto a lo ancho:** cada letra empieza 0,66 px adentro de su lugar y
  los avances no son celdas enteras (la H avanza 586/1000 em, 6,45 px), así que las
  columnas caen entre píxeles y el canvas las suaviza un poco (`vite/canvas-font.test.ts`
  lo mide). Hay que mirarlo en una captura a 1x; si molesta, un `letterSpacing` de ~0,55
  px dejaría los avances casi enteros (cada letra pasa una celda entera por ~0,44 px), sin
  probar todavía. Con el contorno negro de 3 px de antes. El canvas espera la fuente junto
  con el atlas (2,5 s como mucho); si llega después, vuelve a medir y dibujar
  los nombres. Un nombre acortado a zoom 1 (12 caracteres) mide como mucho ~100 px (antes
  ~125 con la negrita de 12 px).

### Hecho: nombres más grandes y legibles (2026-11-24, rama `feat/name-labels`)
El dueño (2026-11-23): "los nombres sobre los personajes deben ser más grandes", y con el
color de algunos NPCs no se leían (el violeta `0x7d4fb0` sobre el contorno negro).
- **Tamaño** (`client/src/render/label-style.ts`, `labelScale`, puro y con tests). Antes un
  nombre medía siempre 11 px de pantalla, fuera cual fuera el zoom: a 4x en una pantalla de
  alta densidad era un cuarto de casilla. Ahora el `Text` se rasteriza una vez al tamaño de
  la grilla de la fuente (11 px, una celda por píxel) y se escala por un **entero** con
  muestreo al más cercano (`textureStyle: { scaleMode: "nearest" }`): cada celda pasa a ser
  un cuadrado exacto de 2x2 o 3x3 píxeles y el aspecto pixel art se mantiene (también el
  contorno de 3 px, que escala con él). La escala sigue al zoom del mapa:
  | Zoom del mapa | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
  |---|---|---|---|---|---|---|---|---|
  | Grande (por defecto) | 1 | 2 | 2 | 3 | 3 | 4 | 5 | 5 |
  | Normal | 1 | 1 | 1 | 2 | 2 | 3 | 3 | 4 |
  Grande es 3/5 del zoom redondeado hacia arriba; normal, la mitad hacia abajo (a 2x, el
  zoom de un monitor 1080p, queda como antes). Escalan igual la línea del gremio, la marca
  PvP y los números flotantes; la barra de vida ya escalaba con el zoom.
- **Opción** Opciones → Interfaz → "Tamaño de nombres" (normal / grande; `rpg.name-size`,
  `state/ui-prefs.ts`), grande por defecto.
- **Solapes** (`render/labels.ts`): las reglas de T5.6 (perder el gremio, subir una línea,
  ocultar los lejanos) ya no dependen del zoom solo, sino de qué tan grande es el nombre al
  lado de su casilla: se saltan solo si `zoom >= 2 × labelScale` (`labelsFull`). Con
  nombres grandes rigen a cualquier zoom, igual que a 1x; la separación al subir uno sobre
  otro es de una celda escalada. El recorte a 12 caracteres sigue entrando: un nombre
  recortado a escala k mide k veces lo de 1x al lado de una casilla k veces más grande.
- **Colores** (tokens en `label-style.ts`, `LABEL_COLORS` y `SKULL_COLORS`; `game-canvas.ts`
  y `state/pvp.ts` los usan). Cada relleno tiene un contraste WCAG de al menos 4,5:1 contra
  el contorno negro (`label-style.test.ts` lo calcula para todos, y para los efectos de
  nombre de la tienda contra su propio contorno), y los tonos quedan a 40° o más entre sí:
  | Quién | Antes | Ahora | Contraste |
  |---|---|---|---|
  | Uno mismo (azul) | `0x3a7bd5` (5,0) | `0x5ea2ff` | 8,1 |
  | Otro jugador (ámbar) | `0xd59a3a` | `0xf0b040` | 11,0 |
  | Monstruo (rojo) | `0xb03a2e` (3,5) | `0xff4f5e` | 6,5 |
  | NPC (violeta) | `0x7d4fb0` (3,6) | `0xc79bff` | 9,6 |
  | Gremio (verde) | `0xb8e986` | igual | 15,0 |
  | Marca agresor / asesino / proscrito | `0xf2b233` / `0xd23a3a` (4,4) / `0x8e4fd6` (4,2) | igual / `0xf04848` / `0xb07cff` | 11,2 / 5,7 / 7,2 |
  Los bloques de color de una criatura sin sprite usan los mismos tokens.
- **E2E** (`client/e2e/sandbox.spec.ts`, último test): el instructor de Thimblewick a 2x y a
  1x (`100-names-2x-npc`, `100b-names-1x-npc`), las ratas del corral a 2x, a 4x y a 4x con
  "Normal" (`101-*`), y el muro sur del templo delante del jugador (`102-*`, abajo). Hooks
  `__rpgClient.labels()` y `wallFade(x, y)`.
- **El muro delante del jugador** (ART-3, 2026-11-23) se verifica en el mismo test: parado en
  2092,2090, justo al norte del muro sur del templo, la pieza de 2092,2091 baja de 1 (alfa
  < 0,5), la de 2099,2091 no, y no se dibuja ninguna copia pálida del jugador
  (`102-wall-fade-own-player`, de cerca en `102b-...-close`).

### Hecho: nombres nítidos y los NPCs en dos líneas (2026-11-25, rama `feat/labels-and-steps`)
El dueño, después de jugar el lote 19: "la fuente que agrandaste de los nombres se ve muy
pixeleada y ahora está muy grande; déjala más definida y achícala un poco", y "los NPC
muestran su nombre y después unos puntos suspensivos; en vez de eso, dos líneas: el nombre
y abajo qué es lo que hace (Tilde Varga / Provisiones)".
- **Por qué se veía pixelada:** el nombre era la fuente pixel de 11 px rasterizada una vez
  y agrandada 2x o 3x con muestreo al más cercano (la sección de arriba): cada celda de la
  letra era un bloque de 2 o 3 px. Era nítido "como pixel art", pero a ese tamaño se leía
  como una letra de baja resolución.
- **Regla de resolución** (`client/src/render/label-style.ts`, `labelFontPx`): el nombre se
  rasteriza **al tamaño exacto al que se ve, en píxeles de dispositivo**, y el `Text` nunca
  se escala (escala 1, posición en px enteros). El canvas ya tiene su backing store en
  píxeles de dispositivo, así que la letra es tan nítida como la pantalla a cualquier zoom
  y con cualquier `devicePixelRatio` (Windows al 125 % o 150 % incluido). Al cambiar el zoom
  cambia el `fontSize` y Pixi vuelve a rasterizar; no hay textura por frame. La fuente es
  Alegreya Sans (la de la interfaz, OFL): negrita 700 para el nombre, 500 para las líneas
  de abajo, con contorno negro redondeado de ~1/4,5 del tamaño (mínimo 2 px).
- **Tamaño** (elegido mirando una lámina con los cuatro zooms a densidad 1, 1,25, 1,5 y 2,
  al lado del nombre del lote 19): sigue al zoom que ve el jugador (px CSS por px de
  sprite = zoom del mapa / `devicePixelRatio`, entre 1 y 4) y se pasa a px de dispositivo:
  | Zoom visto | 1 | 2 | 3 | 4 |
  |---|---|---|---|---|
  | Grande (por defecto), px CSS | 12 | 15 | 18 | 21 |
  | Normal, px CSS | 10 | 12 | 14 | 16 |
  | Lote 19 (fuente pixel escalada), alto de la letra | 11 | 22 | 22 | 33 |
  Las líneas de abajo (rol del NPC, gremio) miden el 80 % del nombre y nunca menos de 9 px
  CSS. La misma ventana se ve igual al 100 % y al 150 % de escala de Windows.
- **NPCs en dos líneas** (`render/labels.ts`): la primera el nombre (violeta
  `0xc79bff`), la segunda qué hace, más chica y más pálida (`LABEL_ROLE_COLOR`
  `0xe4d9f5`). Nunca "…": el nombre de un NPC encoge hasta el 82 % si no entra y no se
  corta; el rol, si no entra en el ancho, se parte **por sus palabras** en dos líneas
  (`wrapRole`). El texto del rol es contenido (`role` en `data/npcs`, docs/06 "NPC con
  diálogo de ventana"): el cliente lo saca del bundle de contenido (`npcRoles`,
  `client/vite/content.ts`), sin tocar el protocolo. Los nombres de los NPCs ya no repiten
  el oficio después de una coma ("Tilde Varga, provisiones" → "Tilde Varga").
- **Nombres largos** de jugadores y monstruos: una sola línea; primero encogen (hasta el
  82 %, `fitName`) y solo pasado el ancho duro (12 tamaños de letra con espacio, 7,5 cuando
  los nombres se amontonan) se cortan con "…".
- **Apilado** (`stackLabel`): sobre la barra de vida va la línea del gremio, encima el rol
  y arriba el nombre; la marca PvP queda a la izquierda del nombre y el globo de diálogo
  (UI-11) se apoya sobre el tope del bloque entero, o sea, sobre las dos líneas. Las
  reglas de solape de T5.6 cuentan el bloque completo (`nameBlockHeight`) y rigen mientras
  una casilla mida menos de 4 alturas de nombre (`labelsFull`).
- **Los números flotantes y los globos** siguen en la fuente pixel con su escala entera.
- **Tests:** `label-style.test.ts` (tamaño entero en px de dispositivo a zoom 1–4 y
  densidad 1, 1,25, 1,5 y 2; más chico que el lote 19; contraste del rol), `labels.test.ts`
  (dos líneas, sin "…" para NPCs, encoger antes de cortar, apilado con el globo),
  `packages/content-schema/src/npc-role.test.ts` y `validate.test.ts` (todo NPC de `data/`
  termina con un rol en es y en). E2E: `100-*` (el instructor a 2x y 1x, de cerca, y la
  plaza de Thimblewick con sus NPCs a 1x y 2x), `101-*` (monstruos a 2x y 4x).

### Hecho: los dos pies y huellas que borra el viento (2026-11-25, rama `feat/labels-and-steps`)
Pedido del dueño después de jugar: el paso sonaba "solo al pie derecho", las marcas eran
"de uno de los dos pies", todos los suelos sonaban igual y las huellas de la arena se
borraban por reloj. Detalle en `livingworld/README.md` ("Los dos pies" y "Huellas: qué las
borra"); en corto:
- las huellas del pie izquierdo y del derecho se dibujan en dos hileras (antes caían en una
  fila caminando al este u oeste, por el aplastado de la vista 3/4);
- cada pie suena con su voz (unos puntos de tono y volumen de diferencia), nunca la misma
  toma dos veces seguidas, y el volumen de todos los pasos es un número
  (`steps.volume` de `data/livingworld/surfaces.yaml`, 0,7 sobre 0,15);
- el sonido es el del suelo bajo ese pie, con un test que recorre el mapa real;
- una huella no tiene tiempo de vida: la borra el viento según lo expuesto del lugar (en
  la playa abierta, desde barlovento; al abrigo dura hasta el tope), la ola siguiente en
  la arena mojada, o el pie de otra criatura; las más viejas se desvanecen al pasar el tope.

### Cadáveres (hecho, 2026-11-23, rama `feat/corpse-names`)
Pedido del dueño: el cuerpo de cada bestia es único, el arte también, no solo el nombre.
- **De qué sale:** `tools/spritegen/src/recipes/corpses.ts` hace `corpses/<monstruo>`
  para cada monstruo de `data/monsters`, determinista y desde su propio arte: el último
  frame de su muerte mirando al sur (cómo cayó; el cliente dibuja la caída al sur); un
  monstruo con `look`, el humanoide del motor compuesto con sus colores en su último frame
  de morir; uno de una sola imagen (la gaviota), el sprite girado un cuarto de costado y
  aplastado a 3/5 de alto (la caída procedural de ANI-5). Después lo oscurece
  (`CORPSE_LIGHT`) y le saca un poco de color (`CORPSE_COLOUR`): sin sangre, eso lo
  ponen los efectos de golpe.
- **Una sola pasada:** el arte que dibuja el código (los frames del motor, la gaviota de
  `recipes/creatures.ts`) se toma de su receta al dibujar el cadáver, nunca del PNG
  commiteado: cambiar el spec del jabalí o agregar un monstruo del motor y correr `make
  spritegen` una vez escribe los frames y el cadáver de esos frames, en cualquier orden.
  Solo el arte que ninguna receta dibuja (los frames de Gemini, que un build no
  reescribe) se lee de `assets/sprites`. Un monstruo sin `look`, sin clip de muerte y sin
  imagen cuadrada no tiene de dónde sacar su cadáver: `spritegen check` (`checkPaths`, lo
  corre `make spritegen` al final y `make test`) lo nombra. Una imagen suelta tiene que
  ser cuadrada (`tipOver` la gira un cuarto; otra forma falla en vez de recortarse).
- **Dónde va:** del tamaño de la criatura (el custodio de 96x96 conserva su huella) y
  con su píxel más bajo donde estaban sus pies (`FEET_LINE` sobre el borde de la
  casilla). El cliente lo dibuja centrado en la casilla (`corpseArt`, ancla `bc`), así el
  último frame de la caída, que se desvanece encima, y el cadáver coinciden. Un sprite
  `br` más ancho que una casilla se ensancha para que su centro quede en la casilla.
- **Cómo llega al mapa:** los restos siguen siendo el contenedor de la familia; el item
  trae `mods.remains_of` (docs/05 "Restos") y el cliente lo apila en `MapView` con la
  clave `<item>@<monstruo>` (`state/corpse-art.ts`), cuya textura es `corpses/<monstruo>`
  si el atlas la tiene y la de la familia si no (`mapItemTexture`, `mapItemArt`). Quien
  recibe esas claves de `MapView` y solo conoce items (el mundo vivo, la elevación) les
  saca el monstruo (`plainItemKey`, `mapItemId`). El menú del click derecho muestra el
  cadáver como ícono, ajustado a 64 px: uno más grande que la caja (el custodio, 96 px)
  se achica a ella (`BigIcon` con `shrink`) en vez de salirse a 1x. Si el cliente no
  tiene el nombre del monstruo (`monster.<id>.name`), los restos se llaman como su
  familia (`instanceName`), nunca con la clave cruda.
- **Revisar:** `node --experimental-strip-types tools/spritegen/src/cli.ts corpses
  [--out FILE.png] [--scale N]`: cada monstruo de pie a la izquierda y su cadáver a la
  derecha, sobre la grilla de casillas, como los pone el cliente. Revisado el 2026-11-24
  con los 21 monstruos: todos se reconocen, con tres salvedades que la revisión de
  código anotó y quedan para una pasada de arte (el jabalí, que quedaba casi de pie,
  ya no: las dos keys finales de `death` en `specs/boar.ts` lo giran además sobre el
  eje vertical, así queda tendido de costado en las cuatro direcciones, y su cadáver
  salió solo de esos frames): la gaviota, una sola imagen girada, se lee
  poco como un ave caída (pide un clip de muerte o un spec del motor); y el gólem y el
  custodio son un montón de escoria (su último frame de muerte), casi lo mismo que el
  sprite de familia `remains_slag` salvo el tamaño.
- **La rama `br` no tiene caso real:** hoy ningún monstruo con arte más ancho que una
  casilla está anclado abajo a la derecha (todos los cadáveres miden 32, 64 o 96 px y
  son `bc`); el ensanche a `2w - 32` solo lo cubre un test sintético. El primero que
  pase por ahí hay que mirarlo en el juego contra el último frame de su caída.
- **Pendiente:** etapas (fresco, seco, huesos) a lo largo de `monster_corpse_ms` y el
  cuerpo de un jugador con su propio muñeco tendido (docs/14).

### Hecho: bandeja de estados y placa del nombre (2026-11-19, rama `feat/hud-status`, lote 13)
Lo que dijo el dueño de la prueba del 2026-11-19 (Thimblewick, build del lote 11):
"cuando tengo activado un spell debería mostrarse un ícono... al lado del chat que indique
que tengo activo o que se indiquen los estados que tiene el personaje (envenenado, fuego,
etc...)" y "me gusta la ventanita que dice el nombre y nivel pero creo que podría verse al
medio, integrada a la barra de experiencia". Antes, las condiciones eran insignias de texto
en la placa sobre el orbe de vida, con el tiempo solo en el `title`, y no las vio.
- **Bandeja de estados** (`client/src/ui/StatusTray.tsx`, estado puro en
  `client/src/state/status.ts`):
  - Un ícono por condición propia y por estado del servidor (`in_combat`, `pvp_locked`,
    `protection_zone`: docs/02 "Estados del personaje", docs/05), más el bonus de grupo
    (`party_bonus`, dos compañeros, con el porcentaje escrito en vez del tiempo: lo arma el
    cliente con el `PartyUpdate`, docs/02 "Grupos"). El orden es fijo: primero
    lo que daña (veneno, fuego, eléctrico, ralentizado), después los bloqueos de la pelea y
    la zona, al final lo que ayuda (bonus de grupo, acelerado, invisible, puntería,
    saciado); una condición que el cliente no conoce va al final.
  - Marco verde (`--ui-ok`) si ayuda y rojo (`--ui-danger`) si daña. Los segundos que
    quedan van escritos en la esquina del ícono (desde 100 s, minutos: "7m"). Parpadea en
    sus últimos 5 s (`FLASH_MS`), nunca con movimiento reducido.
  - El tooltip dice el nombre, si es ventaja o perjuicio, qué hace
    (`condition.<id>.desc`), los golpes que quedan y el tiempo. Sale con el mouse encima,
    con el foco del teclado (cada ícono es enfocable) o con un toque o un click, que lo
    abre y lo cierra (los teléfonos no tienen hover); también lo cierran una presión fuera
    de la bandeja y Escape.
  - Un temporizador la redibuja cuando cambia un segundo escrito (`nextTrayChange`): el
    servidor solo manda la lista cuando algo empieza, cambia o termina.
  - **Escritorio:** abajo a la izquierda, sobre el orbe de vida y sus pináculos (donde
    estaba la placa), a la izquierda del lugar de fábrica del chat (`--tray-w`, 132 px: el
    chat empieza 12 px después). Ninguno tapa al otro. Íconos a 2x (32 px en un marco de
    36), tres por fila; las filas crecen hacia arriba y la de abajo es la más urgente.
    Mientras se ve un tooltip, la barra sube sobre la capa de ventanas (`z-index` 21 con
    `:has`), así ninguna ventana lo tapa; si no, la bandeja va bajo las ventanas como el
    mapa.
  - **Teléfonos y tablets:** una fila en el encabezado, que sigue siendo de una línea, con
    los íconos a 1,5x (24 px) y el tooltip colgando bajo el encabezado. La fila toma el
    lugar que deja la línea, nunca menos de un ícono; lo que no entra pasa a una segunda
    línea recortada, así se ven solo íconos enteros, los más urgentes primero. En un
    teléfono vertical de 390 px entra uno; acostado o en una tablet, los diez.
  - **Íconos:** pixel art propio de spritegen, `ui/status/<id>`
    (`tools/spritegen/src/recipes/ui.ts`, `STATUS_ART`): mapas de 14x14 escritos a mano,
    contorneados a 16x16 dentro de `UI_STATUS_BOX` (8, 8, 16, 16) de un sprite de 32x32.
    Gota de veneno con burbujas, llama, rayo, caracol, bota alada, ojo tachado, diana con
    una flecha, muslo asado, espadas cruzadas de acero, candado y escudo azul con cruz.
    Nada calcado de otros juegos. El atlas suma 11 sprites de 32x32. Sin el sprite (o con
    un placeholder) la bandeja escribe la inicial del nombre.
- **Placa del nombre** (`ExperienceBar` de `client/src/ui/Vitals.tsx`):
  - Nombre y nivel ("Nivel 15") centrados sobre la barra de experiencia, en una placa de
    piedra con filo dorado parada sobre la banda de hierro, con un pináculo en cada
    hombro (reemplaza a la cresta del centro).
  - La barra (11 px) lleva escrito el porcentaje. Su tooltip (`title` y `aria-valuetext`)
    da la experiencia exacta y lo que falta para el nivel siguiente, con la curva de
    `balance.yaml experience` (`content.experience`, `client/src/state/experience.ts`, la
    misma fórmula que `content.Experience.TotalFor`); en el nivel máximo, "nivel máximo".
  - El orbe de vida queda solo. Los test ids `health`, `mana`, `level` (ahora "Nivel 15") y
    `experience` (ahora la barra) siguen; `conditions` es la bandeja. El resaltado
    `stats` del tutorial cae en la placa y la barra (`.xp`; la placa sobresale de su caja
    y hereda su contorno).
- **Vista previa:** escena `status` (diez condiciones y estados, dos parpadeando y el
  tooltip del veneno abierto) en `make ui-preview`; `game` lleva la zona de protección y la
  comida, y `danger` el veneno, el combate y una aceleración que se acaba. Se revisaron a
  1920x1080, 1280x800, 960x700, teléfono vertical y horizontal y tablet.

### Hecho: cambiar el tamaño desde las cuatro esquinas (2026-11-23, rama `feat/window-resize`)
Pedido del dueño: "que las ventanas se puedan agrandar desde sus esquinas, como en Ragnarok
Online". Solo cliente; de Ragnarok Online se toma solo la idea.
- **Las cuatro esquinas.** Cada ventana flotante tiene una zona de agarre de 12 px sobre
  cada adorno de esquina (sale 5 px del marco, como el adorno). Cursor `nwse-resize` en
  arriba a la izquierda y abajo a la derecha, `nesw-resize` en las otras dos (y en toda la
  página mientras dura). Los bordes no cambian el tamaño (decisión del dueño). Plegada, no
  tiene esquinas: solo se ve su barra.
- **Geometría** (`resizeFrom` de `client/src/ui/windows.ts`, pura): los dos bordes de la
  esquina siguen al puntero y la esquina contraria queda donde estaba; una esquina de
  arriba o de la izquierda mueve la `y` o la `x`. Los bordes que se mueven se pegan a menos
  de 10 px a los bordes de la pantalla, al techo de la barra y a los de las otras ventanas
  (de lado o alineados, solo si están cerca en el otro eje, como el imán al arrastrar);
  después nunca salen del área sobre la barra, y nunca bajan de 160x72: el borde que se
  mueve se detiene. Con la escala de la interfaz el estado guarda px de pantalla y la
  ventana recibe sus propios px (`placeStyle`). Al soltar, `settleStyle` deja escritos los
  largos del lugar nuevo, así Preact no deja vacía la `left` o la `top` que no cambió y la
  ventana no salta.
- **Se ve que se pueden tomar** sin adornos nuevos: con el puntero encima, la esquina se
  enciende con un brillo dorado suave (solo `opacity`, UI-9), y la que se arrastra sigue
  encendida mientras dura.
- **Qué ventanas:** todas las flotantes del escritorio, el chat también. Se revisó cada
  una y ninguna tiene un contenido de tamaño fijo que se rompa: la figura del equipo
  escala con el ancho (de 1x a 2x), los contenedores, la batalla, el grupo, las
  habilidades, las misiones, el gremio, la apariencia, las opciones, la ayuda, el libro,
  el diálogo, la tienda (mide sus columnas), el crafteo, el mercado, la casa, el
  intercambio y el cofre de la cuenta se desplazan adentro si quedan chicos. Tablets y
  teléfonos siguen con sus hojas y pestañas.
- **Se quitó el ✥** (decisión del dueño, le resultaba confuso): el botón de la barra, su
  teclado (flechas y Mayús+flechas), sus textos (`client.window.move`,
  `client.window.move_hint`), su ícono y su test id `window-move-<id>`. La ayuda (H)
  cuenta ahora que la ventana se arrastra por su barra y se agranda desde las esquinas.
- **Tests:** `client/src/ui/windows.test.ts` (cada esquina: `x`, `y`, ancho y alto nuevos,
  el mínimo, el área, el imán, el cursor), `client/src/ui/window-dom.test.ts` (el arrastre
  de cada esquina sobre elementos falsos con la regla de `style` de Preact, la escala de la
  interfaz, soltar sin mover) y `client/src/ui/Toolbar.test.ts` (las cuatro esquinas, sin
  ✥, ninguna plegada). E2E: el test del chat de `e2e/game.spec.ts` arrastra la esquina de
  arriba a la izquierda del chat y comprueba que su esquina de abajo a la derecha no se
  movió (screenshot `16b-chat-resized-top-left`).

## 8. Cómo se verifica
- **Arte:** `spritegen preview` y `spritepack preview`, revisados con Read **a 1x y a 4x**
  (`assets/README.md`). Un screenshot del E2E pasado a grises cumple las bandas de ART-6:
  la criatura es lo que más contrasta.
- **Screenshots del E2E** que cambian y hay que mirar:
  - `04-world`, `07-combat`, `09-inventory`, `13-dialog-window`, `14-shop`,
    `29-bosque-dock`, `46-guild-panel` y `65-volcan-temple`;
  - más los nuevos de cada tarea: ficha de item, menú del click derecho, HUD, cada
    ventana, la tienda con 24 items y el diálogo con 18 opciones.
- **Movimiento:** tests con reloj falso (MOV-1, MOV-2, MOV-5), la simulación de
  `client/src/state/walking.test.ts` y el criterio de MOV-9 (`client/e2e/movement.spec.ts`,
  con ~150 ms de latencia en el WebSocket).
- **UI:**
  - tests sin DOM de los componentes nuevos, con el mismo estilo de `ui/Guild.test.ts`;
  - los E2E de escritorio a 1280x800 y 1280x720 sin scroll en diálogo y tienda: el alto
    del contenido ≤ el alto de la ventana;
  - los E2E móviles de T5.6 sin regresiones.

## Fuentes consultadas
Consultadas el 2026-11-17. No se bajó ni se incrustó ninguna imagen de estas páginas.
- Diablo II, postmortem en Game Developer (copia):
  https://www.cs.hmc.edu/~markk/SWE_copies/postmortem__diablo_ii.html
- Diablo II: Resurrected, accesibilidad y modernización:
  https://www.gamedeveloper.com/marketing/exploring-modernity-legacy-and-accessibility-in-diablo-ii-resurrected
- Controles de Diablo II (Battle.net clásico):
  https://classic.battle.net/diablo2exp/basics/controls.shtml
- Movimiento estilo Diablo con mantener el botón (GameDev.net):
  https://gamedev.net/forums/topic/603156-walking-logic/
- OTClient, atributos de sprite (displacement, elevation, animation phases) y caminar:
  https://otland.net/threads/customized-elevation.280025/ ,
  https://otland.net/threads/fix-smooth-walking-otc.279716/ ,
  https://otland.net/threads/improved-animations-working-but-when-walking-out-animation-unsynchronizes.274294/
- Proyección oblicua y tiles de 64x64 (OpenGameArt):
  https://opengameart.org/content/oblique-projection-all-assets
- Guía de estilo derivada de LPC (perspectiva, luz, contorno, tramado, frames de 64x64):
  https://rprepository.com/help/maps-avatar-style-guide
- Universal LPC Spritesheet Character Generator (licencias por archivo, `CREDITS.csv`):
  https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator
- LPC Revised: https://github.com/ElizaWy/LPC
- Organización oficial: https://github.com/LiberatedPixelCup
- Ultima Online, guía del cliente clásico (menú, paperdoll) y menús contextuales de NPCs
  y jugadores:
  https://uo.com/wiki/ultima-online-wiki/technical/classic-client-user-guide/ ,
  https://uo.com/wiki/ultima-online-wiki/technical/previous-publishes/2001-2/2001-publish-14-14th-november/
- Old School RuneScape, menú "Choose Option" y Examinar:
  https://oldschool.runescape.wiki/w/Choose_Option
- Interpolación y buffer de entrada en juegos en red:
  https://www.gamedeveloper.com/programming/unet-unity-5-networking-entity-interpolation-part-2-of-6-clientside-input-buffering
- Fuentes: `METADATA.pb` y `OFL.txt` de cada familia en https://github.com/google/fonts
  (rutas de UI-3).
