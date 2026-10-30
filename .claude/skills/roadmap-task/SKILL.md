---
name: roadmap-task
description: Ejecuta una tarea del roadmap (por ejemplo T1.6) de punta a punta. Úsala cuando el usuario pida trabajar, continuar o terminar una tarea con ID T<hito>.<n> de docs/10-roadmap.md.
---

# Ejecutar una tarea del roadmap

Argumento: el ID de la tarea (ej. `T1.6`).

## Pasos
1. Abre `docs/10-roadmap.md` y ubica la tarea. Verifica que sus dependencias (entre
   corchetes) estén marcadas como hechas. Si no lo están, detente y dilo.
2. Lee el `CLAUDE.md` de cada carpeta que vas a tocar y los docs de `docs/` relevantes
   (la tabla "Docs a consultar" del CLAUDE.md raíz te dice cuáles).
3. Explora el código existente relacionado. Reutiliza antes de crear.
4. Escribe un plan de 5–10 puntos en tu respuesta y síguelo. No pidas confirmación salvo
   que encuentres una contradicción en los docs o una decisión de diseño que no esté
   tomada en `docs/00-vision.md` o `docs/02-game-design.md`.
5. Implementa en commits pequeños con Conventional Commits.
6. Verifica según `docs/08-testing-and-verification.md`:
   - `make lint test validate`
   - escenario de simulación si es lógica de juego
   - `make e2e` y revisión de screenshots con Read si es visual
7. Si cambiaste un contrato (protocolo, formato de mapa, YAML), actualiza el doc.
8. Marca la tarea en el roadmap con `[x]` y el número de PR.
9. Abre el PR usando `.github/pull_request_template.md`. En "Pendiente" lista lo que no
   alcanzaste, para que una próxima sesión lo retome.

## No hacer
- No implementes funcionalidades de hitos futuros, aunque sean fáciles.
- No cambies decisiones de `docs/00-vision.md`; si crees que una está mal, explícalo en el PR.
- No agregues assets sin licencia verificada.
