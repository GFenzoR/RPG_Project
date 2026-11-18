// The /credits page (docs/17 A1): who made the third-party art and fonts the game ships,
// under which licence and where they come from, as CC-BY, CC-BY-SA, OGA-BY and the OFL ask.
// The data is assets/CREDITS.md and the packs' CREDITS.csv (vite/credits.ts); every
// sentence is i18n. No hooks: the page renders as a plain function of its props. The
// desktop app shows the same page in a window of Options (ui/CreditsLink.tsx) with `plain`:
// its addresses as text, since a link would open inside the app.
import type { ComponentChildren, JSX } from "preact";
import type { Credits } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { licenceUrl, packKeys, safeLink } from "./credits.ts";

const EMPTY: Credits = { packs: [], files: [], derived: [], fonts: [] };

/** A licence's name, linked to its text when the page knows it (plain: the address). */
function Licence(props: { name: string; plain?: boolean | undefined }): JSX.Element {
  const url = licenceUrl(props.name);
  if (url && props.plain)
    return (
      <span data-licence={props.name}>
        {props.name} <code>{url}</code>
      </span>
    );
  return url ? (
    <a href={url} rel="noopener license" target="_blank" data-licence={props.name}>
      {props.name}
    </a>
  ) : (
    <span data-licence={props.name}>{props.name}</span>
  );
}

/** An external link, or its text when it is not http(s) (or the page is plain). */
function Source(props: { url: string; plain?: boolean | undefined }): JSX.Element {
  const href = props.plain ? undefined : safeLink(props.url);
  return href ? (
    <a href={href} rel="noopener" target="_blank">
      {props.url}
    </a>
  ) : (
    <span>{props.url}</span>
  );
}

function Field(props: { label: string; children: ComponentChildren }): JSX.Element {
  return (
    <div class="credit-field">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

export function CreditsPage(props: {
  t: Translate;
  credits: Credits | undefined;
  /** No links: every address as text (the desktop app). */
  plain?: boolean;
}): JSX.Element {
  const { t, plain } = props;
  const c = props.credits ?? EMPTY;
  return (
    <section class="card credits" data-testid="credits">
      <h1>{t("site.credits.title")}</h1>
      <p>{t("site.credits.intro")}</p>

      <h2>{t("site.credits.packs")}</h2>
      <ul class="credit-list">
        {c.packs.map((p) => {
          const keys = packKeys(p.pack);
          return (
            <li key={p.pack} data-pack={p.pack}>
              <h3>{t(keys.title)}</h3>
              <dl>
                <Field label={t("site.credits.author")}>{t(keys.author)}</Field>
                <Field label={t("site.credits.licence")}>
                  {p.licences.map((l) => (
                    <Licence key={l} name={l} plain={plain} />
                  ))}
                </Field>
                <Field label={t("site.credits.source")}>
                  <Source url={p.url} plain={plain} />
                </Field>
              </dl>
              {p.perFile && <p class="muted">{t("site.credits.per_file")}</p>}
            </li>
          );
        })}
      </ul>

      {c.files.length > 0 && (
        <>
          <h2>{t("site.credits.files")}</h2>
          <p>{t("site.credits.files_intro")}</p>
          <ul class="credit-list compact" data-testid="credits-files">
            {c.files.map((f, i) => (
              <li key={i} data-pack={f.pack}>
                <p class="works">
                  {f.works.map((w, j) => (
                    <code key={j}>{w}</code>
                  ))}
                </p>
                <dl>
                  <Field label={t("site.credits.authors")}>{f.authors.join(", ")}</Field>
                  <Field label={t("site.credits.licence")}>
                    <Licence name={f.licence} plain={plain} />
                  </Field>
                  <Field label={t("site.credits.source")}>
                    {f.urls.map((u) => (
                      <Source key={u} url={u} plain={plain} />
                    ))}
                  </Field>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}

      {c.derived.length > 0 && (
        <>
          <h2>{t("site.credits.derived")}</h2>
          <p>{t("site.credits.derived_intro")}</p>
          <ul class="credit-list compact" data-testid="credits-derived">
            {c.derived.map((d) => (
              <li key={d.licence}>
                <dl>
                  <Field label={t("site.credits.licence")}>
                    <Licence name={d.licence} plain={plain} />
                  </Field>
                  <Field label={t("site.credits.sprites")}>
                    {d.sprites.map((s) => (
                      <code key={s}>{s}</code>
                    ))}
                  </Field>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}

      {c.fonts.length > 0 && (
        <>
          <h2>{t("site.credits.fonts")}</h2>
          <p>{t("site.credits.fonts_intro")}</p>
          <ul class="credit-list compact" data-testid="credits-fonts">
            {c.fonts.map((f) => (
              <li key={f.family} data-font={f.family}>
                <h3>{f.family}</h3>
                <dl>
                  <Field label={t("site.credits.author")}>{f.copyright}</Field>
                  <Field label={t("site.credits.licence")}>
                    <Licence name={f.licence} plain={plain} />
                  </Field>
                  <Field label={t("site.credits.source")}>
                    <Source url={f.url} plain={plain} />
                  </Field>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>{t("site.credits.own")}</h2>
      <p>{t("site.credits.own_body")}</p>
    </section>
  );
}
