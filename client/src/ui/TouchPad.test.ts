import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { TouchPad } from "./TouchPad.tsx";
import { TouchStick } from "./TouchStick.tsx";

const t = (key: string): string => key;

type Handler = (e: unknown) => void;
interface Props {
  ref: (el: unknown) => void;
  onPointerDown: Handler;
  onPointerMove: Handler;
  onPointerUp: Handler;
}

/** A 100 px control at the origin that captures pointers like an element does. */
function element(): Record<string, unknown> {
  const captured = new Set<number>();
  return {
    dataset: {},
    offsetWidth: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    querySelector: () => null,
  };
}

function pointer(el: unknown, pointerId: number, clientX: number, clientY: number): unknown {
  return {
    currentTarget: el,
    pointerId,
    clientX,
    clientY,
    width: 1,
    height: 1,
    preventDefault() {},
  };
}

function game(calls: string[]): {
  padPress(d: Direction): void;
  padRelease(): void;
  padStep(): void;
} {
  return {
    padPress: (d) => calls.push(`press:${d}`),
    padRelease: () => calls.push("release"),
    padStep: () => calls.push("step"),
  };
}

describe.each([
  ["TouchPad", TouchPad],
  ["TouchStick", TouchStick],
] as const)("%s leaving the tree with a finger on it", (_name, Control) => {
  // Preact keeps the ref on the vnode, not in its props.
  const draw = (calls: string[]): Props => {
    const vnode = Control({ t, game: game(calls) }) as unknown as {
      props: Props;
      ref: Props["ref"];
    };
    return { ...vnode.props, ref: vnode.ref };
  };

  it("stops the walk and frees the control for the next finger", () => {
    const calls: string[] = [];
    const first = draw(calls);
    const el = element();
    first.ref(el);
    first.onPointerDown(pointer(el, 7, 95, 50)); // east, held
    expect(calls).toEqual([`press:${Direction.EAST}`]);

    // The layout changed (the phone turned): the control is drawn elsewhere, this one goes.
    first.ref(null);
    expect(calls).toEqual([`press:${Direction.EAST}`, "release"]);

    // The same direction on the new one presses again, with another finger.
    const next = draw(calls);
    const el2 = element();
    next.ref(el2);
    next.onPointerDown(pointer(el2, 9, 95, 50));
    expect(calls).toEqual([`press:${Direction.EAST}`, "release", `press:${Direction.EAST}`]);
    next.onPointerUp(pointer(el2, 9, 95, 50));
    expect(calls.at(-1)).toBe("release");
  });

  it("does nothing when no finger holds it", () => {
    const calls: string[] = [];
    const props = draw(calls);
    props.ref(element());
    props.ref(null);
    expect(calls).toEqual([]);
  });

  it("keeps one ref across renders, so a redraw is not an unmount", () => {
    expect(draw([]).ref).toBe(draw([]).ref);
  });
});
