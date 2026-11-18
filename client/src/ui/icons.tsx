// The UI's own pixel-art icons (docs/17 UI-2): 16x16 drawings written as text, one
// character per pixel, turned into an inline SVG with one path per colour. Own art (CC0,
// assets/CREDITS.md "Obra propia"), drawn for this game without tracing any other game's
// icons. Inline, so the toolbar shows them before the atlas loads and the desktop app's CSP
// (no inline <style>, images from 'self' or data:) has nothing to object to.
import type { JSX } from "preact";

/** Width and height of every drawing, in pixels. */
export const ICON_SIZE = 16;

/** Colour of each character of a drawing; "." is transparent. */
export const ICON_PALETTE: Readonly<Record<string, string>> = {
  "#": "#0d0a07", // outline
  o: "#b8923f", // gold
  "+": "#e2c47a", // gold, lit
  "-": "#6e5422", // gold, shaded
  s: "#a9a094", // steel
  S: "#5d5750", // steel, shaded
  l: "#8a5a2b", // leather, wood
  L: "#5a3a1c", // leather, shaded
  r: "#b8322a", // red
  R: "#6e1a12", // red, shaded
  b: "#3f6fd0", // blue
  B: "#1d3570", // blue, shaded
  w: "#efe6cf", // parchment, skin
  W: "#b9ab8a", // parchment, shaded
};

/** The drawings, 16 rows of 16 characters each (ui/icons.test.ts checks them). */
export const ICONS = {
  battle: [
    "##............##",
    "#s#..........#s#",
    ".#s#........#s#.",
    "..#s#......#s#..",
    "...#s#....#s#...",
    "....#s#..#s#....",
    ".....#s##s#.....",
    "......#ss#......",
    "......#ss#......",
    ".....#s##s#.....",
    "..#o#s#..#s#o#..",
    "...#o#....#o#...",
    "..#L#o#..#o#L#..",
    ".#L#........#L#.",
    "#o#..........#o#",
    ".#............#.",
  ],
  inventory: [
    "................",
    "......####......",
    ".....#LLLL#.....",
    ".....#L..L#.....",
    "...##########...",
    "..#llllllllll#..",
    "..#l++++++++l#..",
    "..#llllllllll#..",
    "..#LLLLLLLLLL#..",
    "..#llll#oo#ll#..",
    "..#llll#oo#ll#..",
    "..#lllll##lll#..",
    "..#llllllllll#..",
    "..#LLLLLLLLLL#..",
    "...##########...",
    "................",
  ],
  skills: [
    "................",
    "................",
    "................",
    ".######..######.",
    "#wwwwww##wwwwww#",
    "#wWWWWw##wWWWWw#",
    "#wwwwww##wwwwww#",
    "#wWWWww##wWWWWw#",
    "#wwwwww##wwwwww#",
    "#wWWWWw##wWWwww#",
    "#wwwwww##wwwwww#",
    "#WWWwww##wwwWWW#",
    ".###WWW##WWW###.",
    "....###LL###....",
    "................",
    "................",
  ],
  party: [
    "................",
    ".........###....",
    "........#www#...",
    "...###..#wWw#...",
    "..#www#.#www#...",
    "..#wWw#..###....",
    "..#www#.#bbb#...",
    "...###.#bbbbb#..",
    "..#rrr#bbbbbbb#.",
    ".#rrrrr#bbbbbb#.",
    "#rrrrrrr#bbbbb#.",
    "#rrrrrrr#bbbbb#.",
    "#rRrrrRr#BBBBB#.",
    "#rrrrrrr#######.",
    "#########.......",
    "................",
  ],
  guild: [
    "................",
    ".##############.",
    ".#++++++rrrrrr#.",
    ".#+oooo+rRRRRr#.",
    ".#+oooo+rRRRRr#.",
    ".#+oooo+rRRRRr#.",
    ".#++++++rrrrrr#.",
    ".#rrrrrr++++++#.",
    ".#rRRRRr+oooo+#.",
    "..#RRRRr+oooo#..",
    "..#rrrrr+++++#..",
    "...#rrrr++++#...",
    "....#rrr+++#....",
    ".....#rr++#.....",
    "......####......",
    "................",
  ],
  market: [
    "................",
    "................",
    "........####....",
    ".......#++++#...",
    ".......#-oo-#...",
    ".......#++++#...",
    "..####.#-oo-#...",
    ".#++++##++++#...",
    ".#-oo-##-oo-#...",
    ".#++++##++++#...",
    ".#-oo-##-oo-#...",
    ".#++++#######...",
    ".#-oo-#.........",
    "..####..........",
    "................",
    "................",
  ],
  appearance: [
    "................",
    "....###..###....",
    "...#bbb##bbb#...",
    "..#bbbbbbbbbb#..",
    ".#bbbbbbbbbbbb#.",
    "#bbbbbbbbbbbbbb#",
    "#bbB#bbbbbb#Bbb#",
    ".##.#bbbbbb#.##.",
    "....#bbbbbb#....",
    "....#oooooo#....",
    "....#bbbbbb#....",
    "....#bbbbbb#....",
    "....#BbbbbB#....",
    "....#BBBBBB#....",
    ".....######.....",
    "................",
  ],
  options: [
    "................",
    "......####......",
    "..##..#ss#..##..",
    ".#ss##ssss##ss#.",
    ".#ssssssssssss#.",
    "..#sssSSSSsss#..",
    ".##ssS####Sss##.",
    "#sssS#....#Ssss#",
    "#sssS#....#Ssss#",
    ".##ssS####Sss##.",
    "..#sssSSSSsss#..",
    ".#ssssssssssss#.",
    ".#ss##ssss##ss#.",
    "..##..#ss#..##..",
    "......####......",
    "................",
  ],
  help: [
    "................",
    ".....######.....",
    "....#++++++#....",
    "...#+oo##oo+#...",
    "...#oo#..#oo#...",
    "...####..#oo#...",
    ".......##oo#....",
    "......#oo-#.....",
    ".....#oo-#......",
    ".....#oo#.......",
    ".....####.......",
    "................",
    ".....####.......",
    ".....#++#.......",
    ".....####.......",
    "................",
  ],
  logout: [
    "................",
    ".....######.....",
    "....#LLLLLL#....",
    "...#LllLllLl#...",
    "...#LllLllLl#...",
    "...#LllLllLl#...",
    "...#LllLllLl#...",
    "...#LllLlloo#...",
    "...#LllLllLl#...",
    "...#LllLllLl#...",
    "...#LllLllLl#...",
    "...#LllLllLl#...",
    "...#LllLllLl#...",
    "..############..",
    "..#ssssssssss#..",
    "..############..",
  ],
  // The topics of an NPC's dialog options (docs/17 UI-8) and the guild window's buttons
  // (UI-7): a quest scroll, an anchor, a holy cross, a speech bubble, a rank badge, an
  // envelope and a notice.
  quest: [
    "................",
    "...##########...",
    "..#wwwwwwwwww#..",
    "..#wWWWWWWWWw#..",
    "...#ww####ww#...",
    "...#ww#rr#ww#...",
    "...#ww#rr#ww#...",
    "...#ww#rr#ww#...",
    "...#ww#rr#ww#...",
    "...#ww####ww#...",
    "...#ww#rr#ww#...",
    "...#ww####ww#...",
    "..#wWWWWWWWWw#..",
    "..#wwwwwwwwww#..",
    "...##########...",
    "................",
  ],
  travel: [
    "................",
    ".......##.......",
    "......#ss#......",
    "......#ss#......",
    ".......##.......",
    "....########....",
    "....#ssssss#....",
    "....###ss###....",
    "......#ss#......",
    "......#ss#......",
    ".##...#ss#...##.",
    "#s#...#ss#...#s#",
    "#ss#..#ss#..#ss#",
    ".#ss##sSSs##ss#.",
    "..#sssSSSSsss#..",
    "...##########...",
  ],
  services: [
    "................",
    "......####......",
    "......#++#......",
    "......#oo#......",
    "..#####oo#####..",
    "..#++oooooo++#..",
    "..#--oooooo--#..",
    "..#####oo#####..",
    "......#oo#......",
    "......#oo#......",
    "......#oo#......",
    "......#oo#......",
    "......#--#......",
    "......#--#......",
    "......####......",
    "................",
  ],
  talk: [
    "................",
    "................",
    "..############..",
    ".#wwwwwwwwwwww#.",
    ".#wwwwwwwwwwww#.",
    ".#ww##w##w##ww#.",
    ".#ww##w##w##ww#.",
    ".#wwwwwwwwwwww#.",
    ".#WWWWWWWWWWWW#.",
    "..#####WW#####..",
    "......#WW#......",
    ".....#WW#.......",
    "....###.........",
    "................",
    "................",
    "................",
  ],
  ranks: [
    "................",
    "..############..",
    "..#oooooooooo#..",
    "..#o++++++++o#..",
    "..#oooooooooo#..",
    "..#o#oooooo#o#..",
    "..#o##oooo##o#..",
    "..#oo##oo##oo#..",
    "..#ooo####ooo#..",
    "..#o#oooooo#o#..",
    "..#o##oooo##o#..",
    "...#o##oo##o#...",
    "....#o####o#....",
    ".....#oooo#.....",
    "......####......",
    "................",
  ],
  invite: [
    "................",
    "................",
    "................",
    ".##############.",
    ".#wwwwwwwwwwww#.",
    ".##wwwwwwwwww##.",
    ".#w#wwwwwwww#w#.",
    ".#ww#wwwwww#ww#.",
    ".#www##ww##www#.",
    ".#wwww#rr#wwww#.",
    ".#wwwww##wwwww#.",
    ".#WWWWWWWWWWWW#.",
    ".##############.",
    "................",
    "................",
    "................",
  ],
  motd: [
    "................",
    "..###########...",
    ".#wwwwwwwwwww#..",
    ".#w#########w#..",
    "..#wwwwwwwww#...",
    "..#wSSSSSSSw#...",
    "..#wwwwwwwww#...",
    "..#wSSSSSSww#...",
    "..#wwwwwwwww#...",
    "..#wSSSSSSSw#...",
    "..#wwwwwwwww#...",
    "..#wSSSSwwww#...",
    ".#wwwwwwwwwww#..",
    ".#w#########w#..",
    "..###########...",
    "................",
  ],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;

/**
 * SVG path data of one colour of a drawing: a rectangle per horizontal run of that
 * character, so a drawing costs a handful of path commands, not one element per pixel.
 */
export function iconPath(rows: readonly string[], ch: string): string {
  let d = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== ch) {
        x++;
        continue;
      }
      let end = x;
      while (row[end] === ch) end++;
      d += `M${x} ${y}h${end - x}v1h${x - end}z`;
      x = end;
    }
  });
  return d;
}

/** Path data per colour of every icon, computed once. */
const PATHS = new Map<IconName, [string, string][]>();
function pathsOf(name: IconName): [string, string][] {
  let p = PATHS.get(name);
  if (!p) {
    const rows = ICONS[name];
    p = [];
    for (const [ch, color] of Object.entries(ICON_PALETTE)) {
      const d = iconPath(rows, ch);
      if (d) p.push([color, d]);
    }
    PATHS.set(name, p);
  }
  return p;
}

/** One icon, decorative (the button or title next to it carries the name). */
export function Icon(props: { name: IconName; class?: string }): JSX.Element {
  return (
    <svg
      class={props.class ? `icon ${props.class}` : "icon"}
      viewBox={`0 0 ${ICON_SIZE} ${ICON_SIZE}`}
      aria-hidden="true"
      focusable="false"
      shape-rendering="crispEdges"
      data-icon={props.name}
    >
      {pathsOf(props.name).map(([color, d]) => (
        <path key={color} fill={color} d={d} />
      ))}
    </svg>
  );
}
