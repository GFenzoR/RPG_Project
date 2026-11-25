// The world time the server sent (WorldClock, livingworld/README.md "Día y noche", docs/05
// "Mundo vivo"): the day, how far into the cycle and the rate, with the local time it
// arrived. render/sky.ts runs it on between syncs and turns it into the sky. Pure: no clock
// of its own (callers pass `now`, performance.now() ms).
import type { WorldClock } from "@rpg/protocol";

export class WorldClockState {
  /** Whether the server has sent one (an old server, or no day and night, never does). */
  known = false;
  day = 0;
  cycleMs = 0;
  rate = 1;
  /** performance.now() when it arrived. */
  at = 0;

  set(m: WorldClock, now: number): void {
    this.known = true;
    this.day = m.day;
    this.cycleMs = m.cycleMs;
    this.rate = m.rate;
    this.at = now;
  }
}
