# 02 — Diseño de juego

Todos los números de este documento son **valores iniciales** que viven en
`data/balance.yaml`. El código lee de ahí; nunca hardcodees una constante de balance.

## Movimiento
- Por casillas, 8 direcciones (diagonal más lenta: ×1.5 de costo como en Tibia clásico).
- Duración de un paso = `base_step_ms × terreno / velocidad`. La velocidad crece con el
  nivel y con efectos (haste, paralyze).
- Click-to-walk con pathfinding A* en el servidor (máx. 100 casillas).
- Cambiar de piso: escaleras, rampas, cuerdas, agujeros, escaleras de mano.

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
- MVP: Guardián y Arcanista. Montaraz y Druida en el hito 3.

## Experiencia y nivel
- Experiencia por matar monstruos (repartida en grupo según daño), por quests y por
  algunos oficios (poca).
- Curva cúbica propia, ajustable: `xp(nivel) = a·n³ + b·n² + c·n` con coeficientes en
  balance.yaml. Objetivo de ritmo: nivel 8 en ~1 h, nivel 20 en ~8 h, nivel 50 en ~80 h.
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

### Oficios
| Oficio | Acción | Produce |
|---|---|---|
| Minería | Usar pico sobre vetas | Minerales, piedras preciosas |
| Leñador | Usar hacha de leña sobre árboles talables | Madera |
| Herrería | Usar un yunque con materiales y receta | Armas, armaduras, herramientas |
| Cocina | Usar horno/fogata con ingredientes | Comida con buffs pequeños |
| Alquimia (hito posterior) | Mesa de alquimia | Pociones |

- Recetas en `data/recipes.yaml` con nivel de oficio requerido, materiales y chance de
  éxito que mejora con el nivel.
- Los oficios son **independientes de la vocación**: cualquiera puede ser herrero.
- MVP: Pesca y Minería. Herrería y Cocina en el hito 3.

### Anti-bot y anti-AFK (desde el inicio)
- Entrenar contra un objetivo que no responde da progreso reducido tras X minutos.
- Recursos (vetas, árboles, peces) se agotan y regeneran.
- Rate limit de acciones y detección de patrones en el hito de lanzamiento.

## Combate
- Seleccionas un objetivo (click o hotkey) y el personaje ataca solo cada **2 s** si está
  en rango. Modos: ofensivo / equilibrado / defensivo, y perseguir / quedarse quieto.
- Daño físico: `skill_arma × ataque_arma × factor_modo × aleatorio` contra
  `armadura` (reducción plana aleatoria) y `defensa` (escudo, bloquea por golpe).
- Daño mágico: `nivel_mágico × base_hechizo + nivel × factor` con rango aleatorio.
- Elementos: físico, fuego, hielo, energía, tierra, sagrado, muerte. Monstruos tienen
  resistencias porcentuales en su YAML.
- Hechizos que se lanzan escribiendo sus palabras mágicas o con hotkey, con cooldown
  individual y por grupo (ataque / curación / soporte). Las palabras mágicas son
  inventadas por nosotros: nunca uses las de Tibia.
- Runas: items de uso con carga; las crea el mago gastando maná.
- Condiciones: veneno, fuego, eléctrico, paralyze, haste, invisibilidad (hito 3).
- Zonas de protección: no se puede atacar ni ser atacado.

## Monstruos
- Definidos en `data/monsters/*.yaml`: stats, ataques (melee, a distancia, hechizos con
  área), resistencias, loot con probabilidades, experiencia, comportamiento.
- IA simple por estados: `idle → alerta → perseguir → atacar → huir (con poca vida)`.
- Spawns en el mapa con radio, cantidad y tiempo de respawn. El respawn no ocurre si un
  jugador está mirando el punto (evita aparecer en la cara).

## Muerte
Valores iniciales (balance.yaml):
- Pierdes **10 %** de la experiencia total y **10 %** del progreso de cada skill (sin
  bajar del nivel 1 ni de skills base).
- Cada pieza equipada tiene **10 %** de chance de caer al cuerpo; la mochila cae con
  **100 %** salvo con bendiciones.
- **Bendiciones** (hasta 5, se compran con oro del juego a NPCs en templos):
  cada una reduce la pérdida; con las 5 no pierdes items y la pérdida de XP baja a ~3 %.
- Reapareces en el templo de tu ciudad de residencia.
- Niveles 1–8: protección de novato (pérdida mínima, sin drop).
- El cuerpo queda en el suelo X minutos con el loot (solo el dueño puede tomarlo
  los primeros minutos; regla pensada para cuando haya PvP).

## Economía
- Monedas de oro, plata, cobre (100:1).
- NPCs compran y venden con precios en `data/npcs/*.yaml`. Los NPCs compran barato
  para que el comercio entre jugadores tenga sentido.
- **Trade directo**: ventana de intercambio con confirmación doble. Transacción atómica.
- Mercado global: hito posterior. El inventario ya es transaccional para soportarlo.
- Sumideros de oro: bendiciones, viajes en barco, reparaciones, recetas de oficio.
- Log de economía para detectar duplicación y bots.

## Mundo e islas (estructura inicial)
| Isla | Nivel sugerido | Rol |
|---|---|---|
| Isla del Puerto (inicial) | 1–15 | Tutorial, primera ciudad, Capítulo 1 |
| Isla del Bosque | 10–30 | Druidas, bestias, minería básica |
| Isla Volcánica | 25–60 | Herrería avanzada, dragones jóvenes |
| Islas Heladas | 40–80 | Hielo, mazmorras profundas |
| Isla Hundida | 70+ | Ruinas del imperio antiguo, final de la historia actual |

- Viaje entre islas: NPC capitán de barco, cuesta oro, requiere nivel o quest para
  algunas rutas.
- Cada isla tiene superficie (piso 7), subterráneos (8–12) y alturas (6–4).

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

## Diálogos de NPC
- Ventana con texto del NPC y opciones clickeables (también seleccionables con 1–9).
- Árbol definido en YAML con condiciones (nivel, vocación, flag de quest, item en
  inventario) y acciones (dar/quitar item, set flag, abrir tienda, viajar, curar).
- Ver `06-content-data.md`.

## Cosméticos (monetización futura)
- Outfits, colores de outfit, monturas (solo visual y velocidad igual para todos),
  efectos de nombre. Se compran con una moneda premium (cuando exista la tienda) y
  algunos se ganan en el juego.
- Regla: **ningún cosmético da ventaja de juego**.

## PvP (futuro, ya contemplado)
- Campos `skull`, `pvp_flags`, zonas `pvp` y `no_pvp` en el modelo.
- Sistema de skulls tipo Tibia y castigo por asesinatos injustificados.
