# 16 — Probar el juego en la Isla de Pruebas

La **Isla de Pruebas** (`world/islands/pruebas`, 96x96 en 2048,2048; pisos 7 y 8) es un
sandbox para probar a mano todos los sistemas en pocos minutos: todo queda a unos pasos del
templo, y en el templo hay una instructora que da experiencia, dinero y curación. No es
parte del juego normal (ver "Por qué la isla queda fuera del juego" al final).

## 1. Arrancar
Lo de una vez está en `12-local-development.md` ("Instalar una vez"; en Windows sin WSL,
"Windows nativo": Git Bash con el `PATH` de ese doc y Docker Desktop abierto). Después:

```
make play
```

Levanta Postgres (Docker), compila el mapa (`make mapcompile`), corre el servidor en
`127.0.0.1:8080` con `-start-town pruebas` (los personajes nuevos despiertan en esta isla)
y el cliente (Vite, puerto 5173). Cuando los dos contestan imprime:

```
[play] ready: open http://localhost:5173/play/
```

Abre esa URL. El primer arranque tarda (compila el servidor y Vite prepara los módulos).

- `make play` corre además la tienda cosmética con el **proveedor de pagos falso**
  (`RPG_ENV=development`, `PAYMENTS_PROVIDER=fake`): se compra nácar sin dinero real en
  `http://localhost:5173/shop`. Solo sirve porque el servidor escucha en `127.0.0.1`;
  nunca lo uses en un servidor al que entra otra gente.
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
| Templo | 2091–2099 × 2084–2090 (puerta al sur) | Donde despiertas (2095,2086). **Irene Ensayo**, instructora (2093,2085). Zona de protección con la plaza |
| Plaza | 2083–2107 × 2092–2103 | **Tobías Muestra**, proveedor, en el puesto del oeste (2086,2100). Tablero del mercado (2091,2103). Cartel del templo (2093,2092) |
| Caza (norte) | Corrales 2076–2119 × 2073–2079, sendero en y 2080–2081 | De oeste a este y de débil a fuerte: 1 ratas de sentina, 2 lobos, 3 jabalíes y una araña, 4 espinosos, 5 un dragoncillo de ascua. Cartel en 2084,2082 |
| Recolección y oficios (oeste) | Camino en y 2097–2098 | Cantera con vetas de hierro (2064–2071 × 2087–2094), abedules (2074–2080 × 2086–2094), taller con fragua (2070,2102), yunque (2073,2102) y fogón (2076,2102), muelle de pesca (2052–2055 × 2097–2098) con agua con peces alrededor. Cartel en 2080,2096 |
| Patio de portales (este) | 2113–2124 × 2088–2100 | Escalera (2121,2090), trampilla de la escalera de mano (2116,2090) y agujero (2119,2094). Cartel en 2114,2096 |
| Puerta con llave (este) | Puerta de práctica en 2117,2101 | Bóveda 2114–2120 × 2102–2106. Se abre con la llave de latón. Cartel en 2115,2100 |
| Sótano (piso 8) | 2110–2127 × 2088–2106 | Sala de la escalera, sala de la escalera de mano, pozo bajo el agujero con el punto de luz para subir con cuerda (2119,2094,8), cueva de murciélagos al este y el teletransporte (2113,2104,8) que vuelve a la plaza (2095,2094). Cartel en 2124,2088,8 |
| Casa (sur) | Casa de Prueba, 2086–2091 × 2109–2113 | Puerta en 2088–2089,2114; salida en 2088,2115. Alquiler: 200 de cobre por 7 días |
| Arena (sureste) | 2102–2112 × 2111–2119 | Zona `pvp`, entrada por el oeste (2101,2114–2116). Cartel en 2099,2113 |
| Muelle (sur) | 2094–2096 × 2133–2138 | **Remo Vaivén**, barquero (2097,2133): barcos de ida a Puerto, al Bosque y a la Isla Volcánica (20 monedas). Cartel en 2093,2132 |

## 4. Qué probar, en orden
1. **Instructora (templo).** Habla con Irene Ensayo (click derecho sobre ella; con el
   diálogo abierto, las teclas 1–9 eligen opción). Prueba: "Quiero experiencia" (5000 o
   50 000; dos veces 50 000 te deja en el nivel 20), "Necesito dinero" (una moneda de oro
   por vez), "Cúrame" y "¿Tienes algún encargo?" (misión "Ratas de práctica").
2. **Tienda (plaza).** Con Tobías Muestra, "Quiero comerciar": herramientas (pico, hacha de
   leñador, caña, martillo, cuerda, pala), galleta, cataplasma de algas (la curación que
   existe: no hay pociones de maná todavía), runa de arco, el equipo de cada vocación
   (guardián: hacha de mano o espada de hierro desde el nivel 5 y escudos; arcanista: varita
   de coral desde el nivel 6; montaraz: arco corto y flechas; druida: vara de retoño) y la
   llave de latón. Prueba también vender (compra pescado, mineral, troncos, lingotes y
   pieles).
3. **Caza (norte).** Sube por el camino al oeste del templo. Empieza por el corral 1 (las
   ratas de la misión) y vuelve con la instructora para cerrarla. Sigue hacia el este solo
   si tu nivel da: el corral 5 mata a un personaje de nivel bajo. Si algo te persigue,
   vuelve a la plaza: en la zona de protección nadie ataca.
4. **Recolección y oficios (oeste).** Con el pico, usa una veta (hierro y piedra); con el
   hacha de leñador, un abedul; con la caña, el agua con peces desde el muelle de pesca
   (alcance 3). Usa la fragua (mineral + tronco = lingote), el yunque (con el martillo) y
   el fogón (pescado) para ver sus recetas.
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
10. **Barco (muelle).** "Quiero viajar" con Remo Vaivén. Es de ida: para volver, `/tp` o
    morir (despiertas en este templo con `make play`).
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
2. Sube los dos personajes al nivel 20 o más con la instructora (dos veces "Mucha").
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

## Por qué la isla queda fuera del juego
Decisión: la Isla de Pruebas es una herramienta de desarrollo, no contenido.
- **Ningún barco ni portal llega a ella**: sus rutas (`pruebas_to_*` en
  `data/boat_routes.yaml`) son de ida, y ningún portal ni diálogo de otra isla lleva ahí. Solo
  se llega con `-start-town pruebas` (`make play`) o con un `/tp` del personal. Lo
  comprueban `tools/mapcli/src/world.test.ts` ("the sandbox island") y
  `server/internal/world/compile` (`TestCompilePruebas`).
- La instructora regala experiencia y dinero, y la tienda vende todo a precios normales: no
  sirve fuera de una prueba, y nadie la alcanza jugando.
- Como cualquier isla de `world.yaml`, va dentro de `world.bin` también en producción. Un
  `/tp` del personal la alcanza ahí (queda en el log de auditoría), y su casa sale en la
  lista pública de casas (`/api/houses`). Si molesta, el siguiente paso es sacarla del build
  de producción (pendiente).
- No toca `testisle`, que sigue siendo la isla de los tests y del E2E.
