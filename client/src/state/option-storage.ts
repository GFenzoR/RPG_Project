// The page's one option storage and its sync with the account (state/saved-options.ts).
// Everything that keeps an option in localStorage takes its storage from optionStorage(),
// so a change of a saved key reaches the server a moment later.
import { accountApi } from "../net/api.ts";
import { OptionsSync, watchedStorage } from "./saved-options.ts";
import type { DeviceClass } from "./saved-options.ts";
import { coarsePointer } from "./touch-prefs.ts";

let storage: Storage | undefined;
let sync: OptionsSync | undefined;
let made = false;

function make(): void {
  made = true;
  let base: Storage | undefined;
  try {
    base = window.localStorage;
  } catch {
    base = undefined; // blocked: nothing is remembered, nothing is sent
  }
  storage = base ? watchedStorage(base, (key) => sync?.changed(key)) : undefined;
  sync = new OptionsSync(
    {
      get: accountApi.options,
      put: accountApi.saveOptions,
      putLeaving: accountApi.saveOptionsLeaving,
    },
    storage,
    deviceClass(),
    {
      set: (fn, ms) => window.setTimeout(fn, ms),
      clear: (h) => window.clearTimeout(h as number | undefined),
    },
  );
  // The tab closes or the app quits before the save's delay: what waits goes out now.
  const leaving = sync;
  window.addEventListener("pagehide", () => leaving.leaving());
}

/** A screen driven by a finger (phone, tablet) or by a mouse. */
export function deviceClass(): DeviceClass {
  return coarsePointer() ? "touch" : "desktop";
}

/** localStorage watched for option changes, or undefined where the browser blocks it. */
export function optionStorage(): Storage | undefined {
  if (!made) make();
  return storage;
}

/** The account sync of this page. */
export function optionsSync(): OptionsSync {
  if (!made) make();
  return sync as OptionsSync;
}
