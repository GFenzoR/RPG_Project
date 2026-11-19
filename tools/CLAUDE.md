# tools/ — herramientas de desarrollo e IA

## mapcli (TypeScript, usa packages/map-format)
CLI para que humanos e IA editen mapas sin abrir el editor. Toda salida es JSON por stdout
para que sea fácil de encadenar. Comandos mínimos:
```
mapcli info [isla]                         resumen: tamaño, pisos, spawns, NPCs, zonas
mapcli fmt [isla] [--check]                reescribe chunks y YAML en formato canónico
mapcli view <isla> --floor 7 --area x,y,w,h [--format text]   vista ASCII (máx. 64x64)
mapcli render <isla> --floor 7 --area x,y,w,h --out shot.png   imagen para revisar con Read
mapcli paint <isla> --floor 7 --rect x,y,w,h --ground grass
mapcli place <isla> --pos x,y,z --item oak_tree
mapcli spawn add <isla> --pos x,y,z --monster wolf --count 3 --radius 4 --respawn 60
mapcli zone add <isla> --rect x,y,w,h --floor 7 --type protection
mapcli npc place <isla> --pos x,y,z --npc harbor_master
mapcli house add <isla> --id ID --floor 7 --rects x,y,w,h --doors x,y,z --exit x,y,z --rent 500
mapcli generate <isla> --recipe island --seed 42 --size 128   generación procedural base
mapcli validate [isla] [--format text]     mismo validador que el editor y la CI
mapcli patch create|apply|diff             trabajar con map patches
mapcli ops apply ops.json                  aplica una lista de operaciones en lote
mapcli pr-check --base REF --head REF --out DIR   check de PR de mapas (T2.4, docs/04)
```
Todos existen desde T1.15 (además `erase`, `fill`, `remove`, `autoborder`, `stamp`); la
lista exacta de opciones está en `mapcli` sin argumentos. Los comandos de edición aceptan
`--dry-run` y escriben solo los archivos tocados.
Se ejecuta desde la raíz (`--root` para otra) con
`node --experimental-strip-types tools/mapcli/src/cli.ts <comando>`; el flag hace falta en
Node 22.13–22.17 (desde 22.18 los tipos se quitan sin él). `make validate` lo usa así.
`mapcli render` es clave para la IA: después de editar, renderiza el área y revisa la
imagen con la herramienta Read.

## mcp-world (servidor MCP, TypeScript)
Expone las mismas operaciones de map-format como herramientas MCP (`map_info`, `map_view`,
`map_render`, `map_apply_ops`, `map_validate`, `map_find`, `content_search`,
`map_patch_create`). Se registra en `.mcp.json` (servidor `rpg-world`) para que Claude Code
lo use directamente; a mano: `node --experimental-strip-types tools/mcp-world/src/cli.ts
[--root DIR]`. Límites y detalle en `docs/04-map-editor-and-ai.md`.

## map-pr-worker (TypeScript, T4.5)
`tools/map-pr-worker`: abre un PR por cada envío aprobado del portal de mapas. Toma la cola
de `map_submissions` (`src/queue.ts`, contrato en la migración 00010), mezcla el patch sobre
la rama base actual con `mergePatchFile` de `packages/map-format` (`src/build.ts`, puro:
también repite rutas y parcelas y arma los textos) y escribe con la API Git Data
(`src/github.ts`). `src/worker.ts` hace los pasos idempotentes: PR existente (con la marca del envío) → rama
existente (con sus trailers) → construir. Un rate limit o un error de configuración (401/403/404)
pausan todo el worker sin gastar intentos (`pausedUntil`); al arrancar, `checkIdentity` se
niega a usar el token del dueño o de un maintainer; sin token queda inactivo hasta SIGTERM
(el temporizador de la espera está ref'd: un pool pg ocioso no mantiene vivo a Node);
`--self-check` es el smoke de la imagen. No expone puertos; config por entorno (`src/config.ts`, docs/09). Tests:
`src/*.test.ts` contra `test/fake-github.ts` (un GitHub en memoria, también lo usa el E2E
de `client/e2e/maps.spec.ts`) y `queue.integration.test.ts` con Postgres
(`MAP_PR_WORKER_DATABASE_URL`, `make test-integration`). Nunca loguees el token ni metas un
merge propio: si el formato cambia, se cambia en `packages/map-format`.

## bots (Go)
`tools/bots` (T1.17): prueba de carga con clientes headless (`server/pkg/bot`) que se
registran, crean personaje y juegan en la Isla del Puerto: caminan con rutas A* sobre
`build/world.bin` (`bot.Nav`, que rodea escaleras, agujeros y teletransportes: cada bot
queda en su piso), atacan monstruos, hablan por chat y abren diálogos con NPCs, con su
propio rate limit (`-min-gap`). Sin ese archivo (`-world`; p. ej. `make bots URL=...`, que
no corre `make mapcompile`) caminan al azar: no saben dónde hay portales, así que pueden
pisar una escalera, un agujero o un teletransporte y cambiar de piso o de lugar.
Escenarios en `cmd/bots/scenario.go`: `base` (repartidos por la isla) y `stress` (todos en
la ciudad). Reporte JSON (`-report`) y
resumen Markdown con tick, RAM, CPU (de `/metrics` del servidor), latencia de comando
(Ping→Pong), bytes por jugador y desconexiones, comparados con `docs/07`. `make bots N=100`
levanta su propio servidor (`loadtest.sh`); con `URL=` juega contra uno existente. Sale
con código 1 si algún bot no entra o se desconecta. Al final cada bot sale como un jugador:
espera el bloqueo de logout de su última pelea (`logoutWait`); uno que a los 45 s sigue en
combate cierra la conexión y queda link-dead (`left_link_dead` del reporte, no es error). `-profile human|mechanical` (T4.1) les da
el ritmo de los perfiles de `server/pkg/bot` (los mismos del test de la detección de bots):
el humano varía, hace pausas y contesta los chequeos de presencia; el mecánico no.

## gemini (Python, solo desarrollo)
`tools/gemini` maneja la app web de Gemini **en el Chrome del dueño** para pedir arte y
música, y trae lo que devuelve a nuestra grilla, paleta y formato de audio. Es un port de
las herramientas de Ants of Neque (el otro juego del dueño, misma cuenta), que ya están
probadas: se queda en Python. Nunca es dependencia del juego, del servidor ni del cliente.
Desde el 2026-11-17 el dueño permite usar lo generado con su Gemini (docs/17 SRC-5): el
prompt describe contenido propio y **nunca nombra otro juego, artista ni obra**
(`prompt_guard.py` lo frena), y lo que se usa va en `assets/CREDITS.md` ("Generado con IA")
con un prompt commiteado (`credit.py`). **Una referencia (`--ref`) es solo un archivo
commiteado en `assets/` del repo, ya acreditado** (arte propio o de un pack de
`CREDITS.md`): la subida es parte del pedido tanto como el texto, y con `--edit` se pide
algo parecido a ella. Los drivers rechazan cualquier otra (`prompt_guard.ref_record`), el
sidecar la guarda con su ruta y su sha256, y `credit.py` la escribe en el archivo de
prompt y en la fila (y no acredita un pedido cuya referencia no esté en el repo tal como
se mandó). Flujo completo en `assets/README.md`, "Arte y música hechos con Gemini".

**El navegador es del dueño.** Las herramientas se conectan por CDP a un Chrome que el
dueño abre él mismo:
`chrome.exe --remote-debugging-port=9222 --user-data-dir=%USERPROFILE%/chrome-gemini`
(un perfil propio: Chrome 136 no abre el puerto en el perfil por defecto). El puerto
escucha solo en 127.0.0.1, pero mientras ese Chrome está abierto cualquier proceso local
puede manejar la sesión de Google que tiene iniciada: el dueño lo cierra al terminar de
generar (las herramientas no lo hacen por él). **Nunca inician
sesión, su código nunca lee, copia ni guarda cookies, y nunca abren ni cierran ese
Chrome**: abren una pestaña propia, cierran solo esa y se desconectan. Si no está abierto,
se dice y se sigue con otra cosa. Una salvedad: una imagen o un tema con dirección
`http(s)` se baja con la API de requests de Playwright del contexto conectado
(`page.request.get`), que toma las cookies de ese contexto por CDP y las manda con ese
pedido desde el lado de Playwright (Node), no desde la página. Nada nuestro las ve ni las
guarda. Un `blob:` se lee dentro de la página.

```
pip install -r tools/gemini/requirements.txt       Pillow, Playwright (sin bajar navegador), imageio-ffmpeg
python tools/gemini/gemini_web.py check [--list-modes]       solo lectura: ¿conectado, con sesión, en qué modo?
python tools/gemini/gemini_web.py image "<prompt>" --name N [--ref assets/....png] [--out-dir DIR]
python tools/gemini/music_web.py ask "<prompt>" --name N [--out-dir DIR]   |   fetch <url> --name N
python tools/gemini/music_queue.py run|status [--slots a,b] [--takes 2] [--into DIR]
python tools/gemini/music_style.py <tema>|--all      el prompt con que se pide cada tema
python tools/gemini/import_art.py <hoja.png> --grid 4x2 --size 32 --layer creature --prefix walk_s
python tools/gemini/import_art.py <hoja.png> --cut rows|blobs --size 64 --names "walk_s_0,-,idle_s_0+attack_s_0,..."
                                  [--mirror walk_w_0,...] [--shared-colours] [--scale 4.6]
python tools/gemini/music_convert.py <tema.mp4> [--no-loop] [--kbps 32] [--lufs -14] [--channels 1] [--max-seconds 72]
python tools/gemini/music_import.py [--from build/music-gemini]   = make music-gemini (las elecciones al juego)
python tools/gemini/anim_sheet.py <carpeta> --out hoja.png   hoja de contacto para revisar con Read
python tools/gemini/credit.py <sidecar.json> --asset assets/...   prompt commiteado + fila de CREDITS
make test-gemini                                     tests (Python 3.10+ y Pillow; ffmpeg opcional)
```
Las salidas van por defecto a `build/gemini/{art,music,import,convert,music-import}/` (no
se commitean); todas aceptan otra carpeta. Escriben en `assets/` solo `credit.py` (el
archivo de prompt de `assets/prompts/`) y `music_import.py` (`make music-gemini`), que pone
en el juego **lo que el dueño ya eligió** en `build/music-gemini/picks.json`: los frames se
copian a mano después de mirarlos, y ningún tema entra sin que el dueño lo haya escuchado
(un lugar sin elegir suena con su toma 1 marcada `provisional`).

**Lo que cambió en la web de Gemini (verificado el 2026-11-17):**
- **Modos:** el menú ofrece "Ayuda todos los días 4 Hydrogen", "Código y análisis 4 Argon"
  y "3.5 Flash-Lite" (más "Nivel de pensamiento": bajo, medio, alto). La música sale en
  Hydrogen, con Argon de reserva. Los modos **no están fijos en el código**: `--modes` o
  `GEMINI_MODES` dan la lista por preferencia (expresiones contra las etiquetas del menú;
  por defecto `Hydrogen,Argon`, `page_rules.DEFAULT_MODES`). Un Lite nunca sirve: apaga las
  herramientas de imagen, música y video.
- **Herramientas:** "Crear música", "Crear imagen", "Crear video", "Canvas" y "Deep
  Research", en "Cargas y herramientas", son `<gem-menu-item role=menuitemcheckbox>`, no
  botones (`gemini_web.CLICK_TOOL_JS`).
- **Imagen (verificado el 2026-11-18, diez pedidos):** `image` elige "Crear imagen" en
  Hydrogen y la hoja llega en ~30 s, una sola imagen de 1024x572 a 765x1024 (el formato lo
  elige Gemini); ninguno topó con la cuota. Ni los trece de la segunda tanda (ese mismo día,
  uno tras otro, tres con `--ref`).

**Lo que se mantiene de Ants of Neque (cada regla costó pedidos reales):**
- **Se detecta el medio, nunca se cree el texto:** la respuesta puede decir "solo genero
  texto" con el tema justo debajo. El texto solo se lee para decir *por qué* no llegó nada
  (`page_rules.classify`: `quota`, `masked`, `policy`, `error`, `nothing`).
- **Un solo driver en el navegador** (`browser_lock.py`): un archivo en la carpeta temporal,
  **el mismo que usa Ants of Neque**, porque el Chrome es uno solo para los dos proyectos.
- **El compositor se vacía y se relee antes de cada pedido:** Gemini devuelve una pregunta
  no enviada como borrador en el chat nuevo; si el compositor no queda con el prompt exacto,
  el pedido termina `not_sent` sin apretar Enter.
- **La cuota no se martilla:** una hora de reinicio dicha por la página o por el menú
  ("El límite se restablece el 18 nov, 11:53 p.m.") va al sidecar (`reset`) y la cola duerme
  hasta ahí (`--max-sleep` la limita), nunca menos de 10 min (`QUOTA_MIN_SLEEP`: el menú
  puede nombrar una hora que ya pasó), y 3 respuestas de cuota seguidas cortan la corrida
  (`QUOTA_LIMIT`); se pacea por la ventana medida (~7 temas por hora); un
  `masked` (la respuesta de "soy un modelo de lenguaje") en un modo pasa al siguiente de la
  lista; atascos y pedidos sin enviar tienen tope y enfriamiento, y tras un `nothing` o un
  `error` el siguiente pedido espera 10 min (`--nothing-cooldown`). Una cola dormida sigue
  entregando: si se rechaza lo que trae, hay que matar su proceso además de borrar los
  archivos.
- **Un sidecar JSON por salida** (`<nombre>.json`): prompt, referencias, modo, resultado,
  segundos, conversación, respuesta, y para un tema su título, duración y sha256. Se escribe
  también al fallar (también con el navegador ocupado: `busy`), y apenas el pedido sale,
  para poder hacer `fetch` si el driver muere. Un `fetch` que no llegó a leer la página
  (Chrome cerrado) deja `fetch_error` y no pisa el resultado del pedido.
- **Mientras la página trabaja, solo corta la espera un rechazo que no puede ser la
  descripción del tema** (`page_rules.ends_wait`): política, error o una cuota dicha como
  tal ("el límite se restablece", "has alcanzado el límite"). Gemini escribe un resumen del
  tema mientras lo hace, y un "limited percussion" en él cortaba la espera a los 50 s.
  `QUOTA_WORDS` va por palabras enteras (`límite` ya no se encuentra en "limited").
- **Un menú de modos vacío o renombrado es la página que cambió, no la cuota:** el pedido
  termina `not_sent` y dice que se mire `gemini_web.py check --list-modes`.

**Arte (`import_art.py`):** fondo magenta (por tono, con el borde rosado reparado) o el alfa
de la hoja. La clave por tono se lleva también los violetas y rosas del dibujo, así que
`HOUSE_RULES` prohíbe magenta, rosa, púrpura y violeta en el sujeto; un sujeto violeta
tiene que venir con su propio alfa (`--key alpha`). Grilla cortada en frames (avisa si otra grilla con los mismos frames corta
menos dibujo; `--auto-grid` la toma); una caja común para todos los frames de una animación;
escala por vecino más cercano a `--size` (32, o 64 para personas, ART-2) apoyado abajo y
centrado; colores reducidos (`--colors`) y llevados a la paleta de spritegen (se lee de
`tools/spritegen/src/palette.ts`) dentro de la banda de L* de ART-6 de `--layer` (`ground`
20–50 con C* ≤ 35, `wall`/`object` 25–65, `creature`/`character` 10–85, `effect` 60–100);
en `creature`, `character`, `object` y `wall`, los píxeles más oscuros que la banda pasan a
contorno (los contornos de spritegen, calculados como su `darken`, ART-5); en `ground` (ART-5:
"suelos: sin contorno") y `effect` se llevan a la banda como el resto. Alfa 0 o 255. Escribe los frames, `_preview.png` (revisar con Read) e `import.json`.
Una hoja de criatura no vuelve en la grilla pedida (filas de 7 sobre filas de 6, dos
paneles): `--cut rows` toma las filas como vinieron (cada fila en partes iguales si sus
dibujos caen una en cada parte, ensanchadas lo que sobresale el más ancho, con los vecinos
borrados; todas las filas a una escala) y `--cut blobs` cada dibujo suelto (rótulos por
bloques de `BLOB_BLOCK` px, las partes chicas con el dibujo más cercano, en orden de
lectura, cada uno centrado en su masa: `massed`). Con las dos, `_drawings.png` numera los
dibujos para escribir `--names` (`-` descarta, `a+b` guarda uno como dos frames),
`--mirror` espeja frames, `--shared-colours` reduce los colores de todos juntos
(`reduced_together`: de a uno titilaban) y `--scale` fija la escala. El `import.json` guarda
los nombres, lo espejado y la escala forzada, y `credit.py` sobre ese `import.json` escribe
en el archivo de prompt la hoja (sha256) y el comando que la cortó (`import_command`).
Flujo y lecciones de las siete criaturas: `assets/README.md`, "Criaturas animadas de una
sola hoja".

**Música (`music_convert.py`):** MP4/AAC (o lo que lea ffmpeg) a Ogg Opus 48 kHz con el
ffmpeg del PATH (el de `make sounds`) o el de `imageio-ffmpeg`: corta los fades, cierra el
bucle con un crossfade de potencia constante de la cola sobre la cabeza, normaliza con **una
sola ganancia** a **-14 LUFS** sin pasar -1,5 dBTP (medida con `loudnorm`; una ganancia que
varía rompería la costura) y, como el códec puede escalonar una costura limpia, rota el
bucle de a 97 ms hasta que la costura codificada sea ordinaria (`seam_turns` en el JSON).
`--max-seconds` corta un loop más corto (`loop_length`: entre 0,75 N y N segundos, donde
lo que sigue al corte se parece al comienzo en la ventana del crossfade: ataques en fase, la
misma curva de energía y el mismo nivel). **Desde el 2026-11-18 el juego no usa loops**:
`--no-loop` (`loop=False`, lo que usa `make music-gemini`) deja el tema entero, sin cortes,
con una sola ganancia, y mide sus puntos de entrada (`entry_points`: sobre la envolvente de
nivel cada 0,1 s, donde sube una frase después de un respiro; nunca antes de
`ENTRY_HEAD` = 10 s, a `ENTRY_GAP` = 15 s o más uno de otro, nunca en los últimos
`ENTRY_TAIL` = 30 s del cuerpo, hasta `ENTRY_MOST` = 8), dónde termina el cuerpo
(`body_end`) y su hueco más largo (`longest_quiet`); `piece_problems` dice si puede sonar
(2 minutos o más, volumen medible, ningún hueco de más de 6 s, al menos 2 entradas). Los
masters de Gemini vienen calientes (+1,5 a +5 dBTP): el techo de pico puede dejar un tema
bajo -14 LUFS (los enteros en estéreo del 2026-11-18 quedaron entre -14 y -15).
**-14 LUFS es el objetivo de toda la música del juego:** los temas de soundgen miden -11,3
(bosque), -13,7 (puerto), -14,2 (volcán) y -15,8 (cueva), unos -14 en promedio; a -18 un
tema de Gemini sonaba ~4 dB más bajo. El test `TheGameMusic` mide los `.ogg` de
`assets/sounds/music/` (los de soundgen, no la carpeta `gemini/`) contra
`music_convert.LUFS` (si hay ffmpeg): un tema nuevo de cualquier origen tiene que quedar
cerca; uno de Gemini que el techo de pico deja más bajo lo compensa con el volumen.

**De las elecciones al juego (`music_import.py`, `make music-gemini`):** lee `picks.json`
(una toma, una lista de tomas, `none` u `off`; un lugar sin elegir = toma 1 provisional;
`combat` solo `none`/`off`; `cave_pool` = las versiones extra de cueva, y sin ella entran
como provisionales las de `Slot.extras` que pasan `piece_problems`), convierte cada toma
entera en estéreo (`KBPS` = 48, `AMBIENT_KBPS` = 40 para las cuevas; las ya convertidas
con los mismos ajustes, `ANALYSIS` y los `ENTRY_*` incluidos (`entry_settings` en el
registro; uno de antes cuenta con los de `ANALYSIS` 1), se reusan desde
`build/gemini/music-import/`),
las copia a `assets/sounds/music/gemini/<lugar>_<toma>.ogg`, reescribe sus líneas de
`assets/sounds.yaml` entre las marcas `# gemini-music:sounds:…` (cada tema con `seconds`,
`end` y `entries`), `:pools:…` (la pool de cada lugar) y `:rules:…` (`title` y `bosses`,
que nombran pools), escribe el archivo de prompt y la fila de `CREDITS.md` de cada toma
(`credit.prompt_text`, `credit.credits_row`; el título es el que dio Gemini, o el nombre
de su archivo escrito como título: `the_sunless_vault` es «The Sunless Vault», `title_case`), el manifiesto
`assets/sounds/music/gemini.yaml` (`format: 2`), borra lo que ya no suena, y `make` revisa
el presupuesto (`tools/soundgen check`, también por pool). El volumen en `sounds.yaml`
(`volume_for`) devuelve lo que el techo de pico le quitó, hasta 1 (ffmpeg mide un mono como
dos parlantes: un tema estéreo y uno mono de soundgen al mismo LUFS suenan igual).
`none` vuelve al tema de soundgen del lugar (`Slot.fallback`): por eso esos temas y sus
recetas siguen en el repo. Las tablas de lugares (`SLOTS`: sonido, regla, tema de soundgen)
y de nombres (`ALIASES`: la toma 3 de Puerto es `probe_1`) están en el script.

**Tests:** `make test-gemini` (unittest; claves, cortes, escala, paleta y bandas, costura,
crossfade, ganancia, lectura de respuestas y del menú, la regla del prompt, el candado, la
cola contra un Gemini falso, y una conversión real si hay ffmpeg con libopus). No están en
`make test` (para no exigir Python al resto); la CI los corre en el job `gemini` cuando
cambia `tools/gemini/`, `tools/spritegen/src/palette.ts` (la paleta que lee `import_art`) o
`assets/sounds/music/`.

## soundgen
`tools/soundgen` (T3.7) genera los efectos, la música y el ambiente propios de
`assets/sounds/`. Es un sintetizador determinista en TS (`synth.ts`) con las recetas en
`sfx.ts` y `music.ts`, y encoda a Ogg Opus con ffmpeg. Uso: `make sounds` (o
`ONLY=sfx/hit`). `cli.ts check` solo revisa el presupuesto de tamaño. Los `.ogg` se
commitean. Cómo cambiar a un pack de terceros: `assets/README.md`, "Sonido".

## spritegen
`tools/spritegen` (T0.5) dibuja el pixel art propio en `assets/sprites/<ruta>.png` a partir
de recetas en código: `src/recipes/{terrain,ground,walls,trees,props,portals,items,creatures,effects,ui}.ts`
(`ground.ts`: suelos con sus looks y el agua y la lava animadas; `walls.ts`: las 16 piezas de
cada muro y las puertas metidas en él; `trees.ts`: árboles y arbusto con viento y sombra;
`props.ts`: fragua, fogón, antorcha, estandarte, brasero y fuente animados; `portals.ts`:
escaleras de mano, agujeros, puntos de soga y teletransportes; arte del mapa en
`assets/README.md`, "Arte del mapa"), con la paleta de
materiales de `src/palette.ts` (4 tonos + contorno) y las primitivas de `src/draw.ts`
(rect, line, disc, polygon, box en 3/4, contorno automático, luz desde arriba a la
izquierda, ruido con semilla que hace mosaico). Determinista: la semilla sale de la ruta.
Uso: `make spritegen` (o `ONLY=decor/`) y luego `make sprites`; para mirar el resultado,
`node --experimental-strip-types tools/spritegen/src/cli.ts preview --out shot.png --scale 4
[--only decor/]` y revisa la imagen con Read (suelos en 3x3, objetos sobre pasto). `check`
exige que cada receta sea una ruta usada en `data/` (o un frame de animación
`<sprite>/<acción>_<dir>_<n>` de un sprite que `data/` usa, como los del jabalí, o de
efecto `effects/<nombre>/<n>`, sin huecos en la tira, o arte de proyectil de `kind: effect`
que el cliente busca por ruta (`MISSILE_ART`, nada más: la flecha `missiles/arrow/{e,se}`
y, por elemento con orbe, `missiles/<elemento>/<n>` hasta `MAX_ORB_FRAMES` - 1 y
`missiles/<elemento>/trail`), o un icono de interfaz
`ui/<grupo>/<id>` de `kind: ui`, como las marcas PvP que el cliente busca por ruta, o una
parte de arte del mapa `var_<n>`, `frame_<n>`, `wall_<m>` o `shadow` de un sprite que
`data/` usa). Un test exige además a cada suelo una media de L* entre 20 y 50 (docs/17
ART-6; la lava no). El
preview pone cada tira de efecto en su propia fila, sobre el jabalí parado. Los atuendos y
los NPCs humanos ya no son de spritegen: son personajes de LPC (`assets/sprites.yaml`
`animations`). Toda receta `kind: creature` sale con la sombra proyectada de Dungeon Crawl
(`castShadow`, al final de `render`), salvo las de `shadow: false`: las del motor (abajo),
de 64x64 sobre la sombra de contacto del renderer como los animales de Gemini (docs/17
ART-2, "Animales medianos"). Los PNG se commitean y el test exige que coincidan
con las recetas. Estilo, sombra e iconos:
`assets/README.md`, "Arte propio (spritegen)". Desde el 2026-11-18 una parte de las
recetas sale del **motor de sprites** (`src/engine/`, siguiente sección): el jabalí, el
ciervo, el eco de la forja, el yunque, el cajón, el tablero del mercado y el cartel; desde
el 2026-11-19 también los restos de los monstruos (`specs/remains.ts`: uno por familia y
`creature_remains`, objetos de 32x32 dibujados con sus proporciones y agrandados con
`grow`, `specs/grow.ts`, hasta 24-30 px de largo), los íconos de todo el equipo
(`specs/items/`, clase `icon`; abajo, "Íconos de items") y el libro, el atril, el
pergamino y el cofre de recompensa (`specs/lore.ts`, docs/02 "Libros y cofres").

## spritegen: el motor
`tools/spritegen/src/engine/` (docs/17, "Motor de sprites", con cada regla atada a su
referencia) dibuja sprites a partir de un **spec**: un modelo chico hecho de primitivas con
volumen, en los materiales de `palette.ts`, y para una criatura un **rig** de acciones con
keyframes. Las reglas de estilo (cámara, luz, tonos, contorno, tamaños y anclas de ART-2,
frames y tiempos de ANI-2) están como datos en `engine/style.ts`; ningún spec las repite.
Cada frame de un spec es una receta más (`engine/book.ts` la suma a `RECIPES`), así que
`make spritegen`, `ONLY=<prefijo>`, `check` y el test de los PNG commiteados valen igual.

| Archivo | Qué hace |
|---|---|
| `style.ts` | ART-1 a ART-8 y ANI-1 a ANI-4 como datos: `PROJECTION`, `LIGHT`, `SHADES`, `GLOW`, `OUTLINE`, `CREASE_DEPTH`, `RIM_LIGHT`, `VALUE_BAND`, `SIZES`, `ACTIONS`, `FACING_YAW`, `frameName`; `GLOW_OUTLINE`, el contorno del fuego |
| `spec.ts` | Los tipos del spec y `validateSpec` |
| `shapes.ts` | Las primitivas: dónde las corta un rayo y su normal |
| `render.ts` | `renderSpec`: rayos con buffer de profundidad, sombreado, limpieza, pliegues, borde iluminado, marcas y contorno |
| `rig.ts`, `motion.ts` | Poses por keyframe, articulaciones, las cuatro direcciones; helpers (`trot`, `keys`, `mergePoses`) |
| `gates.ts`, `check.ts` | Las puertas de calidad y las pistas de `assets/sprites.yaml` |
| `sheet.ts` | Hoja de contacto y lineup para revisar |
| `specs/` | Los specs del juego; `specs/index.ts` (`ENGINE_SPECS`) los registra; `specs/items/` los íconos de equipo; `specs/grow.ts` agranda un spec entero |

**Escribir un spec** (ejemplos: `specs/boar.ts`, `specs/stag.ts`, `specs/forge-echo.ts`;
objetos: `specs/anvil.ts`, `specs/crate.ts`, `specs/signpost.ts` y `specs/market-board.ts`,
este con un `loop`). Unidades: píxeles de sprite; x al este, y al norte (lejos de la
cámara), z arriba; el suelo es z = 0.
- `sprite`: la ruta de `data/` (`creatures/<id>`, `npcs/<id>`, `decor/<id>`).
- `size`: la clase de ART-2 (`smallCreature`, `mediumAnimal`, `humanoid`, `bigCreature`,
  `object`, `icon`): da el lienzo, el ancla, la fila del suelo, la banda de valor y el
  contorno.
  `canvas` elige otro lienzo de la clase; `figure: { height, width }` angosta los rangos
  (de perfil, con el contorno).
- `parts`: cada parte tiene `name`, `material` (de `PALETTE`), `shapes` y, si cuelga de
  otra, `parent` (declarada antes) y `at` (su articulación en el marco del padre; para una
  raíz, en el del modelo). `rot` es su giro de reposo en grados (x, después y, después z).
  Opcionales: `bias` (más claro u oscuro), `texture: { amount, cell }` (ruido en el marco
  de la parte: celdas largas en un eje hacen pelo o vetas), `shiny` (brillo especular),
  `glow` (fuego: brilla de frente, sin sombra, con su propio contorno, `GLOW_OUTLINE`: el
  tono `deep` arriba y a la izquierda, `outline` del otro lado y un pliegue en `shadow`
  donde otra parte encendida lo tapa; un fuego que se lea pide un material con el núcleo
  casi blanco y el `deep` rojo, como `fireCore` y `flame`) y `marks` (píxeles sueltos:
  ojos, fosas, bayas; se ven solo si nada los tapa).
- `shapes` (en el marco de la parte; cada una puede cambiar `material` y `bias`):
  `ellipsoid { center, radii }`, `box { min, max }`, `cylinder { a, b, radius }`,
  `capsule { a, b, radius, radius2 }` (se afina de `radius` a `radius2`: patas, cuellos,
  colas, cuernos, llamas), `extrusion { points, axis, from, to, bulge }` (un perfil
  barrido: con `axis: "y"` los puntos son `[x, z]` vistos de frente; `"x"`, `[y, z]` de
  costado; `"z"`, `[x, y]` desde arriba) y `polygon { points, axis, at, thickness, bulge }`
  (una tarjeta fina; `bulge` la sombrea como si fuera curva).
- Una **criatura** se arma mirando al oeste (el hocico hacia -x), con el origen en el
  centro de sus patas sobre el suelo: el motor la gira para cada dirección y dibuja las
  cuatro (no hace falta `mirror`). Un **objeto** se arma como se ve, con el origen en el
  suelo, en el centro de su casilla.
- `flying: true` si flota (el cliente lo mece); `seenOn: "ground/dirt"` es el suelo de su
  lineup de revisión (el de donde está en el mapa); `views: { w: 20, e: -20 }` gira un poco
  una dirección hacia la cámara (+ en el oeste, - en el este): una figura de costado muestra
  la cara y lo que lleva en la mano del lado lejano (el eco de la forja).
- `loop` (solo objetos, ART-7): `{ frames, ms, sync, keys }` hace de un objeto un prop
  animado. El sprite es el frame 0 y `<sprite>/frame_<n>` los demás: los nombres que
  spritepack ya arma como tile animado (como la fragua o el estandarte de
  `recipes/props.ts`), así que el cliente lo juega sin cambios. Las keys son las de una
  acción en bucle (el frame f en f/frames, de la última key vuelve a la primera);
  `frames` de 2 a 8 y `ms` de 80 a 900 (`LOOP` de `style.ts`, la tabla de ART-7); `sync`:
  `world` (todos en fase), `tile` (cada casilla con su fase) o `random`. Ejemplo: la nota
  del tablero del mercado que se levanta con el viento (una parte colgada de su chinche:
  `at` en el chinche, y un giro en x le levanta el pie hacia la cámara).

**Escribir un rig:** `actions` con `idle` y `walk` como mínimo, y `attack`, `shoot`,
`cast` o `death` si los usa (un NPC: solo quieto y caminar). Cada acción tiene `frames`
(rango de ANI-2), `ms` por frame (menos `walk`, que va por distancia: 2 frames por
casilla), `keys` y, opcional, `dirs`. Una key es `{ at, pose }`: `at` de 0 a 1 y `pose`
por parte `{ rot, move }`, relativo al reposo; `"*"` mueve el modelo entero alrededor de su
origen (un salto, una embestida, la caída). Un bucle (`idle`, `walk`) toma el frame f en
f/n y vuelve de la última key a la primera; una acción de una vez (atacar, morir) va de la
primera key (frame 0) a la última (frame n-1). Lo que no está en una key queda en reposo.
- Convenciones: con la criatura mirando al oeste, `rot: [0, +θ, 0]` lleva hacia adelante
  lo que cuelga (una pata) y hacia atrás lo que sube (un cuello); `rot: [θ, 0, 0]` la
  rueda sobre su largo (morir de costado: `"*": { rot: [-90, 0, 0] }` y un `move` que la
  vuelva a centrar y la apoye en el suelo).
- `trot({ legs, swing, lift, bob, extra })` arma un trote de 4 frames en pares diagonales;
  `keys([at, pose], ...)` y `mergePoses` ahorran texto.
- Errores comunes que atrapan las puertas: bajar `"*"` hunde las patas bajo el suelo y
  recorta el frame (mejor doblar las patas); una caída gira lo alto hacia la cámara en
  alguna dirección (recentrar con `move`, recoger la cabeza).

**Registrar y generar:** el spec va en `specs/index.ts`. Una criatura necesita su entrada
en `animations` de `assets/sprites.yaml`: `{ anchor: bc, shadow: ellipse, ms: { idle: N,
attack: N, death: N } }` con los `ms` del rig (y `flying: true` si flota), sin `facing` ni
`mirror`, y ninguna entrada en `sprites` (los píxeles son archivos). Un objeto con `loop`
necesita su entrada en `tiles` con los mismos `ms` y `sync` (`decor/market_board: { ms:
180, sync: tile }`); uno sin `loop`, ninguna con `ms` ni `sync`. Si reemplaza arte viejo,
se borran sus PNG (y su receta, con los imports que dejen de usarse). Después `make
spritegen ONLY=<sprite>/` (o el prefijo) y `make sprites STRICT=1`.

**Íconos de items** (`specs/items/`, docs/17 "Íconos de items"): cada arma, escudo,
armadura, joya y munición de `data/items` es un `icon` (32x32, el origen del modelo en el
centro del lienzo, sin fila de suelo; tipo `item`: contorno oscuro y la banda de valor de
los objetos; recetas de `kind: item`). `kit.ts` tiene lo que comparten: `icon(sprite,
parts, { scale })` arma el spec y lo centra (`centred`: mueve las raíces de a píxeles
enteros hasta que la caja de la figura quede en el medio), `resized` agranda o achica una
línea entera, `lean` inclina un arma 45° (la cabeza arriba a la derecha), `blade` hace una
hoja de dos placas (mitad iluminada y mitad en sombra), `plate` una tarjeta de frente
(`bulge` la redondea), `tube` un tubo de cápsulas por una polilínea (arcos, cordones,
anillos), `arc`, `ellipse` y `mirrored` perfiles, `moved` corre una figura (la segunda
bota), `gem` y `rivets`. `weapons.ts`, `armor.ts` y `jewelry.ts` tienen un constructor por
línea y una llamada por banda; `index.ts` da `ITEM_ICONS` y `ICON_ROWS` (las filas de la
hoja: una por línea, una columna por banda). Una pieza nueva: su `sprite: <categoría>/<id>`
en `data/items`, una llamada al constructor de su línea con el material y el acento de su
banda (la tabla de docs/17), en su fila de `ICON_ROWS`; `make spritegen ONLY=<ruta>`, `make
sprites STRICT=1` y revisar la hoja. `engine/items.test.ts` exige un ícono propio por pieza
de equipo, ninguna entrada en `sprites.yaml` y que cada banda de una línea cambie la imagen
y los materiales. Lo que aprendió la revisión: un arma llena ~26 px en diagonal (más corta
se lee como una hoja de árbol); un metal claro tapa una runa clara (el acero de marea es
oscuro y la runa, un cian saturado); y cuidado con la banda de valor en los dos extremos
(ropa blanca, cuero alquitranado).

**Revisar:** `node --experimental-strip-types tools/spritegen/src/cli.ts sheet [--only
<prefijo>] [--out DIR] [--scale N]` escribe `build/spritegen/<sprite>.sheet.png` (todos los
frames a Nx, por defecto 4, en una grilla: una fila por acción y dirección) y
`<sprite>.lineup.png` (a 1x, escalado 3x, como lo pone el cliente sobre su suelo, al lado
del lobo de Gemini y de una persona de LPC si el atlas está armado; un ícono, además, en un
slot del inventario a 1x y a 2x). Con íconos entre los elegidos escribe también
`icons.slots.png` (cada uno en el slot a 2x, a 1x y sobre una casilla de pasto, una fila
por línea del catálogo) e `icons.detail.png` (a 4x). Mirar los dos con Read; si reemplaza un sprite, compararlo con el viejo en el juego y quedarse con el que se
lea mejor. Un prop de una casilla se compara sobre cada suelo donde está, al lado de una
persona de LPC, a 1x: lo que decide es el contraste con ese suelo y una lectura limpia, no
el detalle. Lo que aprendió la revisión del 2026-11-18: pocas piezas y un material cálido
(el primer cajón del motor, con un marco gris y vetas en el frente, se perdía sobre las
tablas del muelle; el que quedó es de madera clara con la tapa lisa); textura baja
(`amount` 0,06-0,16: más hierve a 1x); y un objeto alto puede pararse adelante en su casilla
(`at: [0, -3, 0]`, el poste del cartel) para no tocar el borde del lienzo de 32x32. El bolardo se
probó tres veces y ninguna le ganó al dibujado a mano: sigue en `recipes/terrain.ts`.

**Puertas de calidad** (`gates.ts`, umbrales en `GATES`; las corren `make test` y
`spritegen check`, que también va al final de `make spritegen`): colores solo de sus
materiales y nunca `#000`; alfa 0 o 255; menos del 10 % de píxeles en damero; nada
contra el borde del lienzo; contorno en al menos el 85 % de la silueta; una sola figura
(sueltos solo de hasta 10 px: una chispa); al menos el 20 % de la caja lleno; media de L*
en la banda de su tipo (ART-6); alto y largo de perfil dentro del rango de ART-2 o de
`figure`; un ícono centrado en el lienzo (±1,5 px, `iconCentre`) y de 16 px o más por su
lado más largo (`iconSpan`); de frente y de espaldas centrado (±2 px) y al menos el 45 % de ancho de su largo
de perfil (`frontWidth`: si no, de frente se lee como una raya a 1x, como el primer
jabalí); los pies en la fila del suelo (más holgura si flota); caminar que cambia de
silueta, un ataque y una muerte que se distinguen del parado y sur distinto de oeste; las
pistas de `sprites.yaml` iguales al rig (y el `tiles` de un `loop`); un `loop` que se mueve
(algún frame cambia al menos 4 px respecto del 0, `loopMoves`) sin irse de su lugar (la caja
de cada frame a 3 px o menos de la del 0, `loopDrift`); y el determinismo (mismo spec,
mismos píxeles).
El test del motor es `src/engine/engine.test.ts`.

## spritepack
Empaqueta `assets/sprites/**` en atlas PNG + JSON para el cliente y el editor, y genera
placeholders (cuadros de color con la sigla del item) cuando falta un sprite.
Los PNG de bordes de `assets/sprites/borders/` salen de
`node --experimental-strip-types tools/spritepack/src/gen-borders.ts` (regenéralos si
cambia `data/borders.yaml` o el sprite de un suelo: cada pieza recorta la textura del suelo
de origen, o su color si es placeholder; las orillas del agua salen con 3 frames más de
espuma, `<pieza>/frame_<n>`). Uso: `make sprites` (`STRICT=1` falla si algún sprite de `data/` no tiene arte ni entrada en
`assets/sprites.yaml`). Formato del manifiesto, del atlas y cómo integrar un pack de
terceros: `assets/README.md`. También arma las animaciones de criaturas (`src/anims.ts`,
docs/17 ANI): compone capas de un pack con paletas (`palettes`, `animations`), corta los
frames `<sprite>/<acción>_<dir>_<n>`, arma los clips de los archivos con esos nombres (con
las pistas `mirror`, `anchor` y `ms` de una entrada sin capas: el este espejado del oeste,
los pies en la casilla y los ms por frame; las criaturas de Gemini) y escribe `anims` en
`atlas.json` ("Sprites animados" en `assets/README.md`).
