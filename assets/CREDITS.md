# Créditos de assets

Todo asset de terceros debe tener una entrada aquí antes de usarse en el juego.
Licencias aceptadas: CC0, CC-BY 3.0/4.0, OGA-BY. **No** se aceptan assets sin licencia
clara, con licencia "no comercial" ni sacados de otros juegos.

`tools/spritepack` solo acepta un pack de `assets/vendor/<pack>/` si tiene una fila aquí
con esa carpeta y un archivo `LICENSE` dentro. Procedimiento completo: `assets/README.md`.

| Pack / archivo | Autor | Licencia | Fuente (URL) | Carpeta | Atribución requerida |
|---|---|---|---|---|---|
| | | | | `assets/vendor/...` | |

## Obra propia

| Archivos | Autor | Licencia | Fuente reproducible |
|---|---|---|---|
| `assets/sounds/**/*.ogg` (efectos, interfaz, música y ambiente) | RPG Project (generado proceduralmente) | CC0 1.0 | `tools/soundgen` (`make sounds`). Recetas y melodías propias, sin muestras externas |
| Marcas PvP (T5.2): icono de skull del canvas y de la lista de batalla | RPG Project | CC0 1.0 | Dibujado con formas en el código, sin imagen (`client/src/render/game-canvas.ts` `drawSkull`, `client/src/ui/client.css` `.skull`). Placeholder hasta tener sprite |
| Isla Volcánica (T5.5): sprites de sus monstruos, NPCs, items y la veta de ascua; monedas de plata y oro | RPG Project | CC0 1.0 | Placeholders generados por `tools/spritepack` desde `assets/sprites.yaml` (`placeholder`: cuadro de color con sigla). Arte real pendiente del dueño. Música y ambiente de la isla: placeholders que reutilizan `music_cueva` y `amb_olas` (`assets/sounds.yaml`) |
