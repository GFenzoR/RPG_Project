# 11 — Cómo trabajar con Claude Code (y aprovechar los USD 250)

## Puesta en marcha (una sola vez) 👤
1. **Crea el repo en GitHub** (privado por ahora), por ejemplo `rpg-project`, y sube
   el contenido de esta carpeta a `main`.
2. Entra a **claude.ai/code**, conecta tu GitHub y da acceso al repo.
3. **Crea un entorno cloud** desde el selector de entorno (debajo del cuadro de mensaje):
   - Nombre: `rpg-project`
   - Network access: **Custom**, marcando "Also include default list of common package
     managers", y agrega estos dominios (para descargar el navegador de Playwright):
     ```
     cdn.playwright.dev
     playwright.download.prss.microsoft.com
     playwright.azureedge.net
     ```
   - Setup script: pega el contenido de `scripts/cloud-setup.sh`.
   - Environment variables: ninguna con secretos. Para el desarrollo basta con
     `DATABASE_URL=postgres://postgres:postgres@localhost:5432/rpg?sslmode=disable`
4. Inicia la primera sesión con el prompt de **T0.1** (abajo).

El setup script instala herramientas que no vienen preinstaladas (buf, sqlc, goose,
golangci-lint, Chromium de Playwright). Go, Node 22, pnpm, PostgreSQL 16 y Docker ya
vienen en la imagen. El resultado del script queda en caché, así que las sesiones
siguientes arrancan rápido. El hook `SessionStart` del repo (`scripts/session-start.sh`)
levanta Postgres e instala dependencias en cada sesión.

## Lotes: cómo se desarrolla desde noviembre de 2026
El roadmap está hecho. El trabajo de ahora (pendientes de `14`, lo que sale de las pruebas y
de las auditorías) va en **lotes**: varias tareas independientes que se desarrollan juntas,
se apilan en local y se suben con **un solo push y un PR** (GitHub notifica cada push; ver
"Regla de oro" más abajo, que quedó para tareas sueltas).

El lote es un workflow reutilizable, `.claude/workflows/lote.js`. Se lanza desde una sesión
de Claude Code con `Workflow({ scriptPath: ".claude/workflows/lote.js", args })`:
```js
args = {
  base: "fix/lote4",          // la punta anterior: el lote parte de ahí
  name: "lote5",              // rama de verificación lote5/verify y base rpg_e2e_lote5
  items: [{
    slug: "mana", branch: "feat/mana", wt: "mn",   // worktree corto en .wt/ (MAX_PATH)
    risk: "server",            // high | server | content | client | docs (decide la revisión)
    from: "feat/otra",         // opcional: parte de otra rama del lote y espera a que exista
    brief: "Objetivo, archivos y docs a leer, restricciones, criterio de terminado",
  }],
}
```
Etapas (el script nunca corre más de **2 agentes a la vez**, contando los subagentes):
1. **Implementar.** Un agente por tarea, en su worktree. Sin Docker ni e2e: `make lint test
   validate`, tests de Go/vitest, previews de mapcli y spritegen.
2. **Revisar según el riesgo.** Es lo que más tokens ahorra; no todo necesita dos rondas.

   | Riesgo | Cuándo | Revisión |
   |---|---|---|
   | `high` | economía, persistencia, auth, pagos, CI que maneja PRs ajenos | `code-reviewer` + arreglos, y una segunda ronda desde cero |
   | `server` | toca `server/`, `proto/` o `.github/` | una ronda de `code-reviewer` + arreglos |
   | `content` | `data/`, `world/`, `i18n/`, arte | una revisión liviana (modelo chico, esfuerzo bajo) |
   | `client`, `docs` | solo cliente, editor o docs | ninguna (la verificación final igual corre el e2e) |

   Si una tarea marcada `client` o `content` termina tocando `server/`, el script la sube a
   `server`.
3. **Apilar.** De a una: `git rebase` sobre la rama anterior, conflictos resueltos uniendo
   los dos lados, `make lint test validate`. Sin e2e (esfuerzo bajo).
4. **Revisión final.** Un `code-reviewer` mira el diff entero del lote (foco en servidor,
   CI, economía y entradas no confiables). Atrapa lo que se rompe al juntar ramas.
5. **Verificar, una sola vez.** Un agente aplica la revisión final y corre el **único**
   `make test-integration` + `make e2e` del lote, revisa los screenshots que señalaron las
   tareas, y al final apaga Docker y WSL. Un test inestable se investiga y se arregla, no
   se esconde con reintentos. **Si el dueño está jugando** con `make play` (un
   `gameserver.exe` y Vite escuchando en `:8080` y `:5173`), el agente no lo para: espera,
   mirando cada 2 minutos y hasta 8 horas, a que esos puertos se liberen, y recién ahí
   arranca Docker.

Las reglas que el script le pasa a cada agente (`RULES` en `lote.js`) repiten las de
`CLAUDE.md`, la regla legal incluida: assets de terceros solo CC0, CC-BY, OGA-BY o
CC-BY-SA, fuentes OFL, cada archivo en `assets/CREDITS.md`; y el arte y la música hechos
con el Gemini del dueño también van ahí, con prompts que nunca nombran otro juego,
artista ni obra (`tools/CLAUDE.md`, "gemini").

Después, la sesión principal (no un agente) hace **un** push de la punta como `fix/<lote>`,
abre **un** PR con base en el lote anterior (una sección por rama), espera la CI de GitHub y
arregla lo que falle en Linux.

**Cómo escribir el `brief` de cada tarea** (el agente solo sabe lo que dice ahí):
- objetivo en una frase, y por qué;
- qué leer: los docs y archivos exactos, no "todo el repo";
- qué no tocar (lo que hace otra tarea del mismo lote);
- criterio de terminado concreto (qué test tiene que existir, qué comando, qué screenshot);
- hallazgos de auditorías o pruebas: un archivo en el scratchpad, no pegados enteros.

**Límites y cortes:**
- Si se acaba la ventana de 5 horas, se espera a que vuelva y se reanuda con
  `resumeFromRunId` **sin editar el script** (editar un prompt hace correr de nuevo todo lo
  que viene después). Si una etapa quedó a medias, la termina un agente suelto que retoma
  su worktree.
- Los agentes nunca hacen push, ni abren PRs, ni usan `git stash`, ni lanzan subagentes.
- Para cosas de 2 minutos (un número de balance, un texto) no hace falta un lote.

## Regla de oro: una tarea del roadmap = una sesión = un PR
(Así se hizo el roadmap; para tareas sueltas sigue valiendo. El trabajo en serie va en lotes.)
- Tareas chicas y bien definidas gastan menos, fallan menos y se revisan fácil.
- Si una sesión se alarga mucho, pídele que cierre lo que tiene en un PR funcional y
  deje anotado qué falta en el roadmap.
- No le pidas "haz el juego": pídele la tarea `T1.6`.

## Prompt base para cada sesión
Copia, cambia el ID de tarea y pégalo:
```
Trabaja la tarea T1.6 de docs/10-roadmap.md.

1. Lee CLAUDE.md, el CLAUDE.md de la carpeta que vas a tocar y los docs relevantes.
2. Revisa el código existente relacionado antes de escribir nada nuevo.
3. Haz un plan corto (5–10 puntos) y síguelo sin pedirme confirmación, salvo que
   encuentres una contradicción en los docs o una decisión que no esté tomada.
4. Cumple la "Definición de terminado" de CLAUDE.md. Si tocas algo visual, revisa los
   screenshots con Read.
5. Abre un PR con: qué hiciste, cómo lo verificaste, decisiones tomadas y qué quedó
   pendiente. Marca la tarea en el roadmap.
No implementes nada de hitos futuros.
```

## Primer prompt (T0.1)
```
Trabaja la tarea T0.1 de docs/10-roadmap.md. Es la primera sesión: el repo solo tiene
documentación. Lee CLAUDE.md y todos los docs de docs/ (son cortos) para entender el
proyecto completo antes de crear la estructura. Agrega @playwright/test como
dependencia de desarrollo con la versión que muestre `npx playwright --version`
(es la que dejó instalada el setup del entorno). Abre un PR al terminar.
```

## Sprint de créditos cloud (30 oct – 4 nov 2026)
Los USD 250 de crédito cloud **vencen el 5 de noviembre**. Después el desarrollo sigue
en tu computador (ver `12-local-development.md`). Por eso la prioridad en estos días es
**sacarle el máximo de trabajo terminado al crédito**, no ahorrarlo: crédito que sobra
se pierde.

### Olas de trabajo
Cada ola agrupa tareas cuyas dependencias ya están listas y que tocan carpetas
distintas, así que pueden correr **en paralelo, una sesión cada una**. Lanza la ola
siguiente apenas mergees los PRs de la anterior.

| Ola | Tareas en paralelo | Meta de fecha |
|---|---|---|
| 1 | T0.1 | 30 oct |
| 2 | T0.2 · T0.3 · T1.1 | 31 oct |
| 3 | T0.4 · T0.5 · T1.3 | 31 oct – 1 nov |
| 4 | T1.2 · T1.14 | 1 nov |
| 5 | T1.4 · T1.15 | 2 nov |
| 6 | T1.5 | 2 nov |
| 7 | T1.6 · T1.13 · T1.19 | 3 nov |
| 8 | T1.7 · T1.8 | 3 nov |
| 9 | T1.9 · T1.10 · T1.12 | 4 nov |
| 10 | T1.11 · T1.16 | 4 nov |

T1.17 (carga) y T1.18 (deploy) quedan para trabajo local: el deploy necesita tu cuenta
AWS y lo vas a hacer tú de todas formas.

### Si sobra crédito o te quedas esperando un PR
Mientras una ola espera revisión, usa sesiones extra en tareas que no chocan con nada:
- Contenido con las skills `add-item` y `add-monster` (después de T0.3): items y
  monstruos de las islas 1 y 2.
- Archivos de deploy de T1.18 (docker-compose, Caddyfile, guía) sin tocar AWS.
- T2.5 Tauri (después de T1.5), T2.2 editor v2 (después de T1.14), T2.6 admin (después
  de T1.4), T3.2 condiciones (después de T1.9).

### Reglas para el sprint
- **Revisa rápido, pero revisa.** Lee la descripción del PR y los screenshots; si los
  checks de CI pasan y nada se ve raro, mergea. Un error de base arrastrado por tres
  tareas sale caro.
- **Encadena cuando no puedas revisar.** Si vas a estar fuera varias horas, pide a una
  sesión que haga dos tareas seguidas de la misma carpeta (por ejemplo T0.3 y luego
  T0.4) en dos PRs apilados, en vez de dejarla quieta.
- **Anota el costo** de cada sesión en `docs/SESSIONS.md`. Si el 2 de noviembre ves que
  vas a terminar con crédito sobrante, agrega más sesiones paralelas de la lista de
  arriba; si vas justo, prioriza el orden de las olas.
- **CLAUDE.md corto.** Se carga en cada sesión; el detalle vive en `docs/` y se lee
  solo cuando hace falta.
- **Evita reabrir decisiones.** Están en `00-vision.md`. Si cambias de opinión,
  actualiza primero el doc (es barato) y después pide el código.
- **Bugs:** abre una sesión dedicada con el síntoma exacto, cómo reproducirlo y el log;
  pide primero un test que falle y luego el arreglo.
- **No uses sesiones para lo que puedes hacer tú en 2 minutos** (renombrar algo,
  ajustar un número de balance en YAML).

## Tu trabajo en cada ciclo
1. Lanzar la sesión con el prompt.
2. Revisar el PR: leer la descripción, mirar screenshots, probar el juego si hay algo
   jugable (el link de `make dev` local o el deploy).
3. Mergear o pedir cambios en la misma sesión.
4. Anotar costo en `docs/SESSIONS.md`.

## Tareas que son tuyas 👤
| Cuándo | Qué |
|---|---|
| T0.5 | Bajar 1–2 packs de sprites 32x32 con licencia CC0 o CC-BY (OpenGameArt, itch.io con licencia de uso comercial) y subirlos a `assets/vendor/<pack>/` con su archivo de licencia. Las sesiones cloud no pueden descargar de esos sitios. |
| T1.18 | Cuenta AWS, dominio, crear la instancia siguiendo la guía de la sesión |
| T2.1 | Crear las apps OAuth en Google Cloud y Discord Developer Portal |
| Siempre | Probar el juego y decir qué se siente mal: eso no lo puede juzgar la IA |

## Usar a Claude como diseñador de mapas
Desde T1.15 existe el servidor MCP `mcp-world`. En una sesión puedes pedir:
```
Usando las herramientas de mapa, construye en world/islands/puerto/ una cueva en el
piso 8 bajo la colina noreste: entrada por escalera desde el piso 7, 3 cámaras, spawns
de murciélagos y arañas (nivel 6–10) y una veta de minería al fondo. Valida, renderiza
cada cámara, revisa las imágenes y abre un PR con los renders en la descripción.
```
