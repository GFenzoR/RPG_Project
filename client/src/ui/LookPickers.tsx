// The pickers of a player's look (docs/02 "Apariencia"): sex (man or woman, first), body,
// skin, hair style, hair colour and beard, the choices of data/looks.yaml in file order (ClientContent.lookOptions).
// The creation screen and the Apariencia window use them with the live figure
// (ui/LookPreview.tsx). No hooks: the look is the caller's (ui/LookPickers.test.ts walks the
// tree without a DOM). Every name is i18n: appearance.<part>.<id>.
import type { JSX } from "preact";
import type { Look, LookTables } from "@rpg/renderer/look";
import type { LookOptions } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { withSex } from "../state/look.ts";

/**
 * A part of the look: its field, its list of choices, the i18n segment of its names
 * (appearance.<key>.<id>) and its label.
 */
interface Part {
  field: keyof Look;
  list: (o: LookOptions) => readonly string[];
  key: string;
  label: string;
  /** Colours of the choices (a swatch each) instead of names. */
  colors?: (t: LookTables) => Readonly<Record<string, number>>;
}

export const LOOK_PARTS: readonly Part[] = [
  { field: "sex", list: (o) => o.sexes, key: "sex", label: "client.look.sex" },
  { field: "body", list: (o) => o.builds, key: "body", label: "client.look.body" },
  {
    field: "skin",
    list: (o) => o.skins,
    key: "skin",
    label: "client.look.skin",
    colors: (t) => t.skins,
  },
  { field: "hair", list: (o) => o.hairStyles, key: "hair", label: "client.look.hair" },
  {
    field: "hairColor",
    list: (o) => o.hairColors,
    key: "hair_color",
    label: "client.look.hair_color",
    colors: (t) => t.hairColors,
  },
  { field: "beard", list: (o) => o.beards, key: "beard", label: "client.look.beard" },
];

/** "#rrggbb" of 0xrrggbb. */
const css = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

export function LookPickers(props: {
  t: Translate;
  options: LookOptions;
  tables: LookTables | undefined;
  look: Look;
  onChange(look: Look): void;
  /** A "random" button (the creation screen). */
  onRandom?: (() => void) | undefined;
}): JSX.Element {
  const { t, look } = props;
  return (
    <div class="look-pickers" data-testid="look-pickers">
      {LOOK_PARTS.map((part) => {
        const colors = part.colors && props.tables ? part.colors(props.tables) : undefined;
        return (
          <fieldset key={part.field} class="look-part" data-look-part={part.field}>
            <legend>{t(part.label)}</legend>
            <div class={colors ? "look-swatches" : "look-names"}>
              {part.list(props.options).map((id) => {
                const pressed = look[part.field] === id;
                const name = t(`appearance.${part.key}.${id}`);
                const color = colors?.[id];
                return (
                  <button
                    key={id}
                    type="button"
                    class={color === undefined ? "look-choice" : "look-choice swatch"}
                    aria-pressed={pressed}
                    aria-label={color === undefined ? undefined : name}
                    title={color === undefined ? undefined : name}
                    data-look={`${part.field}:${id}`}
                    style={color === undefined ? undefined : { background: css(color) }}
                    onClick={() => {
                      if (pressed) return;
                      // A woman starts with no beard (state/look.ts withSex).
                      props.onChange(
                        part.field === "sex"
                          ? withSex(props.options, look, id)
                          : { ...look, [part.field]: id },
                      );
                    }}
                  >
                    {color === undefined ? name : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      {props.onRandom && (
        <button
          type="button"
          class="link look-random"
          data-testid="look-random"
          onClick={() => props.onRandom?.()}
        >
          {t("client.look.random")}
        </button>
      )}
    </div>
  );
}
