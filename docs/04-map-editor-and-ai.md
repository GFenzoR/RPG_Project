# 04 — Map editor y uso por IA

## Una librería, tres interfaces
```
                packages/map-format
      (leer/escribir chunks, validar, operaciones reversibles)
          ▲                 ▲                    ▲
   editor web          tools/mapcli          tools/mcp-world
  (humanos)        (scripts, CI, IA por CLI)   (IA por MCP)
```
Regla: **toda operación existe primero en `map-format/ops`**, con test. El editor, el CLI y
el MCP solo la exponen. Así un humano y una IA producen exactamente el mismo resultado.

## Operaciones (contrato estable)
Cada operación es JSON, se aplica sobre un mundo en memoria y devuelve su **inversa**
(para deshacer y para revisión).

Implementación: `packages/map-format/src/ops/` (entrada `@rpg/map-format/ops`, sin
dependencias de Node para que el editor la use en el navegador).
`applyOps(world, ops, { itemKind? }) → { world, inverse, touched }`:
- **Pura**: no muta el mundo de entrada; copia solo las islas y chunks que toca.
- **Atómica**: si una op es inválida lanza `OpError` (con el índice de la op) y no aplica
  ninguna. Inválido = celda fuera de toda isla o en un piso no listado, rect vacío,
  `remove_item` de algo que no está, índice fuera de la pila; con `itemKind`, además item
  desconocido, `paint_ground` con algo que no es `kind: ground` o `place_item` con un suelo.
- **Reversible**: `inverse` es una **lista** de ops que, aplicada al resultado, devuelve
  exactamente el mundo original (mismos bytes al guardar). La inversa de la inversa rehace.
- Un chunk que queda sin suelo ni items se elimina (y su archivo desaparece al guardar).
- `touched` lista cada chunk modificado con su isla (`{ island, z, cx, cy }`): los chunks
  son por isla, así que dos islas que compartieran un chunk nunca se mezclan.
  `touchedAux` lista las listas auxiliares cambiadas (`{ island, file }`, con `file` =
  `spawns`/`zones`/`portals`/`npcs`). `saveApplied(root, world, result)` escribe solo esos
  archivos (temporal + rename) y borra los que quedaron vacíos.
- `OpOptions` inyecta lo que vive en disco, para que el módulo siga sin Node: `itemKind`,
  `monsterKnown`, `npcKnown`, `borders` (reglas de `data/borders.yaml`, las necesita
  `autoborder`) y `prefab` (lookup de `world/prefabs/`, lo necesita `stamp`).

| op | Campos | Efecto |
|---|---|---|
| `paint_ground` | `floor`, `rect` y/o `cells`, `item` | Pone suelo |
| `erase` | `floor`, `rect` y/o `cells`, `layer` (`ground`/`items`/`all`) | Borra |
| `place_item` | `pos`, `item`, `index?` | Agrega a la pila (`index` 0 = abajo; sin `index`, arriba) |
| `remove_item` | `pos`, `item`, `index?` | Quita de la pila (el de `index`, o el de más arriba) |
| `fill` | `pos`, `item` | Relleno por inundación del suelo contiguo igual |
| `autoborder` | `floor`, `rect` | Recalcula bordes con `data/borders.yaml` |
| `scatter` | `floor`, `rect`, `items[]`, `density`, `seed`, `on_ground[]` | Decoración aleatoria reproducible |
| `add_spawn` / `remove_spawn` | campos de spawns.yaml | |
| `add_zone` / `remove_zone` | campos de zones.yaml | |
| `place_npc` / `remove_npc` | `pos`, `npc` | |
| `add_portal` / `remove_portal` | campos de portals.yaml | |
| `stamp` | `pos`, `prefab` | Coloca un prefab (casa, muelle, templo) de `world/prefabs/` |

Detalle de las ops de T1.15 (las inversas se expresan siempre con ops primitivas):
- `fill`: inundación en 4 direcciones dentro del rectángulo de la isla de `pos`; también
  rellena casillas vacías.
- `autoborder`: en cada casilla del rect quita las piezas de borde que tenga (cualquier
  pieza de `data/borders.yaml`) y apila abajo las que tocan, en orden de `priority`; lo
  demás de la pila queda encima. Repetirlo no cambia nada. Nombres de pieza en `06`.
- `scatter`: PRNG mulberry32 con `seed`; dos números por casilla en orden de filas, pase lo
  que pase, así una casilla no desplaza el patrón del resto. Solo decora casillas con pila
  vacía y suelo en `on_ground` (cualquiera si se omite).
- Entidades: los IDs son únicos en todo el mundo y cada NPC se coloca una vez. La isla es
  la que contiene el centro del spawn, el primer rect de la zona (todos deben caer dentro),
  el `from` del portal o el `pos` del NPC. Las ops `add_*`/`place_npc` aceptan `index?`
  (posición en la lista; por defecto al final): la inversa de un `remove_*` lo usa para
  devolver el archivo byte a byte. Que el spawn o NPC esté sobre suelo caminable lo revisa
  el validador, no la op.
- `stamp`: la esquina superior izquierda del prefab va en `pos`. Formato en `03`.

Generación procedural (`generate` en map-format, `mapcli generate`): una receta convierte
una semilla en una lista de ops, así que pasa por `applyOps` (atómica, reversible). Receta
`island`: masa de tierra de `size`x`size` centrada en la isla (ruido de valor + caída
radial), agua alrededor, arena en la costa, pasto adentro (el pasto nunca toca agua y el
centro siempre es tierra) y `autoborder` al final.

`mapcli ops apply ops.json` y la herramienta MCP `map_apply_ops` reciben una lista y la
aplican de forma atómica: si una falla la validación, no se aplica ninguna. Después de
escribir validan las islas tocadas y devuelven errores y advertencias (el mapa puede
quedar con errores mientras se construye: p. ej. un spawn antes de pintar su suelo). No
escriben nada si `world/` tiene errores de carga (un archivo roto se sobrescribiría).

## Cómo "ve" el mapa una IA
Leer JSON de chunks es caro y poco legible. Hay dos vistas pensadas para IA:

1. **Vista ASCII** (`mapcli view` / `map_view`): un área de hasta 64x64 como texto,
   un carácter por casilla, con leyenda generada. Barata en tokens.
   ```
   legend: . grass  , sand  ~ water_shallow  T oak_tree  # stone_wall  + door  M spawn(wolf)
   y\x 3200      3210      3220
   6400 ~~~~,,,,,.....TT......
   6401 ~~~,,,,......T.....#+##
   ```
2. **Render PNG** (`mapcli render` / `map_render`): imagen real con los sprites, para
   revisar con la herramienta Read. Úsalo después de editar para verificar.

## Herramientas MCP (`tools/mcp-world`)
| Herramienta | Uso |
|---|---|
| `map_info` | Resumen de una isla o del mundo |
| `map_view` | Vista ASCII de un área |
| `map_render` | PNG de un área (devuelve ruta del archivo) |
| `map_apply_ops` | Aplica una lista de operaciones (atómica) |
| `map_validate` | Valida isla o mundo; devuelve errores con posición |
| `map_find` | Busca items, spawns, NPCs o zonas por tipo/área |
| `content_search` | Busca en `data/` (items, monstruos, NPCs) por texto o etiqueta |
| `map_patch_create` | Genera un `.rpgpatch.json` (formato 2) con los cambios actuales |

Límites de seguridad del MCP: solo escribe dentro de `world/` del repo, nunca hace push
ni modifica `data/`, y cada llamada a `map_apply_ops` tiene un máximo de operaciones.
Se registra en `.mcp.json` en la raíz para que Claude Code lo cargue.

Implementación (T1.15): `tools/mcp-world`, transporte stdio (JSON-RPC 2.0, un mensaje por
línea) escrito a mano, sin SDK, para no sumar dependencias; usa las funciones de
`tools/mapcli` (`edit.ts`, `render.ts`, `patch.ts`). Límites concretos:
- `map_apply_ops`: máximo 200 ops por llamada; `island` opcional rechaza ops que toquen
  otra isla; `dry_run` valida sin escribir. Las ediciones solo escriben chunks y YAML de
  `world/islands/<id>/` (rutas construidas desde IDs validados y comprobadas otra vez).
- `map_patch_create` escribe en `world/patches/<name>.rpgpatch.json` (ignorado por git);
  solo corre `git diff`, `git ls-files` y `git show` de lectura.
- `map_render` escribe el PNG en el directorio temporal del sistema (fuera del repo) y
  devuelve también la imagen en la respuesta.
- `content_search` y el resto solo leen.

`mapcli render` / `map_render`: mismo orden de dibujo que `packages/renderer`, con el atlas
de `tools/spritepack` armado en memoria (no hace falta `make sprites`). Agrega reglas con
coordenadas absolutas, grilla y overlays: zonas (cian protección, naranja no_logout, rojo
pvp, verde no_pvp, violeta community_plot), spawns (anillo rojo del radio), NPCs (rombo
amarillo), portales (cuadro magenta; triángulo abajo = baja, arriba = sube), carteles
(cuadrito blanco) y templo (cruz blanca). Máximo 256x256 casillas; 4/8/16/32 px por casilla.

### Map patches
Formato (`.rpgpatch.json`, formato 2 desde T2.3):
`{ format: 2, kind: "rpg-map-patch", base_ref, files: [{ path, base, base_text?, content }] }`.
`base` = `sha256:<hex>` de la versión base (o `null` si el patch crea el archivo),
`base_text` = el texto de esa base (obligatorio en formato 2 cuando `base` no es `null`),
`content` = texto nuevo (o `null` si lo borra). `base_ref` es el commit contra el que se
hizo (`mapcli` y el MCP escriben el sha al que apunta el ref pedido, `HEAD` por defecto,
porque un ref simbólico no dice nada fuera de ese clon; T4.5) o `"editor"`. El formato 1 (T1.15, sin `base_text`) se sigue leyendo.

**Decisión: la base viaja en el patch.** Para mezclar hace falta la base completa, no solo
el hash. Se eligió incluirla (formato 2) en vez de sacarla con `git show base_ref:path`
porque el patch tiene que poder aplicarse donde ese ref no existe: otro clon, una rama
rebasada, el editor sin git o, más adelante, el editor público sin backend. Cuesta el
doble de tamaño, aceptable con chunks de 32x32. Con formato 1 la base se busca en el disco
(si el hash coincide) y luego en `git show base_ref:path`. Si no aparece, solo se aplican
los archivos sin cambios locales y el resto es conflicto.

La lógica vive en un solo lugar, `packages/map-format`:
- `src/patch/merge.ts` (sin Node, también lo usa el editor): `mergeChunk`, `mergeList`,
  `diffWorlds`, `chunkChanges`/`listChanges` y las ops que llevan el mundo al resultado
  (`chunkSyncOps`, `listSyncOps`).
- `src/patch/patch.ts` (Node): `parsePatch`, `parsePatchFile`, `mergePatchFile`,
  `summarizeFileChange` y `patchPath`.
`tools/mapcli/src/patch.ts` solo agrega lo que necesita git y disco (`createPatch`,
`planPatch`, `writePlanned`). El MCP (`map_patch_create`) usa `createPatch`, así que
también genera formato 2.

**Merge de tres vías** (base del patch, versión actual, contenido del patch):
- Primero se comparan textos: si un solo lado cambió, se toma ese lado.
- **Chunks**, por casilla (suelo + pila completa): una casilla que cambió de un solo lado
  se toma de ese lado; si cambió en los dos lados a valores distintos, es conflicto. Un
  chunk que no existe cuenta como vacío, así que crear y borrar archivos se mezcla igual.
  Si el resultado queda vacío, el archivo se borra.
- **YAML auxiliares** (`spawns`, `npcs`, `zones`, `portals`, `texts`): se mezclan por
  entrada con `id` como clave (`npc` en `npcs.yaml`). Si una entrada se borró en un lado y
  se cambió en el otro, es conflicto. Orden del resultado: la lista actual, con sus
  entradas reemplazadas o quitadas, y después las que agrega el patch. Si un lado no
  cambió, el otro se toma tal cual, orden incluido. Las listas con claves repetidas o sin
  clave son conflicto del archivo entero.
- `world.yaml`, `island.yaml` y prefabs: si cambiaron en los dos lados, es conflicto del
  archivo entero.
- **Siempre se escribe la forma canónica** (`canonicalPatchText`), también en el
  fast-forward y al crear un archivo. Es el mismo texto que `mapcli fmt`: un patch hecho a
  mano se acepta, pero nunca se escriben sus bytes tal cual (un `01056` u `0x4` en YAML se
  lee distinto en Go y en TS). Un chunk vacío o una lista vacía borran el archivo. Las
  comparaciones (base, actual, patch) también se hacen sobre texto canónico, así aplicar
  dos veces el mismo patch es un no-op aunque no esté en forma canónica.

`mapcli patch`:
- `create [isla] [--against REF] [--out FILE]`: los archivos de mapa que difieren del ref,
  en formato 2.
- `apply <file> [--dry-run] [--partial]`: hace el merge de cada archivo contra el disco.
  Es todo o nada: si hay conflictos no escribe nada, sale con código 1 y los lista como
  `{ path, reason, at: ["x,y,z" | id] }` (las primeras 100 casillas o entradas). Con
  `--partial` escribe todo lo demás y en las casillas o entradas en conflicto conserva la
  versión actual. La salida dice qué archivos se mezclaron (`merged`) y el resultado del
  validador.
- `diff <file>`: compara lo actual con lo que escribiría el merge, no con el contenido del
  patch, así las ediciones locales hechas en otras casillas o entradas no aparecen como
  revertidas. Da casillas cambiadas y bbox por chunk; entradas agregadas, quitadas y
  cambiadas por YAML; `base_matches` y, si la base no coincide, cuántos conflictos hay.
  Si el archivo entero es conflicto (no hay base, o un `island.yaml`/`world.yaml`/prefab
  cambió en los dos lados), `status` es `"conflict"` y el resumen muestra lo que cambia
  el contenido del patch.
  Sale con código 1 solo si hay conflictos.

**Seguridad:** un patch es entrada no confiable. `parsePatch` rechaza:
- patches de más de 32 MB o con más de 4096 archivos;
- un `base_ref` que no parezca un ref (por ejemplo, uno que empiece con `-`);
- rutas fuera de `world.yaml`, `world/islands/<id>/{island,spawns,npcs,zones,portals,texts}.yaml`,
  `world/islands/<id>/chunks/zNN/cXXXX_YYYY.json` (piso ≤ 15) y `world/prefabs/<id>.yaml`:
  la regex no deja pasar `..`, rutas absolutas, `\`, NUL ni mayúsculas;
- rutas repetidas o un `base_text` cuyo hash no coincide con `base`;
- contenido o base que no pase su esquema, o un chunk cuyas coordenadas no coinciden con
  su ruta.
Al escribir, `mapcli` también comprueba que el directorio existente más profundo resuelva
(realpath) dentro de `world/` y que el destino no sea un symlink. Los tests de rutas
maliciosas están en `packages/map-format/src/patch/merge.test.ts`,
`tools/mapcli/src/edit.test.ts` (incluido el symlink) y `editor/server/store.test.ts`.

### PR de mapas en CI (T2.4)
Todo PR dispara tres workflows (sin filtro `paths`: GitHub solo mira los primeros 300
archivos, y un push que deja de tocar `world/` tiene que reemplazar el veredicto anterior):

1. **`map-pr.yml`** (`pull_request` con `opened`, `synchronize`, `reopened` y `edited`,
   `contents: read`, sin secretos). Hace checkout de la **rama base tal como está ahora**
   (`base.ref`, no el `base.sha` congelado del evento) y trae el head del PR solo como dato
   (`git fetch refs/pull/N/head`). Si el PR no cambia `world/`, termina ahí, antes de
   `pnpm install`. Si lo cambia, instala las dependencias **de la base** y corre
   `mapcli pr-check --base <sha base> --head <sha head> --author <login> --association <rel> --head-repo <o/r> --repo <o/r> --pr <n> --out map-pr`.
   Sube dos artefactos, `map-pr-report` (`report.json`) y `map-pr-renders` (PNG), y falla
   si el reporte falla. También deja una vista previa del comentario en el resumen.
2. **`map-pr-comment.yml`** (`workflow_run` de `map-pr`, `pull-requests: write`,
   `actions: read`, `contents: read`). Publica **un** comentario por PR, marcado con
   `<!-- rpg-map-pr-check -->`, y lo edita en cada push. Lo crea solo si el PR cambia
   `world/` y lo actualiza siempre que ya exista. Si el último commit ya no toca `world/`,
   lo reemplaza por un aviso de que la revisión anterior no aplica. El comentario vale
   para el commit que nombra. Si el PR ya avanzó a otro commit, no hace nada: un reporte
   viejo nunca pisa uno nuevo ni el aviso de "pendiente".
3. **`map-pr-pending.yml`** (`pull_request_target`, solo `pull-requests: write`). Sale de
   la base, así que el PR no lo puede quitar. En cada push (y en `edited`), si ya existe
   el comentario, lo cambia a "⏳ Pendiente: revisando el commit `<sha>`". No hace
   checkout, no ejecuta ni lee nada del PR, y solo usa el número y el sha del evento,
   validados con regex. Así, un push que no produce una corrida de `map-pr` (por ejemplo,
   porque el PR renombró o borró `map-pr.yml`) deja "pendiente", nunca un ✅ viejo. Corre
   con `set -euo pipefail` y sin pipes a `head`: si falla el listado o el PATCH (por rate
   limit o un 5xx), el job queda en rojo en vez de "pasar" sin marcar nada. El test
   ejecuta el script del YAML con un `gh` falso.

`mapcli pr-check` (`tools/mapcli/src/prcheck.ts`):
- Arma el PR como map patch desde `merge-base(base, head)` hasta `head` y lo mezcla sobre
  la base actual en un worktree temporal, igual que `patch apply`. El resumen por archivo
  es el de `patch diff` (estado, casillas, bbox, entradas, `base_matches`, `conflict`), así
  lo que entró a la base después de abrir el PR no aparece como revertido.
- **Mismo merge que GitHub:** GitHub mezcla texto, no casillas. `git merge-tree
  --write-tree` calcula el árbol que haría git:
  - si git ve un conflicto textual, falla con `rebase`;
  - si para algún archivo tocado el texto de git (canónico) no es exactamente el que midió
    el merge por casilla, falla con `merge_mismatch`. Pasa con las paletas de los chunks,
    que van en orden de primer uso: un lado renumera y el otro agrega una fila con la
    numeración vieja.
- **Archivos inválidos:** fallan con `invalid`, también para maintainers, y quedan fuera
  del merge:
  - un archivo de mapa del PR que no pasa su esquema;
  - uno que no es UTF-8 válido: se lee como bytes y se decodifica en modo estricto, porque
    una decodificación con pérdida convertiría un `0xFF` en U+FFFD y parecería canónico;
  - uno cuyos **bytes** no son exactamente su forma canónica (`mapcli fmt`). Por ejemplo,
    `x: 03207` es 3207 para el parser TS y 1671 (octal) para el `yaml.v3` del servidor;
  - una ruta de `world/` cuyo modo no es `100644` en el head o en el merge (symlink,
    ejecutable, submódulo), aunque el blob no cambie.
- La comparación con `git merge-tree` compara bytes: el blob crudo de git contra el
  archivo que escribió el merge por casilla, sin canonicalizar.
- **Caracteres prohibidos (decisión).** `parsePatchFile`, y con él `canonicalPatchText`,
  rechaza en cualquier archivo de mapa los controles C0 (salvo tab, LF y CR), DEL, los
  controles C1 y U+FFFE/U+FFFF, tanto crudos como escritos como escape YAML (`"\x7f"`).
  Se rechazan en vez de escaparlos al escribir porque el texto libre (`notes`) nunca los
  necesita, y porque así el parser TS y el `yaml.v3` de Go leen siempre lo mismo (Go los
  rechaza crudos). Acentos, ñ y el resto de Unicode pasan.
- **Parcelas** (`checkPlots` en `packages/map-format/src/patch/plots.ts`, reglas en
  `03-world-and-maps.md`): casillas y entradas fuera de toda parcela `community_plot` de la
  base. Falla si hay alguna y el autor no es maintainer (`.github/MAINTAINERS` de la base u
  OWNER, y dueño del repo del head).
- **Validación**: errores del validador en el mapa mezclado que la base no tenía.
- **Conflictos** con la base actual: falla (hay que hacer rebase). Cada conflicto lleva un
  código fijo (`tiles`, `entries`, `changed_both_sides`, `no_base`, `invalid_file`), nunca
  el texto del parser.
- **Render**:
  - `changeBoxes` toma el bbox de las casillas cambiadas por chunk y la posición de cada
    entrada cambiada (spawn con su radio, ambos extremos del portal, rects de zona);
  - `renderAreas` les suma 4 casillas de margen, fusiona las que se tocan en el mismo piso,
    parte las de más de 64x64 y se queda con 6 como máximo (el resto se cuenta);
  - cada área se renderiza antes (base) y después (merge) con `renderArea`, a 32/16/8/4 px
    por casilla para no pasar de 1024 px de lado;
  - un PNG de más de 2 MB no se sube.
- Exit code 1 si falla. `report.json` (formato 2) lleva:
  - `ok`, `failures` (`plots`, `invalid`, `conflicts`, `rebase`, `merge_mismatch`,
    `validation`) y `map_changes`;
  - `files`, `conflicts`, `invalid_files` y `merge_mismatch`;
  - `plots` y `validation`, con sus totales;
  - `other_files` (con su total), `areas` y `omitted_areas`.

**Seguridad (los PR vienen de forks).** Modelo de confianza en dos capas:
1. **El check corre código de la base, no del PR.** `map-pr.yml` hace checkout de la rama
   base y corre su `pnpm install` y su `mapcli`. Del PR solo lee el mapa con `git show` y
   `git merge-tree`: un `postinstall`, un cambio a `plots.ts` o a `prcheck.ts` del PR no se
   ejecutan. El token es de solo lectura, no hay secretos y no se usa `pull_request_target`.
2. **El comentario no cree en el reporte para lo importante.** `map-pr-comment.yml` corre
   desde la rama por defecto y solo hace checkout de `tools/mapcli/src/prcomment.ts`
   (autocontenido, sin `pnpm install`) y de `.github/MAINTAINERS`. No ejecuta nada del PR y:
   - toma la lista de archivos de `GET /pulls/{n}/files` (hasta 3000; un rename cuenta
     también por su origen, así que mover `.github/workflows/ci.yml` a `docs/` es tocar
     `.github/`) y arma con ella
     "Fuera de `world/`", con los archivos sensibles (`.github/`, `tools/`, `packages/`,
     `server/`, `package.json`, lockfile, `.npmrc`) primero;
   - decide si el autor es maintainer con los datos del PR en la API
     (`author_association`, `head.repo`) y el `MAINTAINERS` de la rama por defecto, y con
     eso decide la falla `plots`; el `maintainer` del reporte se ignora;
   - si la API lista menos archivos que el `changed_files` del PR, o llega al tope de
     3000, el veredicto no es confiable: los archivos que no se ven podrían ser cualquier
     cosa. El "… y N más" usa el total del PR;
   - si el PR cambia cualquier archivo fuera de `world/` y `docs/`, **nunca muestra ✅**:
     dice "El veredicto no es confiable: este PR cambia el código o la configuración del
     check";
   - trata `report.json` como dato no confiable. Lo rechaza si pasa de 1 MB, reconstruye
     cada campo con su tipo y valida cada string contra un patrón estricto (rutas de
     `world/`, IDs, logins, SHAs, nombres `before|after-N.png`, códigos con `oneOf`);
   - los motivos y errores salen de tablas fijas en español: ningún texto del parser llega
     al comentario. Lo único libre son los mensajes del validador, sin backticks ni saltos,
     dentro de un bloque de código;
   - busca el PR por `head_sha` y repo de origen del `workflow_run`, y exige que el número,
     el commit y el autor del reporte coincidan.
- Los topes nunca son silenciosos: el reporte guarda los totales y el comentario dice
  "… y N más".
- Las actions están fijadas por versión exacta.
- **Imágenes:** quedan en el artefacto `map-pr-renders` y el comentario enlaza a él (hace
  falta sesión de GitHub para descargarlo). No se suben a servicios externos ni a una rama
  del repo, porque eso pediría `contents: write` en el workflow con token.
- **Límite conocido:** en `pull_request`, el YAML de `map-pr.yml` sale del PR. Un PR que lo
  edite, lo renombre (`name: map-pr2`) o lo borre puede falsear el check `map-pr / check`;
  además, un job `check` de otro workflow del PR podría ocupar el lugar del requerido. Lo
  que lo contiene:
  - el comentario marca como no confiable a todo PR que toque `.github/` (también por
    rename);
  - `map-pr-pending.yml`, que sale de la base, deja el comentario en "pendiente" en cada
    push;
  - la configuración de abajo.
  El token del check es de lectura, así que el daño no pasa del veredicto.
- **Configuración que hace el dueño del repo** (👤, no la puede hacer la CI):
  - marcar `map-pr / check` como check requerido en la protección de `main`, con "Require
    branches to be up to date before merging" (o una merge queue con `merge_group:`), para
    que un cambio en `main` (cerrar una parcela, quitar un maintainer) obligue a recorrer
    el check;
  - en la regla del check requerido, fijar la fuente esperada a **GitHub Actions** (la app),
    para que no lo satisfaga un status de otra integración;
  - un `CODEOWNERS` para `.github/`, `tools/` y `packages/`, con "Require review from Code
    Owners", para que ningún PR que toque los workflows entre sin un maintainer. Es lo que
    cierra el caso del workflow renombrado o de un job `check` falso.
- Arranque: mientras la base no tenga `tools/mapcli/src/prcheck.ts`, el check se salta y
  lo dice en el resumen. La base es de confianza: un PR no puede quitárselo.

Prueba local, sin GitHub: `make map-pr BASE=main HEAD=<rama>` (reporte y PNG en
`build/map-pr/`, imprime el comentario con `prcomment.ts --dry-run`, que toma los datos de
confianza del propio reporte y por eso es solo una vista previa). Tests:
`packages/map-format/src/patch/plots.test.ts` y `tools/mapcli/src/prcheck.test.ts`.

### Portal de envío de mapas (T4.5)
Para quien no usa git: el editor (o `mapcli patch create`) exporta un map patch y el sitio
lo manda a revisión. Un moderador lo aprueba o rechaza, y uno aprobado se abre como PR en
este repo, donde corren los checks de siempre (sección anterior). El portal y la cola son
el servidor y el sitio; el PR lo abre el worker `tools/map-pr-worker` (deploy y token en
docs/09, "Worker de PR de mapas").

**Flujo:**
1. El jugador, con sesión, entra a `/maps/submit` (sitio público, `client/src/site/Maps.tsx`;
   si no tiene sesión, el mismo sitio le muestra un login). Sube el `.rpgpatch.json`, pone
   título y descripción, elige con qué personaje se lo acredita y acepta la licencia.
2. El servidor (`httpapi/mapsubmit.go`) chequea el patch como entrada no confiable
   (`server/internal/mappatch`) y lo guarda en `map_submissions` (migración 00010) como
   `pending`, con su `audit_log` (`map_submit`).
3. `/maps/mine` muestra al autor el estado de cada envío y, si se rechazó, el motivo.
4. Un gm o admin abre `/maps/review` (la cola, por estado), mira el detalle (archivos
   tocados agrupados por isla, tamaño, autor, sha256, descripción), descarga el patch para
   revisarlo con `mapcli patch diff` o en el editor (Importar patch), y lo aprueba o lo
   rechaza con motivo. Cada decisión y cada descarga quedan en `audit_log`
   (`map_approve`, `map_reject`, `map_download`, fuente `web`).
5. Aprobado = `approved`. El worker lo toma de la cola de la base (contrato abajo) y lo
   deja en `pr_opened` (con la URL) o `failed` (con un código fijo).

**El worker** (`tools/map-pr-worker`, Node; reutiliza `packages/map-format`, nunca un merge
propio):
- Lee la rama base **actual** con la API de contenidos de GitHub y mezcla cada archivo del
  patch con `mergePatchFile` (el mismo merge de tres vías que `mapcli patch apply`, con la
  `base_text` del patch como base). Escribe el resultado con la API Git Data (blobs, árbol
  sobre el de la base, commit con la base como padre, rama `map-submission/<id>`): sin
  `git clone` ni nada que ejecutar en el contenedor.
- Vuelve a chequear todo lo que importa, sin confiar en el servidor: `parsePatch`, solo
  formato 2, y cada ruta tiene que ser un archivo de mapa de `world/` (`writablePath`).
  También repite el chequeo de **parcelas** contra las zonas de la base (`checkPlots`):
  el portal es para cambios dentro de `community_plot`, y el autor del PR es el token del
  worker, no el jugador (docs/09: una cuenta de bot que no está en `MAINTAINERS`).
- **Crédito:** el mismo commit agrega a `world/CONTRIBUTORS.md` una fila
  `| <personaje> | <islas> | envío #<id> | <fecha de aprobación> |`. Es el archivo que
  `PLOT_FREE_FILES` deja tocar a cualquiera. Va el número de envío y no el del PR porque
  el PR todavía no existe cuando se escribe el commit. Dos PR del portal abiertos a la vez
  agregan filas al final del mismo archivo: el segundo en mergearse tiene un conflicto de
  una línea que se resuelve con "Resolve conflicts" en GitHub.
- **El PR** se titula `map: <título> (envío #<id>)` y su cuerpo dice autor (personaje),
  licencia, islas, archivos y sha256 del patch, y lleva la descripción del autor dentro de
  un bloque de código con un cerco más largo que cualquier secuencia de backticks: no se
  renderiza como Markdown, y sus `@menciones` o `#referencias` no avisan a nadie. Nunca el
  email ni nada interno.
- **Fallas** (`failure`, las ve el autor en "Mis envíos"): `conflict`, `outside_plot`,
  `invalid_patch`, `no_changes` y `github`. Un error de red o de GitHub reintenta con
  espera creciente y, después de 10 intentos, pasa a `github`.

**Qué chequea el servidor (y qué no).** Es una primera barrera barata, no la validación
del mapa: el merge, los esquemas, las parcelas `community_plot` y el validador los corre
el check del PR (`mapcli pr-check`) con el mismo código TS de siempre. `mappatch.Validate`:
- tamaño (`-map-submit-max-bytes`, 2 MiB, muy por debajo de los 32 MB de `parsePatch`) y
  hasta 256 archivos;
- UTF-8 válido, un solo valor JSON, sin claves repetidas (Go y JS se quedarían con copias
  distintas), sin campos desconocidos (comparados byte a byte: `encoding/json` ignora
  mayúsculas) y a lo sumo 8 niveles;
- `kind: "rpg-map-patch"` y **solo formato 2** (la base viaja en el patch; el worker no
  tiene que buscarla en git);
- `base_ref` con la misma regex que `parsePatch`; las rutas, con la misma lista que
  `patchPath` (el fixture `packages/map-format/src/patch/testdata/paths.json` lo leen los
  tests de los dos lados, así no se separan);
- `base` (`sha256:<hex>` o `null`), `base_text` obligatorio con base y con su hash
  correcto, `content` string o `null`, nunca los dos `null`, y sin archivos sin cambios;
- los caracteres prohibidos de los mapas (`FORBIDDEN_CHARS`) en `content` y `base_text`,
  más U+FFFD: es lo que el decodificador de Go hace de un `\ud800` suelto que JS
  conservaría. Los escapes YAML (`"\x7f"`) los rechaza después `parsePatch`.
El error es un código fijo (`site.maps.patch_error.<código>` en el sitio) y, a lo sumo, el
índice del archivo: nunca texto del patch. El patch se guarda tal cual (sha256 de esos
bytes) y nunca se ejecuta ni se interpreta fuera de estos chequeos.

**Retención.** Los bytes del patch de un envío `rejected`, `pr_opened` o `failed` se borran
30 días después de su último cambio (`-map-patch-retention`; job horario del servidor).
Quedan el sha256, los archivos tocados y el resto de los datos, y la descarga responde
`410`. Un envío `pending` o `approved` nunca pierde su patch.

**Límites y abuso.** 3 envíos guardados por cuenta en 24 h (`-map-submit-per-day`, contado
en la misma transacción con la cuenta bloqueada `FOR UPDATE`), cuentas de al menos 24 h
(`-map-submit-min-account-age`), 5 intentos por minuto por cuenta, 2 chequeos a la vez, y
el mismo patch de una cuenta no puede estar dos veces pendiente. Una cuenta baneada o
deshabilitada no envía. La memoria tiene un tope antes de leer cualquier cuerpo: 4 subidas
en curso a la vez (el resto, `503`), 30 s por subida y un solo buffer por cuerpo (≈ 40 MiB
como máximo; detalle en docs/05 y docs/07). Las descargas del patch tienen su propio
límite por cuenta y 2 lugares.

**Licencia (decisión, a confirmar por el dueño del repo).** Ni `docs/00` ni
`world/CONTRIBUTORS.md` fijaban una. El checkbox acepta **CC BY 4.0**
(`httpapi.MapLicense = "cc-by-4.0"`): la misma familia que el arte (`assets/CREDITS.md`),
permite usar y modificar el mapa con atribución, y la atribución es justamente la fila de
`world/CONTRIBUTORS.md` y el crédito del PR. Cada envío guarda el id de la licencia que su
autor aceptó; cambiarla es un id nuevo, no reescribir los viejos. El crédito es siempre el
nombre del personaje elegido, nunca el email.

**Moderación.** Solo gm y admin (rol de `accounts`, que asigna `gameserver admin set-role`),
leído en cada pedido y otra vez dentro de la transacción de la decisión. Un player que
conoce las URLs recibe `403` en la cola y en la decisión, y `404` en el detalle y la
descarga de envíos ajenos. Un moderador no decide sobre su propio envío
(`own_submission`): lo revisa otro, así nadie manda su patch directo al worker. Los
intentos de un player contra la API de moderación van al log del servidor, no a
`audit_log` (que no se llene con ruido de una cuenta cualquiera). Pendiente para más adelante (opcional en T4.5): avisar a los gm
conectados cuando llega un envío.

**Contrato con el worker (PR 2/2).** La cola es la tabla, y ninguna transacción queda
abierta mientras se habla con GitHub:
1. **Reservar**, en una transacción corta: el aprobado más viejo que toque,
   `SELECT … FROM map_submissions WHERE status = 'approved' AND (next_attempt_at IS NULL OR
   next_attempt_at <= now) ORDER BY reviewed_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`
   (índice parcial `map_submissions_approved_idx`); se le suma `attempts + 1` y
   `next_attempt_at = now + lease` (minutos), y se confirma. El lease aleja a otros
   workers; si el worker muere, vence solo.
2. **Trabajar** sin transacción. Es idempotente por construcción: la rama es siempre
   `map-submission/<id>`, y si ya hay un PR abierto desde esa rama se reusa, nunca se
   abre otro. Un reinicio a mitad de camino no duplica nada.
3. **Cerrar**, en otra transacción corta con `status = 'approved'` como guarda: `pr_opened`
   (`pr_url`, `pr_number`) o `failed` (`failure`, un código `[a-z_]` fijo, nunca un
   mensaje de GitHub o del merge). Un error reintentable lo deja `approved`, y el lease
   hace de espera.
La tabla exige `pr_url` y `pr_number` en `pr_opened`, `failure` en `failed` y `reason` en
`rejected`.

## Flujo recomendado para que una IA construya una zona
1. `map_info` y `content_search` para saber qué hay disponible.
2. Generar base: `mapcli generate` (forma de isla, costas, ríos con semilla) o pintar
   a mano con `paint_ground` en rectángulos.
3. `autoborder`, luego `scatter` para vegetación y rocas.
4. Colocar estructuras con `stamp` y prefabs.
5. Spawns, NPCs, zonas, portales.
6. `map_validate` hasta que no haya errores.
7. `map_render` de cada área tocada y revisar las imágenes.
8. `map_patch_create` y abrir PR. Fuera de una parcela `community_plot` hace falta un
   maintainer (ver "PR de mapas en CI").

## Editor web — funciones por hito
**Hito 1 (rebanada vertical):** abrir una isla, navegar, zoom, cambiar de piso, pincel de
suelo, colocar/quitar item, borrador, deshacer/rehacer, guardar chunks, validación en
vivo, paleta con búsqueda.

Implementación (T1.14): `editor/` (Vite + Preact + PixiJS, renderer de
`packages/renderer`). Las ops corren en el navegador; un servidor local de desarrollo
(plugin de Vite, `editor/server/`) solo lee `world/` y `data/`, guarda y valida con
`map-format`, porque los archivos y el validador viven en disco. `make editor` lo levanta
en http://localhost:5174 y edita `world/` del repo en el lugar.
- Guardar escribe los mismos bytes que `mapcli fmt` (test en `editor/server/store.test.ts`
  y en el E2E), y **solo los chunks que el editor tocó** (`applyOps` devuelve `touched`).
  Cada archivo viaja con el hash que tenía al abrirse (`base`, enviado en el bootstrap); si
  en disco ya no coincide (git pull, `mapcli`, otra pestaña) o el archivo no cargó, no se
  guarda nada y la UI muestra el conflicto (409). Los archivos que el editor no tocó nunca
  se escriben ni se borran. `island.yaml` y los auxiliares no se editan en el hito 1 (los
  auxiliares sí desde T2.2, ver abajo).
- Seguridad del backend local: toda llamada a `/api` exige la cabecera `x-rpg-editor`
  (una web de otro sitio no puede mandarla sin un preflight CORS que el servidor nunca
  aprueba), `Origin`/`Sec-Fetch-Site` del mismo origen y cuerpo JSON. Guardar solo acepta
  rutas `world/islands/<id>/chunks/zNN/cXXXX_YYYY.json` de islas listadas en `world.yaml`
  en disco, verifica que la ruta resuelta quede dentro de esa isla y que el chunk pase el
  esquema antes de escribir.
  El servidor de desarrollo tiene CORS apagado (`cors: false`: ninguna otra página, ni
  siquiera de otro puerto de localhost, consigue aprobar el preflight) y `/@fs/` solo
  sirve `editor/`, `packages/` y `node_modules/`.
- Guardado en dos fases: primero escribe cada chunk a un temporal junto al destino (si
  falla, los borra y no cambió nada); después renombra. Si un renombre falla a mitad, la
  respuesta (500) incluye lo que sí quedó en disco y el editor avanza esas bases, así el
  siguiente guardado no choca con su propia escritura.
- Validación en vivo: tras cada cambio (300 ms de espera) el servidor corre
  `validateLoaded(world, content)` de map-format sobre el mundo en memoria (las mismas
  reglas que `validateWorld`, menos las de archivos en disco), con las líneas YAML del disco.
- Pendiente para un hito posterior: el editor público y estático para la comunidad
  (`docs/00-vision.md`) no tendrá este backend. Tendrá que validar en el navegador
  (map-format sin Node: esquemas empaquetados, contenido enviado como datos) y guardar
  como map patch descargable o por la API del servidor, no escribiendo `world/`.
- Isla: selector en la barra y `?island=<id>` en la URL (centra en su templo). Al salir
  con cambios sin guardar, el navegador pide confirmación.
- Atajos implementados: `B` pincel, `I` item, `E` borrador, `PgUp/PgDn` piso, rueda = zoom,
  espacio + arrastrar o botón central = mover, `Ctrl+Z` / `Ctrl+Y` (o `Ctrl+Shift+Z`),
  `Ctrl+S`. Clic derecho o Mayús+clic con la herramienta Item quita el item de arriba.
  Los atajos se ignoran solo mientras se escribe texto (no con un checkbox o select en foco).

**Hito 2:** relleno, rectángulo, selección + copiar/pegar, autoborder automático al
pintar, spawns, NPCs, zonas y portales con su panel, exportar/importar patch, vista de
diff antes/después.

Implementación (T2.2, editor v2). Las herramientas solo arman ops de map-format
(`editor/src/tools/tools.ts`); aplicar, deshacer, validar y guardar es igual para todas:
- **Relleno** (`G`): un clic genera la op `fill` con el suelo elegido.
- **Rectángulo** (`R`): arrastrar muestra el rectángulo y al soltar aplica `paint_ground`
  con `rect` (recortado a cada isla del piso); con clic derecho o Mayús borra con `erase`
  en la capa del borrador. Una entrada de historial por arrastre.
- **Selección** (`V`): arrastrar marca un rectángulo del piso actual. `Ctrl+C` copia suelo
  y pila de items de cada casilla; `Ctrl+X` copia y borra todas las capas; `Supr` borra (capa del
  borrador); `Esc` cancela. `Ctrl+V` (o el botón Pegar) entra en modo pegar: la vista
  previa sigue al mouse y el clic pega con la esquina superior izquierda en esa casilla,
  **en el piso actual** (así se copia entre pisos e islas). Pegar = `paint_ground` por
  suelo + `erase` de items + `place_item` en orden: cada casilla copiada reemplaza el
  suelo (si tenía) y la pila completa del destino; las casillas vacías no se pegan y lo
  que cae fuera de las islas se descarta. Con autoborde activo, pegar recalcula también
  los bordes de toda el área pegada (la pila copiada puede traer bordes del origen).
- **Autoborder automático** (casilla "Autoborde" en la barra, activa por defecto): tras
  cada cambio de suelo (pincel, relleno, rectángulo, borrador, pegar) el editor agrega
  una op `autoborder` sobre el rectángulo de las casillas cuyo suelo cambió (las lista
  la inversa) más un borde de 1, recortado a las islas, con las reglas de
  `data/borders.yaml` que manda el bootstrap. Va en la misma entrada de historial;
  deshacer usa la inversa primitiva y rehacer vuelve a correr la op con las reglas.
- **Paneles de entidades** (derecha): pestañas spawns / NPCs / zonas / portales de la
  isla actual, lista (clic = seleccionar y centrar), Nuevo, Borrar y un formulario.
  Crear = `add_spawn`/`place_npc`/`add_zone`/`add_portal`; editar = `remove_*` + `add_*`
  en una sola entrada de historial, con el mismo `index` si sigue en la misma isla (el
  archivo no cambia de orden); borrar = `remove_*`. Las ops validan IDs, monstruos y
  NPCs conocidos (bootstrap manda los IDs de `data/monsters` y `data/npcs`); antes, el editor revisa los
  errores típicos del formulario (ID snake_case y único, campos requeridos, posiciones y
  rects dentro de una isla con ese piso) con mensajes i18n (`editor.entity.err.*`); si aun
  así la op rechaza, su error sale en la barra de estado y no cambia nada. El botón ⌖ toma la próxima
  casilla clicada en el mapa; "Usar la selección" pone el rect de la zona. El canvas
  dibuja zonas, spawns (radio), NPCs y portales del piso con los colores de `mapcli
  render`. `texts.yaml` todavía no se edita.
- Guardar: los YAML auxiliares tocados (`touchedAux`) viajan con su hash base igual que los
  chunks (el bootstrap envía la base de `spawns/npcs/zones/portals.yaml`), así que un
  cambio en disco da conflicto 409. El backend acepta solo
  `world/islands/<id>/(spawns|npcs|zones|portals).yaml` de islas de `world.yaml` (nunca
  `island.yaml`, `texts.yaml` ni `world.yaml`), comprueba que la ruta quede dentro de la
  isla, escribe `formatYaml(lista)` (los mismos bytes que `mapcli fmt`), comprueba que ese
  texto pase el esquema del archivo antes de escribir y borra el archivo si la lista quedó
  vacía (como `saveApplied`). Tests en `editor/server/store.test.ts`.
- Atajos nuevos: `G`, `R`, `V`, `Ctrl+C/X/V`, `Supr`, `Esc`.

Implementación (T2.3, map patches en el editor). Botón "Revisar cambios" en la barra →
panel de revisión (`editor/src/review/`):
- **Línea base** = el mundo tal como se cargó del disco al abrir el editor (no avanza al
  guardar). Contra ella se calculan el diff y el patch exportado.
- **Exportar patch**: el navegador calcula con `diffWorlds` los chunks y listas que
  cambiaron y los manda con los dos mundos a `POST /api/patch/export`. El backend arma el
  texto canónico de cada versión con las mismas comprobaciones que guardar y devuelve un
  formato 2 con `base_ref: "editor"`. Se descarga como `<isla>.rpgpatch.json` y no se
  escribe nada en `world/`.
- **Importar patch**: el archivo (máx. 32 MB) va a `POST /api/patch/parse`, que corre
  `parsePatch` y además rechaza lo que el editor no edita (`world.yaml`, `island.yaml`,
  `texts.yaml`, prefabs e islas que no están en `world.yaml`): eso se aplica con
  `mapcli`. El navegador hace el merge contra el mundo en memoria con las mismas
  funciones (`mergeChunk`/`mergeList`) y lo convierte en ops (`chunkSyncOps`/
  `listSyncOps`). Una entrada nueva o cambiada que cae fuera de la isla de su archivo
  (rect y pisos; en zonas, todos los rects) es conflicto de archivo, porque las ops de
  entidades eligen la isla por la posición. Se aplica como una sola entrada de historial (un `Ctrl+Z` la deshace),
  sin autoborde automático, porque el patch trae sus propios bordes. Los archivos quedan
  pendientes de guardar como cualquier edición. Si hay conflictos no se aplica nada: el
  panel los lista (casilla, entrada o archivo; clic = ir) y el canvas marca en rojo las
  casillas en conflicto. Un patch con formato 1 usa como base el archivo en disco si su
  hash coincide.
- **Vista de diff**: lista de chunks cambiados (casillas por chunk) y de entradas
  agregadas, quitadas o cambiadas por lista. Clic = centrar en el cambio (piso incluido).
  El canvas marca las casillas cambiadas del piso en magenta. "Antes/Después" alterna el
  canvas entre la línea base y el mundo actual. En "Antes" nada edita el mundo oculto
  (`readOnly()` en herramientas, Supr, cortar, pegar, paneles y deshacer/rehacer); importar
  desde "Antes" pasa primero a "Después".
- Tests: `editor/src/state/editor.test.ts` (exportar, importar con merge y deshacer,
  conflicto, patch rechazado, vista "Antes"), `editor/server/store.test.ts` (round-trip
  con `mapcli patch apply`, rutas maliciosas, formato 1) y el E2E "map patches", que
  exporta, alterna antes/después, importa con y sin conflicto e intenta un patch
  malicioso.

**Hito 4–5:** prefabs, generación procedural desde el editor, envío de patch a revisión
con cuenta, cola de moderación, comentarios por casilla.

## Experiencia de usuario del editor
- Atajos tipo editores de mapas clásicos: `B` pincel, `E` borrador, `G` relleno,
  `R` rectángulo, `V` selección, `PgUp/PgDn` piso, rueda = zoom, espacio + arrastrar = mover.
- Panel de validación siempre visible; click en un error lleva a la casilla.
- Previsualización de la vista del jugador (rectángulo 15x11) para revisar composición.
