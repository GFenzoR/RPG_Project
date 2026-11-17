# 16 — Probar el juego en la Isla de Pruebas

La **Isla de Pruebas** (`world/islands/pruebas`, 96x96 en 2048,2048; pisos 7 y 8) es un
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
el final) y el cliente (Vite, puerto 5173). Cuando los dos contestan imprime:

```
[play] ready: open http://localhost:5173/play/
```

Abre esa URL. El primer arranque tarda (compila el servidor y Vite prepara los módulos). Si
algo ya contesta en `:8080` (un `make dev` abierto, un `gameserver` que quedó vivo),
`make play` no arranca y lo dice; si el servidor se cae al arrancar, también.

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
- `PLAY_START_TOWN=puerto make play` juega el inicio normal (Puerto, con tutorial).
- Con `make dev` (que también levanta el editor y Mailpit) los personajes nuevos despiertan
  en Puerto; `RPG_START_TOWN=pruebas make dev` los manda a la Isla de Pruebas.

## 2. Cuenta y personaje
1. En `http://localhost:5173/play/`, "¿No tienes cuenta? Regístrate": cualquier email y una
   contraseña de 8 caracteres o más. Sin SMTP no se verifica nada.
2. Entra, crea un personaje (nombre y vocación) y pulsa "Jugar".
3. Despiertas en el templo de la Isla de Pruebas (2095,2086). Aquí no hay tutorial: es
   de Puerto.

Un personaje nuevo no tiene ciudad, así que despierta (también al morir) en el templo de la
isla de inicio del servidor: con `make play`, esta. El mismo personaje, con `make dev`,
despertaría en Puerto si muere o si su posición guardada no sirve.

## 3. La isla, sector por sector
Coordenadas `x,y,z`. Todo el piso 7 salvo el sótano.

| Sector | Dónde | Qué hay |
|---|---|---|
| Templo | 2091–2099 × 2084–2090 (puerta al sur) | Donde despiertas (2095,2086). **Irene Ensayo**, instructora (2093,2085): experiencia, entrenamiento, dinero, curación y una misión. Zona de protección con la plaza |
| Plaza | 2083–2107 × 2092–2103 | **Tobías Muestra**, proveedor, en el puesto del oeste (2086,2100). Tablero del mercado (2091,2103). Cartel del templo (2093,2092) |
| Caza (norte) | Corrales 2076–2119 × 2073–2079, sendero en y 2080–2081 | De oeste a este y de débil a fuerte: 1 ratas de sentina, 2 lobos, 3 jabalíes y una araña, 4 espinosos, 5 un dragoncillo de ascua. Cartel en 2084,2082 |
| Recolección y oficios (oeste) | Camino en y 2097–2098 | Cantera con vetas de hierro (2064–2071 × 2087–2094), abedules (2074–2080 × 2086–2094), taller con fragua (2070,2102), yunque (2073,2102) y fogón (2076,2102), muelle de pesca (2052–2055 × 2097–2098) con agua con peces alrededor. Cartel en 2080,2096 |
| Patio de portales (este) | 2113–2124 × 2088–2100 | Escalera (2121,2090), trampilla de la escalera de mano (2116,2090) y agujero (2119,2094). Cartel en 2114,2096 |
| Puerta con llave (este) | Puerta de práctica en 2117,2101 | Bóveda 2114–2120 × 2102–2106. Se abre con la llave de latón. Cartel en 2115,2100 |
| Sótano (piso 8) | 2110–2127 × 2088–2106 | Sala de la escalera, sala de la escalera de mano, pozo bajo el agujero con el punto de luz para subir con cuerda (2119,2094,8), cueva de murciélagos al este y el teletransporte (2113,2104,8) que vuelve a la plaza (2095,2094). Cartel en 2124,2088,8 |
| Casa (sur) | Casa de Prueba, 2086–2091 × 2109–2113 | Puerta en 2088–2089,2114; salida en 2088,2115. Alquiler: 200 de cobre por 7 días |
| Arena (sureste) | 2102–2112 × 2111–2119 | Zona `pvp`, entrada por el oeste (2101,2114–2116). Cartel en 2099,2113 |
| Muelle (sur) | 2094–2096 × 2133–2138 | **Remo Vaivén**, barquero (2097,2133): viajes de ida a Puerto, al Bosque y a la Isla Volcánica (20 monedas), donde llegan los barcos de verdad. Cartel en 2093,2132 |

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
       los corrales 4 y 5. Guardián: espada, hacha y maza 45, escudo 40 y nivel mágico 2.
       Montaraz: distancia 45, espada, hacha y maza 30, escudo 35 y nivel mágico 5.
       Arcanista y druida: nivel mágico 25 y escudo 20.
     - **"Los oficios"**: minería, tala, herrería, cocina y alquimia 25 y pesca 40. Así
       todas las recetas del juego (la más alta pide herrería 22) quedan al alcance.
   - Lo que conviene antes de cada sector: para la caza, experiencia (dos veces "Mucha" para
     el corral 4) y "El combate"; para la runa de arco (nivel mágico 1) o "mend_other"
     (nivel mágico 2, druida de nivel 8), "El combate" basta; para el yunque, "Los oficios".
2. **Tienda (plaza).** Con Tobías Muestra, "Quiero comerciar": herramientas (pico, hacha de
   leñador, caña, martillo, cuerda), galleta, cataplasma de algas, brebajes de maná (el
   común y el concentrado; "Cúrame" también llena el maná), runa de arco (pide nivel
   mágico 1: ver más abajo), el equipo de cada vocación (guardián: hacha de mano o espada
   de hierro desde el nivel 5 y escudos; arcanista: varita de chispa, o de coral desde el
   nivel 6; montaraz: arco corto y flechas, o ballesta de contrabandista y virotes desde el
   nivel 12, que deja usar escudo; druida: vara de retoño) y la llave de latón. Prueba también vender (compra pescado, mineral, troncos, lingotes y
   pieles). No vende pala: todavía no hay nada que cavar en el juego.
   - **Runa de arco:** todo personaje empieza en nivel mágico 0 y la runa pide 1. Con
     "Entréname" → "El combate" cualquier vocación pasa de 1 (la arcanista queda en 25) y la
     runa funciona en el acto, sin subir de nivel. Sin entrenar, una arcanista llega a 1
     gastando 1450 de maná (con nivel 51 le basta vaciarlo una vez con "vita lumen").
3. **Caza (norte).** Sube por el camino al oeste del templo. Empieza por el corral 1 (las
   ratas de la misión) y vuelve con la instructora para cerrarla. Sigue hacia el este solo
   si tu nivel da: el corral 5 mata a un personaje de nivel bajo. Si algo te persigue,
   vuelve a la plaza: en la zona de protección nadie ataca.
   - Lo que juegan los tests (sección 8), como referencia: corral 1, un guardián de nivel
     1 con hacha de mano; corral 2, un montaraz de nivel 8 con arco corto y flechas;
     corral 3, una arcanista de nivel 20 con varita de coral; corrales 4 y 5, un druida de
     nivel 50 que lanza "glacies hasta" (lanza de escarcha: crece con el nivel), uno por
     corral: el del 4 se trae detrás al otro espinoso, y los dos con el dragoncillo matan a
     un druida. Un guardián de nivel 21 con espada de hierro, escudo y 20 cataplasmas
     **muere** en el corral 4 con las skills en 10; **entrenado** por la instructora
     (espada 45, escudo 40) mata a un espinoso y sale vivo (`TestSandboxTraining`).
   - Los monstruos no reaparecen donde un jugador los ve: si vacías un corral, aléjate
     (unas 8 casillas al sur de su abertura basta) hasta que vuelvan.
   - Los monstruos salen de los corrales por la abertura y te siguen unas casillas por el
     sendero, pero no más allá de su correa: si te alejas, te sueltan, recuperan toda la
     vida y vuelven caminando a su corral.
4. **Recolección y oficios (oeste).** Con el pico, usa una veta (hierro y piedra); con el
   hacha de leñador, un abedul; con la caña, el agua con peces desde el muelle de pesca
   (alcance 3). Usa la fragua (2 minerales + 1 tronco = lingote), el yunque (con el martillo)
   y el fogón (pescado) para ver sus recetas. En el yunque un personaje nuevo no fabrica
   nada: su receta más baja pide herrería 2 y se empieza en 1 (sube con unos 20 intentos en
   la fragua, es decir 40 minerales y 20 troncos). Con "Entréname" → "Los oficios"
   (herrería 25) el yunque hace todo: por ejemplo, un hacha de leñador con 2 lingotes y 1
   tronco (4 minerales y 3 troncos en total, con la fragua). Las recetas no cambiaron: la
   herrería sigue empezando en 1 en el juego real.
5. **Mercado (plaza).** Usa el tablero del mercado: publica una oferta de venta y compra
   con otro personaje. El personal (GM/admin) no puede usar el mercado: prueba con cuentas
   sin rol. El intercambio directo se propone desde la lista de batalla ("Proponer un
   intercambio").
6. **Casa (sur de la plaza).** Con nivel 12 o más y dinero, usa su puerta para alquilarla;
   deja objetos adentro, invita a otro personaje.
7. **Puerta con llave (este).** Sin la llave no abre; con la llave de latón en la mochila,
   úsala para abrir y cerrar. La bóveda está vacía salvo unas cajas.
8. **Portales (este y sótano).** Pisa la escalera para bajar y la de abajo para subir. Usa la
   trampilla (click derecho) para bajar por la escalera de mano y la escalera de mano de
   abajo para subir. Pisa el agujero: caes al pozo; sal por la sala de la escalera o compra
   una cuerda y úsala sobre el punto de luz para subir. Al fondo, el teletransporte te deja
   en la plaza.
9. **Arena (sureste) y PvP.** Ver la sección 6.
10. **Barco (muelle).** "Quiero viajar" con Remo Vaivén (20 monedas). Es de ida: para volver,
    `/tp` o morir (despiertas en este templo con `make play`). Es un teleport de diálogo, no una
    ruta de barco: las rutas de verdad (con su viaje y su bloqueo de combate) se prueban con los
    barqueros del Bosque y de la Isla Volcánica, que no piden nada para volver a Puerto.
11. **Tienda cosmética.** En `http://localhost:5173/shop`, entra con tu cuenta, compra un
    paquete de nácar (proveedor falso) y un cosmético; en el juego, panel "Apariencia".

## 5. Hacerse personal (GM o admin)
Los roles los da solo el operador, con la base de datos (con `make play` corriendo o no):

```
make set-role EMAIL=tu@correo ROLE=admin NOTE="probar en local"
```

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
| `TestSandboxInstructor` | Despertar en el templo (sin tutorial), experiencia, oro, curación de vida y maná y la misión de las ratas de punta a punta |
| `TestSandboxProvisioner` | La tienda igual a `data/`, comprar (con cambio de la moneda de oro), equiparse, vender; que en ninguna tienda de `data/` se gane dinero comprando y revendiendo, tampoco pasando por una receta |
| `TestSandboxPens` | Cada corral con una vocación hasta que deja botín (ver arriba qué hace falta en el 4 y el 5) |
| `TestSandboxTraining` | El guardián de nivel 21 que muere en el corral 4 con las skills en 10 y sobrevive entrenado por la instructora ("El combate"); el entrenamiento nunca baja una skill |
| `TestSandboxTrainingByVocation` | Lo que entrena cada vocación; un druida de nivel 8 entrenado lanza "mend_other" (nivel mágico 2), que antes no podía |
| `TestSandboxTradesTraining` | "Los oficios" dejan todas las recetas de `data/recipes.yaml` al alcance |
| `TestSandboxDevOnlyOffTheSandbox` | Si la instructora no estuviera en una isla de desarrollo, el servidor no le dejaría entrenar ni llenar el maná (`dialog.dev_only`), y la opción no haría nada |
| `TestSandboxTrades` | Picar, talar y pescar con las herramientas de la tienda; fragua y fogón; ninguna receta del yunque al alcance de un personaje nuevo, y el mismo entrenado en los oficios hace un hacha de leñador en el yunque; vender lo hecho |
| `TestSandboxHouse` | Casa: nivel 12, alquiler, entrar, dejar un objeto, extraño afuera, invitada adentro que no saca nada |
| `TestSandboxVault` | Puerta de práctica sin llave, con llave, cerrar desde adentro y salir sin llave |
| `TestSandboxPortals` | Escaleras, escalera de mano, agujero, murciélagos, punto de soga sin y con cuerda, teletransporte, una galleta tirada a la escalera |
| `TestSandboxFerry` | Los tres viajes del barquero (y sin pasaje no zarpa); morir afuera devuelve a este templo |
| `TestSandboxMarket` | Una oferta de venta en el tablero, la compra de otro personaje y el retiro del buzón |
| `TestSandboxArena` | Dos personajes de nivel 20: fuera de la arena nadie ataca en modo seguro; adentro, el que pierde despierta en el templo sin perder nada y el ganador queda sin marca |
| `TestSandboxArcRune` | La runa de arco pide nivel mágico 1: una arcanista nueva no la puede usar, y recién entrenada (nivel mágico 25, sin subir de nivel) mata una rata con ella |
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

## Por qué la isla queda fuera del juego
Decisión: la Isla de Pruebas es una herramienta de desarrollo, no contenido.
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
