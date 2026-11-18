// Sound options (T3.7): a slider and a mute box per channel. Every change applies at once
// and is saved (audio/prefs.ts), so it survives a reload. `SoundOptions` is the list itself
// (the desktop game's Options window shows it, docs/17 UI-5); `AudioOptions` is the
// Options button with its drop-down panel of the login screen and of the phone menu.
import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { AudioEngine } from "../audio/engine.ts";
import { ALL_CHANNELS, savePrefs, withMuted, withVolume } from "../audio/prefs.ts";
import type { AudioPrefs } from "../audio/prefs.ts";
import { CreditsLink } from "./CreditsLink.tsx";

export function SoundOptions(props: {
  t: Translate;
  audio: AudioEngine;
  storage: Storage | undefined;
}): JSX.Element {
  const { t, audio } = props;
  // The list mounts again when it moves between the corner, the phone menu and the game's
  // Options window: start from what the engine uses now, never from the values the page
  // loaded with.
  const [prefs, setPrefs] = useState(() => audio.currentPrefs());
  const change = (next: AudioPrefs): void => {
    setPrefs(next);
    audio.setPrefs(next);
    savePrefs(next, props.storage);
  };
  return (
    <>
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
    </>
  );
}

export function AudioOptions(props: {
  t: Translate;
  audio: AudioEngine;
  storage: Storage | undefined;
  /** More options under the sound (T5.6: the direction pad switch). */
  children?: ComponentChildren;
}): JSX.Element {
  const { t } = props;
  const [open, setOpen] = useState(false);
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
          <SoundOptions t={t} audio={props.audio} storage={props.storage} />
          {props.children !== undefined && (
            <>
              <h3>{t("client.options.controls")}</h3>
              {props.children}
            </>
          )}
          <CreditsLink t={t} />
          <button type="button" onClick={() => setOpen(false)}>
            {t("client.options.close")}
          </button>
        </div>
      )}
    </span>
  );
}
