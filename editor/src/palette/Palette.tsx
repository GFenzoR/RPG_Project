// Palette: every item in data/items, searchable by ID or translated name, by category.
import { useMemo, useState } from "preact/hooks";
import type { Atlas } from "@rpg/renderer";
import type { Translate } from "../i18n.ts";
import type { PaletteItem } from "../io/wire.ts";

export interface PaletteProps {
  items: PaletteItem[];
  atlas: Atlas;
  t: Translate;
  ground: string;
  item: string;
  onPick: (id: string) => void;
}

/** Items whose ID or name contains every word of the query (case-insensitive). */
export function filterItems(
  items: PaletteItem[],
  query: string,
  category: string,
  name: (i: PaletteItem) => string,
): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => {
    if (category !== "all" && i.kind !== category) return false;
    const hay = `${i.id} ${name(i)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function Swatch({ atlas, sprite }: { atlas: Atlas; sprite: string }) {
  const tex = atlas.texture(sprite);
  const page = atlas.index.sprites[sprite]?.page;
  if (!tex || page === undefined) return <span class="swatch missing" />;
  const f = tex.frame;
  const scale = 32 / Math.max(f.width, f.height);
  return (
    <span
      class="swatch"
      style={{
        backgroundImage: `url(/atlas/${atlas.index.pages[page]?.replace(/\.json$/, ".png") ?? ""})`,
        backgroundPosition: `${-f.x * scale}px ${-f.y * scale}px`,
        backgroundSize: `${tex.source.width * scale}px ${tex.source.height * scale}px`,
        width: `${f.width * scale}px`,
        height: `${f.height * scale}px`,
      }}
    />
  );
}

export function Palette({ items, atlas, t, ground, item, onPick }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  // Grounds first (the brush is the main tool), then the other kinds alphabetically.
  const kinds = useMemo(() => {
    const set = [...new Set(items.map((i) => i.kind))].sort();
    return ["all", ...set.filter((k) => k === "ground"), ...set.filter((k) => k !== "ground")];
  }, [items]);
  const name = (i: PaletteItem): string => t(i.name);
  const shown = filterItems(items, query, category, name);
  return (
    <section class="panel palette" aria-label={t("editor.palette")}>
      <h2>{t("editor.palette")}</h2>
      <input
        type="search"
        data-testid="palette-search"
        placeholder={t("editor.search")}
        value={query}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <div class="categories">
        {kinds.map((k) => (
          <button
            key={k}
            class={k === category ? "active" : ""}
            data-testid={`category-${k}`}
            onClick={() => setCategory(k)}
          >
            {t(`editor.category.${k}`)}
          </button>
        ))}
      </div>
      <ul class="items">
        {shown.length === 0 && <li class="empty">{t("editor.no_items")}</li>}
        {shown.map((i) => (
          <li key={i.id}>
            <button
              data-testid={`palette-${i.id}`}
              class={i.id === ground || i.id === item ? "selected" : ""}
              title={i.id}
              onClick={() => onPick(i.id)}
            >
              <Swatch atlas={atlas} sprite={i.sprite} />
              <span class="name">{name(i)}</span>
              <span class="id">{i.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
