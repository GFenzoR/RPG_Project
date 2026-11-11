# 14 — Continuar en tu PC (traspaso de la sesión cloud, noviembre 2026)

Hasta el 10 de noviembre de 2026 el desarrollo siguió en una sesión cloud que coordinaba
sesiones hijas: cada una hizo una tarea del roadmap en un PR, y la coordinadora corría
los checks y la revisión de cada PR antes de mergearlo. Este doc deja todo listo para
seguir con Claude Code en tu computador. El entorno local está en
`12-local-development.md`, y el hosting de pruebas en casa, en `13-hosting-de-pruebas.md`.

## Dónde quedó
- **Hitos 0 a 4:** completos, salvo las dos tareas que son tuyas:
  - T0.5, sprites;
  - T1.18, deploy en AWS.
- **Hito 5:** hechas T5.1 a T5.5 (PRs #69 a #74):
  - gremios;
  - PvP con skulls y guerras de gremios;
  - mercado global e intercambio directo;
  - casas;
  - Isla Volcánica, con el Capítulo 3 y las monedas de plata y oro.
- **Faltan** T5.6 (controles táctiles y móvil) y T5.7 (tienda cosmética).
- Las 175 rutas de sprite del juego son placeholders (cuadros de color con sigla), y el
  cuerpo del jugador es un rectángulo de color.

## Primer arranque en tu PC
1. Sigue "Instalar una vez" de `12-local-development.md`. En Windows, usa WSL2 con el repo
   dentro de WSL.
2. Corre `make setup`, `make db-up` y `make dev`, y abre `http://localhost:5173/` (sitio) y
   `http://localhost:5173/play/` (juego).
3. Para que otros entren desde tu red o desde internet, usa `make home-up` (`13-hosting-de-pruebas.md`).
4. Juega 10 minutos y anota lo que se siente mal. Es lo que la IA no puede juzgar sola.

## Lo que es tuyo 👤
| Qué | Para qué | Dónde está explicado |
|---|---|---|
| Elegir y subir 1–2 packs de sprites 32x32 (CC0, CC-BY u OGA-BY) | T0.5: arte real | "Sprites" más abajo, `assets/README.md` |
| Confirmar CC BY 4.0 para los mapas que manda la comunidad | Portal de mapas (T4.5) | `04-map-editor-and-ai.md` |
| Cuenta de AWS y dominio | T1.18: servidor público | `09-deployment-aws.md` |
| Apps OAuth de Google y Discord, y SMTP | Login social y emails (T2.1) | `12-local-development.md` |
| Cuenta bot de GitHub (token classic con `public_repo`, fuera de MAINTAINERS) | Que los mapas aprobados se vuelvan PRs | `09-deployment-aws.md` |
| Protección de la rama `main` y la variable `DESKTOP_SERVER_URL` del repo | Seguridad y builds de escritorio | `09-deployment-aws.md` |
| Copiar a `deploy/.env.example` las variables nuevas que lista docs/09 | Configuración del deploy | `09-deployment-aws.md` |
| Cuentas de Apple y Google Play (opcional) | Apps móviles nativas (T5.6) | brief de T5.6 |
| Elegir el proveedor de pagos | T5.7 en producción | brief de T5.7 |

## Orden sugerido
1. **T0.5, integración de sprites**, en cuanto subas los packs. Prompt para la sesión:
   "Integra los packs de `assets/vendor/` siguiendo `assets/README.md`, mapea en
   `assets/sprites.yaml` todo lo que cubran, deja placeholder lo que no y revisa los
   screenshots y el atlas con Read". La tienda cosmética necesita el arte del jugador, así
   que conviene que esto vaya antes de T5.7.
2. **T5.6**, con el brief de abajo.
3. **T5.7**, con el brief de abajo.

## Cómo trabajar en local (lo que aprendimos en la nube)
- **Una tarea, una sesión, un PR.** Usa `/roadmap-task T5.6` o pega el brief. Pide un plan
  corto y deja que trabaje.
- **Antes de mergear:**
  - corre `make lint test validate`, `make test-integration` y `make e2e`, y mira los
    screenshots que cambiaron;
  - juega lo que cambió;
  - pide a la sesión que pase el diff por `code-reviewer`;
  - en tareas grandes, abre una segunda sesión solo para revisar ("revisa el PR #N buscando
    bugs reales, con un test que lo reproduzca") y pásale sus hallazgos a la primera.
- **Errores que se repitieron y conviene pedir que se revisen:**
  - mover items u oro entre personajes, el mercado o casas va siempre en un transfer del
    Saver, junto con los snapshots (docs/01 "Transacciones"), y con el modo de falla
    segura en mente;
  - el check `map-pr` valida el mapa con el `data/` y el `i18n/` de `main`: el contenido
    nuevo va en un PR antes del mapa que lo usa;
  - el vuelto de los pagos tiene que entrar en la mochila (T5.5);
  - nada de textos sin i18n, y nombres, textos y números originales (regla legal);
  - tests que digan lo que prueban y e2e que confirmen la respuesta del servidor, no
    solo el estado local del cliente.
- **Si la CI falla sin crear jobs**, es un problema de GitHub Actions: relánzala.

## Pendientes conocidos (no bloquean)
- **Interfaz** (entran en T5.6):
  - el mapa baja a zoom 1x cuando la ayuda del encabezado ocupa muchas líneas;
  - los mensajes del servidor quedan fuera de vista;
  - los nombres se pisan a 1x.
- **Mundo:**
  - puertas con llave (la puerta sellada de la mina es narrativa);
  - suelos volcánicos y carteles de Brasal;
  - editor de casas (hoy se editan en YAML).
- **PvP:**
  - una condición de otro jugador pierde a su autor tras un relogueo;
  - los hechizos de condición a distancia solo afectan a monstruos;
  - las marcas son placeholders dibujados.
- **Mercado:**
  - la ventana de quien mira un libro no se refresca con la acción de otro;
  - la falla segura tiene un límite documentado (lo que sale por el suelo antes de que
    reaccione).
- **Tests:** "Play leads to the login and into the game" (`site.spec.ts`) falló una vez
  por un timeout de 5 s al final de un e2e completo. Si se repite, súbele el timeout.

## T5.6: brief
Implementa **T5.6 Controles táctiles y cliente móvil** de docs/10-roadmap.md (Hito 5). docs/00 dice: plataforma PC primero, móvil secundario. Esta tarea hace que el cliente web se juegue bien en un teléfono o una tablet y en ventanas chicas de escritorio, y deja preparado Tauri mobile. Las apps nativas firmadas para las tiendas son 👤 del dueño (cuentas de Apple y Google).

### Alcance (rama `feat/t5.6-touch`, desde main)

#### 1. Controles táctiles (client/src/input, como prevé client/CLAUDE.md)
- **Caminar:**
  - tocar una casilla camina hasta ella, con el pathfinding que ya existe;
  - además, un pad direccional en pantalla, opcional y activable en Opciones, para pasos de a uno;
  - mantener presionado repite el paso.
- **Atacar o hablar:**
  - tocar una criatura la marca como objetivo, igual que el click derecho de hoy;
  - tocar a un NPC lo habla;
  - un toque largo, o un botón de acción contextual, reemplaza el click derecho sobre items y casillas: usar, abrir, mirar (Mayús+click) y mover.
- **Items:**
  - arrastrar con el dedo entre inventario, contenedores y suelo, con las mismas reglas del servidor;
  - una alternativa sin arrastre: tocar el item, después tocar el destino.
- **Hotbar:** tocable, y en pantallas chicas se reduce a los slots que entren con un deslizador.
- **Chat:** el teclado virtual no tapa el input. Al escribir, el juego no recibe teclas.
- **Lógica pura y testeable:** gestos (toque, toque largo, arrastre, pellizco si lo usas para zoom) separados del DOM, con Vitest. `pointer events` y no APIs viejas de touch, salvo que haga falta.

#### 2. Layout para pantallas chicas y ventanas chicas
Tres arreglos que vienen de screenshots de tareas anteriores:
- **Encabezado:** a 1280x800, un nombre largo con la experiencia hace que la ayuda de controles pase a 6 líneas. El encabezado crece y el mapa baja de zoom 2x a 1x (screenshots 47, 49, 50 y 63–66). Acórtalo o pliégalo para que el mapa no pierda zoom.
- **Mensajes del servidor:** el log de mensajes (`ul.log`, rechazos de PvP, bloqueo de logout y avisos del mercado o la casa) queda debajo del inventario y las habilidades en el panel lateral, fuera de vista a 1280x800. Haz que los avisos importantes se vean siempre; por ejemplo, un toast o una línea de estado sobre el mapa, además del log.
- **Nombres a zoom 1x:** los nombres, las etiquetas de gremio y las marcas de criaturas vecinas se pisan. Busca una regla simple: apilar, acortar o mostrar solo el objetivo y los cercanos.

Y en general:
- **Teléfono vertical y horizontal, y tablet:**
  - el mapa ocupa lo principal;
  - el panel lateral pasa a pestañas o a un cajón: batalla, grupo, gremio, inventario, habilidades y chat;
  - las ventanas (NPC, tienda, mercado, intercambio, casa, gremio y tutorial) entran en pantalla y se cierran con un botón grande.
- **Sitio público:** que las páginas también se vean bien en teléfono. Ya hay un e2e "desktop y phone"; amplíalo si cambias algo.
- **Accesibilidad:** objetivos táctiles de 44 px como mínimo, foco visible y nada que dependa solo de hover.

#### 3. Instalable
- **PWA:** manifest (nombre, íconos placeholder, `display: standalone`, orientación) y service worker *solo* para el shell estático; nunca para la API ni el WebSocket.
  - Se instala desde el navegador, sin tiendas.
  - Documenta en docs/09/12/13 que Caddy lo sirve con las cabeceras correctas.
- **Tauri mobile:**
  - Deja preparado `apps/desktop` (o un `apps/mobile` si es más limpio) para `tauri android init` / `tauri ios init`: configuración, capabilities y el selector de servidor de T2.x.
  - Documenta los pasos 👤 en un doc: SDKs, firma y cuentas de las tiendas.
  - No hace falta compilar el APK aquí si el entorno no tiene el SDK de Android. Dilo en el PR.

#### 4. Tests
- Vitest de la lógica de gestos y del layout responsivo, con los breakpoints como datos.
- E2E con Playwright y un dispositivo emulado (por ejemplo `devices['Pixel 7']` y `devices['iPad Mini']`):
  - entrar al juego, caminar tocando y con el pad;
  - atacar a una criatura con un toque;
  - hablar con un NPC;
  - mover un item del inventario al suelo con toque y destino;
  - abrir el chat.
  - Screenshots revisados con Read, en vertical y en horizontal.
- Que nada de escritorio cambie de comportamiento: los e2e existentes siguen en verde.
- Un screenshot a 1280x800 con un personaje de nombre largo muestra el mapa a 2x.

#### 5. Docs
- client/CLAUDE.md (input táctil, layout).
- docs/00 (la línea de plataforma no cambia: móvil sigue siendo secundario).
- docs/08 (e2e móvil) y el doc de instalación móvil.
- T5.6 marcada en el roadmap, con lo 👤 pendiente.

#### Reglas
- Servidor autoritativo: el cliente solo envía intenciones, igual que con el mouse.
- Nada de strings hardcodeados.
- Sin dependencias pesadas nuevas. Si agregas una, que tenga licencia compatible y esté justificada.

#### Cómo trabajar
1. **Lee primero:**
   - CLAUDE.md, client/CLAUDE.md y apps/desktop/CLAUDE.md;
   - docs/00, docs/05, docs/07 (presupuesto del cliente), docs/08 y docs/12/13;
   - `client/src/input`, `game.ts`, `ui/App.tsx`, `client.css` y los e2e.
2. **Haz un plan corto y síguelo** sin pedir confirmación.
3. **Definición de terminado:**
   - `make lint test validate` y `make e2e` en verde, más `make test-integration` si tocas algo del servidor;
   - screenshots revisados;
   - `code-reviewer` una vez;
   - docs actualizados;
   - si cambias rutas que filtra la CI, revisa `.github/scripts/ci-changes.sh` y su `self_test`.
4. Título del PR en inglés, estilo Conventional Commits (por ejemplo `feat(client): touch controls and small-screen layout (T5.6)`); la descripción, en español.

## T5.7: brief
Implementa **T5.7 Tienda cosmética con pasarela de pago** de `10-roadmap.md`. Decisiones
cerradas (`00-vision.md`): la monetización es solo cosmética, nunca da ventaja de juego,
y el modelo ya prevé las tablas `cosmetics` y `account_cosmetics`.

### Alcance (rama `feat/t5.7-cosmetics`, desde main, idealmente después de T0.5)
- **Diseño en docs/02 ("Tienda cosmética"):**
  - Una moneda premium con nombre propio, comprada con dinero real. No se puede
    intercambiar, ni pasa por el mercado ni se convierte en oro: así no compra ventaja
    por la puerta de atrás.
  - Catálogo en `data/cosmetics.yaml`, validado con esquema e i18n: atuendos y colores
    del personaje, adornos visuales y quizá un marco del nombre.
  - Nada que cambie stats, velocidad, XP, botín, capacidad ni tiempos.
  - Sin cajas de botín: cada compra es exactamente lo que se ve.
  - Lo comprado es de la cuenta (`account_cosmetics`) y se equipa por personaje.
  - Política de reembolso y de cuentas suspendidas.
- **Pagos:**
  - Una interfaz de proveedor (`server/internal/payments`) con dos implementaciones:
    - un proveedor falso, para tests y e2e;
    - el del proveedor que elijas, en modo prueba (por ejemplo Stripe o Mercado Pago).
  - Checkout alojado por el proveedor: el servidor nunca toca datos de tarjeta.
  - Webhook con firma verificada e idempotencia por id de evento.
  - Acreditación en una transacción con un log auditable.
  - Reembolsos y contracargos que descuentan saldo, y si no alcanza, marcan la cuenta.
  - Límites por cuenta.
  - Las claves van por variables de entorno, nunca en el repo.
  - Todo apagado si no hay proveedor configurado.
- **Servidor:**
  - Compra con saldo y equipar o desequipar por mensaje de protocolo.
  - Los cosméticos equipados viajan en `Creature`, y el render los dibuja.
  - Comando de staff para dar o quitar saldo y ver compras, auditado.
- **Cliente y sitio:**
  - Tienda en el sitio (`/shop`, solo con sesión iniciada), con el saldo, el catálogo y el
    historial.
  - En el juego, un panel para equipar lo comprado.
  - Textos en es y en.
- **Tests:**
  - firma y webhook duplicado;
  - concurrencia de compras;
  - que ningún cosmético cambie el combate (sim);
  - integración con Postgres;
  - e2e con el proveedor falso: comprar saldo, comprar un atuendo, equiparlo y verlo en
    otro jugador.
- **Docs:** docs/01, 02, 05, 06 y 09 (variables del proveedor y webhook en Caddy), y el
  roadmap.

## Sprites: qué cubrir
Las rutas lógicas de `assets/sprites.yaml` y `data/`, con el nombre en español de lo que
las usa. Un pack no tiene que cubrir todo: lo que falte queda como placeholder.

**Jugadores:** un set de personaje humano con 4 direcciones e, idealmente, animación de
caminar. Hoy no tiene ruta propia: el cliente dibuja un rectángulo. Los NPCs de abajo
pueden salir del mismo set.

**Suelos** (9)

- `ground/dirt`: tierra
- `ground/dock_planks`: tablones de muelle
- `ground/grass`: pasto
- `ground/sand`: arena
- `ground/stone_floor`: suelo de piedra
- `ground/water_shallow`: agua poco profunda
- `ground/water_shoal`: agua con peces
- `ground/wet_sand`: arena mojada
- `ground/wooden_floor`: suelo de madera

**Muros** (3)

- `walls/rock_wall`: pared de roca
- `walls/stone_wall`: muro de piedra
- `walls/wooden_wall`: muro de madera

**Decoración y estaciones** (17)

- `decor/anvil`: yunque
- `decor/birch_tree`: abedul
- `decor/boulder`: peñasco
- `decor/bush`: arbusto
- `decor/cargo_crate`: cajón de carga
- `decor/cooking_hearth`: fogón
- `decor/creature_remains`: restos de criatura
- `decor/elm_tree`: olmo
- `decor/ember_vein`: veta de ascua
- `decor/iron_vein`: veta de hierro
- `decor/market_board`: tablero del mercado
- `decor/mooring_post`: bolardo de amarre
- `decor/oak_tree`: roble
- `decor/pine_tree`: pino
- `decor/smelting_forge`: fragua
- `decor/stairs_down`: escalera hacia abajo
- `decor/stairs_up`: escalera hacia arriba

**Criaturas** (21)

- `creatures/ash_hound`: sabueso de ceniza
- `creatures/bilge_rat`: rata de sentina
- `creatures/bramble_stag`: ciervo de zarza
- `creatures/bristleback_boar`: jabalí cerdoso
- `creatures/cinder_salamander`: salamandra de brasa
- `creatures/coffer_smuggler`: contrabandista del cofre
- `creatures/drowned_miner`: minero ahogado
- `creatures/ember_wyrmling`: dragoncillo de ascua
- `creatures/gloom_bat`: murciélago lóbrego
- `creatures/hollow_crawler`: reptante hueco
- `creatures/mire_toad`: sapo de ciénaga
- `creatures/moss_spider`: araña de musgo
- `creatures/obsidian_delver`: minero de obsidiana
- `creatures/ore_beetle`: escarabajo de mena
- `creatures/slag_golem`: gólem de escoria
- `creatures/slagbound_warden`: custodio de escoria
- `creatures/thieving_gull`: gaviota ladrona
- `creatures/thornling`: espinoso
- `creatures/tide_crab`: cangrejo de marea
- `creatures/wolf`: lobo
- `creatures/wreck_looter`: saqueador de naufragios

**NPCs (personajes humanos)** (15)

- `npcs/armorer`: Bastian Roe, armero
- `npcs/diver_old`: Corvo, el buzo
- `npcs/druid_elder`: Velia Musgo, druida del bosque
- `npcs/ferryman`: Tavin Rema, barquero
- `npcs/ferryman_volcanic`: Nerea Vado, capitana
- `npcs/forge_echo`: eco de la forja
- `npcs/forge_keeper`: Casia Hollín, guardiana de los registros
- `npcs/merchant`: Tilde Varga, provisiones
- `npcs/miner_old`: Doran Pike, capataz
- `npcs/priest_forest`: hermano Olmar
- `npcs/priest_volcanic`: madre Oriela
- `npcs/priestess`: Hermana Liora
- `npcs/sailor_old`: Maren Holt, jefa del puerto
- `npcs/smith_volcanic`: Bram Tizón, herrero
- `npcs/tanner`: Gisla, la curtidora

**Armas** (18)

- `weapons/bearded_axe`: hacha barbada
- `weapons/belaying_pin`: cabilla
- `weapons/boarding_saber`: sable de abordaje
- `weapons/coral_wand`: varita de coral
- `weapons/driftwood_club`: garrote de madera de deriva
- `weapons/embersteel_axe`: hacha de acero de ascua
- `weapons/embersteel_sabre`: sable de acero de ascua
- `weapons/forged_shortsword`: espada corta forjada
- `weapons/hatchet`: hacha de mano
- `weapons/iron_sword`: espada de hierro
- `weapons/rimewood_staff`: vara de escarcha
- `weapons/rusty_cutlass`: alfanje oxidado
- `weapons/sapling_staff`: vara de retoño
- `weapons/short_bow`: arco corto
- `weapons/spiked_cudgel`: porra claveteada
- `weapons/thornwood_blade`: hoja de espino
- `weapons/wyrmfang_blade`: hoja de colmillo de dragoncillo
- `weapons/yew_longbow`: arco largo de tejo

**Armaduras** (11)

- `armor/canvas_trousers`: pantalones de lona
- `armor/embersteel_cuirass`: coraza de acero de ascua
- `armor/embersteel_helm`: yelmo de acero de ascua
- `armor/hide_vest`: chaleco de piel
- `armor/leather_jerkin`: jubón de cuero
- `armor/patched_tunic`: túnica remendada
- `armor/sailcloth_cap`: gorro de lona
- `armor/stagleather_coat`: abrigo de cuero de ciervo
- `armor/stagleather_leggings`: perneras de cuero de ciervo
- `armor/tarred_boots`: botas alquitranadas
- `armor/wyrmscale_mail`: cota de escamas de dragoncillo

**Escudos** (5)

- `shields/barrel_lid_shield`: tapa de barril
- `shields/elmwood_shield`: escudo de olmo
- `shields/embersteel_shield`: escudo de acero de ascua
- `shields/plank_shield`: escudo de tablones
- `shields/riveted_round_shield`: rodela remachada

**Munición** (1)

- `ammo/arrow`: flecha

**Runas** (1)

- `runes/arc_rune`: runa de arco

**Herramientas** (6)

- `tools/felling_axe`: hacha de leñador
- `tools/fishing_rod`: caña de pescar
- `tools/pickaxe`: pico
- `tools/rope`: cuerda
- `tools/shovel`: pala
- `tools/smithing_hammer`: martillo de herrero

**Contenedores** (1)

- `containers/backpack`: mochila

**Monedas** (3)

- `currency/copper_coin`: moneda de cobre
- `currency/gold_coin`: moneda de oro
- `currency/silver_coin`: moneda de plata

**Comida** (8)

- `food/boar_meat`: carne de jabalí
- `food/glowcap_broth`: caldo de hongo lumbre
- `food/grilled_fish`: pescado a la brasa
- `food/harbour_stew`: guiso del puerto
- `food/raw_fish`: pescado crudo
- `food/roast_boar`: jabalí asado
- `food/seaweed_poultice`: cataplasma de algas
- `food/ship_biscuit`: galleta de barco

**Materiales** (26)

- `materials/ash_pelt`: piel de sabueso de ceniza
- `materials/bat_wing`: ala de murciélago
- `materials/beetle_carapace`: caparazón de escarabajo
- `materials/birch_log`: tronco de abedul
- `materials/boar_tusk`: colmillo de jabalí
- `materials/crab_claw`: pinza de cangrejo
- `materials/crawler_chitin`: quitina de reptante
- `materials/elm_log`: tronco de olmo
- `materials/ember_ore`: mineral de ascua
- `materials/embersteel_ingot`: lingote de acero de ascua
- `materials/glowcap`: hongo lumbre
- `materials/gull_feather`: pluma de gaviota
- `materials/iron_ingot`: lingote de hierro
- `materials/iron_ore`: mineral de hierro
- `materials/quartz_crystal`: cristal de cuarzo
- `materials/rough_stone`: piedra tosca
- `materials/salamander_scale`: escama de salamandra
- `materials/slag_core`: núcleo de escoria
- `materials/spider_silk`: seda de araña
- `materials/stag_antler`: asta de ciervo
- `materials/tarnished_locket`: relicario ennegrecido
- `materials/thorn_heartwood`: corazón de espino
- `materials/toad_gland`: glándula de sapo
- `materials/tree_resin`: resina
- `materials/wolf_pelt`: piel de lobo
- `materials/wyrm_scale`: escama de dragoncillo

**Objetos de misión** (6)

- `quest/bosun_logbook`: bitácora del contramaestre
- `quest/delver_chart`: plano de galería
- `quest/ember_root`: raíz de ascua
- `quest/forge_seal`: sello de la forja
- `quest/sealed_coffer`: cofre sellado
- `quest/smuggler_tally`: tarja de contrabandista

**borders** (24)

- `borders/grass_sand_e`: borde de pasto
- `borders/grass_sand_inner_ne`: borde de pasto
- `borders/grass_sand_inner_nw`: borde de pasto
- `borders/grass_sand_inner_se`: borde de pasto
- `borders/grass_sand_inner_sw`: borde de pasto
- `borders/grass_sand_n`: borde de pasto
- `borders/grass_sand_ne`: borde de pasto
- `borders/grass_sand_nw`: borde de pasto
- `borders/grass_sand_s`: borde de pasto
- `borders/grass_sand_se`: borde de pasto
- `borders/grass_sand_sw`: borde de pasto
- `borders/grass_sand_w`: borde de pasto
- `borders/sand_water_e`: orilla de arena
- `borders/sand_water_inner_ne`: orilla de arena
- `borders/sand_water_inner_nw`: orilla de arena
- `borders/sand_water_inner_se`: orilla de arena
- `borders/sand_water_inner_sw`: orilla de arena
- `borders/sand_water_n`: orilla de arena
- `borders/sand_water_ne`: orilla de arena
- `borders/sand_water_nw`: orilla de arena
- `borders/sand_water_s`: orilla de arena
- `borders/sand_water_se`: orilla de arena
- `borders/sand_water_sw`: orilla de arena
- `borders/sand_water_w`: orilla de arena

