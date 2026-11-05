// Options button and sound panel (T3.7): a slider and a mute box per channel. Every change
// applies at once and is saved (audio/prefs.ts), so it survives a reload.
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { AudioEngine } from "../audio/engine.ts";
import { ALL_CHANNELS, savePrefs, withMuted, withVolume } from "../audio/prefs.ts";
import type { AudioPrefs } from "../audio/prefs.ts";

export function AudioOptions(props: {
  t: Translate;
  audio: AudioEngine;
  storage: Storage | undefined;
}): JSX.Element {
  const { t, audio } = props;
  const [open, setOpen] = useState(false);
  // The panel mounts again when it moves between the corner and the game's header: start
  // from what the engine uses now, never from the values the page loaded with.
  const [prefs, setPrefs] = useState(() => audio.currentPrefs());
  const change = (next: AudioPrefs): void => {
    setPrefs(next);
    audio.setPrefs(next);
    savePrefs(next, props.storage);
  };
  return (
    <span class="options">
      <button
        type="button"
        data-testid="options-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("client.options.button")}
      </button>
      {open && (
        <div
          class="options-panel"
          role="dialog"
          aria-labelledby="options-title"
          data-testid="options"
        >
          <h3 id="options-title">{t("client.options.sound")}</h3>
          {ALL_CHANNELS.map((ch) => (
            <div class="channel" key={ch}>
              <label for={`volume-${ch}`}>{t(`client.options.channel.${ch}`)}</label>
              <input
                id={`volume-${ch}`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(prefs.volume[ch] * 100)}
                data-testid={`volume-${ch}`}
                onInput={(e) => change(withVolume(prefs, ch, Number(e.currentTarget.value) / 100))}
              />
              <span class="value">{Math.round(prefs.volume[ch] * 100)}</span>
              <label class="mute">
                <input
                  type="checkbox"
                  checked={prefs.muted[ch]}
                  data-testid={`mute-${ch}`}
                  onChange={(e) => change(withMuted(prefs, ch, e.currentTarget.checked))}
                />
                {t("client.options.mute")}
              </label>
            </div>
          ))}
          <button type="button" onClick={() => setOpen(false)}>
            {t("client.options.close")}
          </button>
        </div>
      )}
    </span>
  );
}
