// Map submission portal (T4.5): /maps/submit (upload a map patch), /maps/mine (the
// author's submissions) and /maps/review[/<id>] (the moderation queue, gm and admin). The
// server decides who sees what; these pages only show its answers. Every text is an i18n
// key or the player's own text rendered as text (never innerHTML).
import { Fragment } from "preact";
import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, api, mapsApi } from "../net/api.ts";
import type { Character, MapSubmission, MySubmissions } from "../net/api.ts";
import {
  MAP_STATUSES,
  byteLength,
  canSubmit,
  cleanInput,
  errorKey,
  failureKey,
  formatSize,
  groupFiles,
  groupLabel,
  isMapStatus,
  manualPr,
  precheckPatch,
  safePrUrl,
} from "./maps.ts";
import type { MapStatus } from "./maps.ts";

/** Same limits as the server (httpapi.MapTitleMax and friends). */
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 2000;
const REASON_MAX = 500;
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

export interface MapsProps {
  t: Translate;
  lang: string;
  /** Renders an internal link (the website's router). */
  link: (href: string, text: string, current?: boolean) => JSX.Element;
}

type Load<T> = { state: "loading" } | { state: "error"; code: string } | { state: "ok"; data: T };

function codeOf(e: unknown): string {
  return e instanceof ApiError ? e.code : "unknown";
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [Load<T>, () => void] {
  const [value, setValue] = useState<Load<T>>({ state: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setValue({ state: "loading" });
    load().then(
      (data) => live && setValue({ state: "ok", data }),
      (e: unknown) => live && setValue({ state: "error", code: codeOf(e) }),
    );
    return () => {
      live = false;
    };
  }, [...deps, round]);
  return [value, useCallback(() => setRound((r) => r + 1), [])];
}

function formatDateTime(iso: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

function ErrorText(props: { t: Translate; code: string; detail?: string }): JSX.Element {
  return (
    <p class="error" role="alert" data-testid="maps-error">
      {props.t(errorKey(props.code, props.detail))}
    </p>
  );
}

function StatusBadge(props: { t: Translate; status: string }): JSX.Element {
  const s = isMapStatus(props.status) ? props.status : "pending";
  return (
    <span class={`badge status-${s}`} data-status={s}>
      {props.t(`site.maps.status.${s}`)}
    </span>
  );
}

/** Login form of the website, shown when a portal page needs a session. */
function SiteLogin(props: { t: Translate; onDone: () => void }): JSX.Element {
  const { t } = props;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section class="card maps-login" aria-labelledby="maps-login-title">
      <h2 id="maps-login-title">{t("site.maps.login.title")}</h2>
      <p class="muted">{t("site.maps.login.hint")}</p>
      <form
        class="maps-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          api.login(email, password).then(
            () => props.onDone(),
            (err: unknown) => {
              setError(codeOf(err));
              setBusy(false);
            },
          );
        }}
      >
        <label>
          <span>{t("client.login.email")}</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <label>
          <span>{t("client.login.password")}</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        {error && <ErrorText t={t} code={error} />}
        <button type="submit" disabled={busy}>
          {t("client.login.submit")}
        </button>
      </form>
    </section>
  );
}

/** The portal's own menu (submit, mine and, for staff, the queue), who is signed in and
 *  the way out: the website's login sets the same 30-day cookie as the game. */
function MapsNav(
  props: MapsProps & {
    current: string;
    canReview: boolean;
    email: string;
    onLogout: () => void;
  },
): JSX.Element {
  const { t, link, current } = props;
  const [busy, setBusy] = useState(false);
  return (
    <div class="maps-bar">
      <nav class="maps-nav" aria-label={t("site.maps.nav.label")}>
        {link("/maps/submit", t("site.maps.nav.submit"), current === "submit")}
        {link("/maps/mine", t("site.maps.nav.mine"), current === "mine")}
        {props.canReview && link("/maps/review", t("site.maps.nav.review"), current === "review")}
      </nav>
      <p class="maps-account">
        <span data-testid="maps-signed-in">
          {t("site.maps.account.signed_in", { email: props.email })}
        </span>{" "}
        <button
          type="button"
          class="link-button"
          data-testid="maps-logout"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            props.onLogout();
          }}
        >
          {t("site.maps.account.logout")}
        </button>
      </p>
    </div>
  );
}

/** Loads /mine (limits, license, role) and handles the login; renders children with it. */
function WithAccount(
  props: MapsProps & {
    current: string;
    children: (mine: MySubmissions, reload: () => void) => JSX.Element;
  },
): JSX.Element {
  const { t } = props;
  const [mine, reload] = useLoad(() => mapsApi.mine(), []);
  if (mine.state === "loading")
    return (
      <p class="muted" aria-live="polite">
        {t("site.maps.loading")}
      </p>
    );
  if (mine.state === "error")
    return mine.code === "unauthorized" ? (
      <SiteLogin t={t} onDone={reload} />
    ) : (
      <ErrorText t={t} code={mine.code} />
    );
  // Logging out (or failing to) reloads: without a session the login form shows.
  const logout = (): void => {
    api.logout().then(reload, reload);
  };
  return (
    <>
      <MapsNav
        {...props}
        canReview={mine.data.can_review}
        email={mine.data.email}
        onLogout={logout}
      />
      {props.children(mine.data, reload)}
    </>
  );
}

// ---- /maps/submit ----------------------------------------------------------------

export function SubmitPage(props: MapsProps): JSX.Element {
  return (
    <WithAccount {...props} current="submit">
      {(mine) => <SubmitForm {...props} mine={mine} />}
    </WithAccount>
  );
}

function SubmitForm(props: MapsProps & { mine: MySubmissions }): JSX.Element {
  const { t, lang, mine } = props;
  const [chars, reloadChars] = useLoad<Character[]>(() => api.characters(), []);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [license, setLicense] = useState(false);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; detail?: string } | null>(null);
  const [done, setDone] = useState<MapSubmission | null>(null);

  useEffect(() => {
    if (chars.state === "ok" && characterId === null && chars.data[0])
      setCharacterId(chars.data[0].id);
  }, [chars, characterId]);
  // The form is replaced by the confirmation: focus its heading so it is announced and
  // keyboard users do not land on <body>.
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  if (done)
    return (
      <section class="card" data-testid="maps-submitted">
        <h1 tabIndex={-1} ref={doneRef}>
          {t("site.maps.submit.done_title")}
        </h1>
        <p>{t("site.maps.submit.done_body", { title: done.title })}</p>
        <p>{props.link("/maps/mine", t("site.maps.nav.mine"))}</p>
      </section>
    );

  const onFile = (input: HTMLInputElement): void => {
    setFile(null);
    setFileError(null);
    setError(null);
    const f = input.files?.[0];
    if (!f) return;
    if (f.size > mine.max_bytes) {
      setFileError("too_large");
      return;
    }
    f.text().then(
      (text) => {
        const problem = precheckPatch(text, mine.max_bytes);
        if (problem) setFileError(problem);
        else setFile({ name: f.name, text });
      },
      () => setFileError("not_utf8"),
    );
  };

  const submit = (): void => {
    if (!file || characterId === null) return;
    setBusy(true);
    setError(null);
    mapsApi
      .submit({
        title: cleanInput(title),
        description: cleanInput(description),
        character_id: characterId,
        license: mine.license,
        patch: file.text,
      })
      .then(setDone, (e: unknown) => {
        setError(
          e instanceof ApiError
            ? { code: e.code, ...(e.detail ? { detail: e.detail } : {}) }
            : { code: "unknown" },
        );
        setBusy(false);
      });
  };

  return (
    <section class="card" aria-labelledby="submit-title">
      <h1 id="submit-title">{t("site.maps.submit.title")}</h1>
      <p>{t("site.maps.submit.intro")}</p>
      <ol class="maps-steps">
        <li>{t("site.maps.submit.step_editor")}</li>
        <li>{t("site.maps.submit.step_plot")}</li>
        <li>{t("site.maps.submit.step_review")}</li>
      </ol>
      <p class="muted">
        {t("site.maps.submit.limits", {
          size: formatSize(mine.max_bytes, lang),
          count: mine.per_day,
        })}
      </p>
      {chars.state === "error" ? (
        <div class="maps-retry">
          <ErrorText t={t} code={chars.code} />
          <button type="button" data-testid="maps-retry" onClick={reloadChars}>
            {t("site.maps.retry")}
          </button>
        </div>
      ) : chars.state === "ok" && chars.data.length === 0 ? (
        <p class="error" role="alert">
          {t("site.maps.submit.no_character")} <a href="/play/">{t("site.play")}</a>
        </p>
      ) : (
        <form
          class="maps-form"
          data-testid="maps-submit-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label>
            <span>{t("site.maps.submit.file")}</span>
            <input
              type="file"
              accept=".json,application/json"
              data-testid="maps-file"
              onChange={(e) => onFile(e.currentTarget)}
            />
          </label>
          {file && (
            <p class="muted" data-testid="maps-file-ok">
              {t("site.maps.submit.file_ok", {
                name: file.name,
                size: formatSize(byteLength(file.text), lang),
              })}
            </p>
          )}
          {fileError && (
            <p class="error" role="alert">
              {t(`site.maps.patch_error.${fileError}`)}
            </p>
          )}
          <label>
            <span>{t("site.maps.submit.title_label")}</span>
            <input
              type="text"
              required
              maxLength={TITLE_MAX}
              data-testid="maps-title"
              value={title}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>
          <label>
            <span>{t("site.maps.submit.description_label")}</span>
            <textarea
              rows={4}
              maxLength={DESCRIPTION_MAX}
              data-testid="maps-description"
              value={description}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </label>
          <label>
            <span>{t("site.maps.submit.character")}</span>
            <select
              data-testid="maps-character"
              value={characterId === null ? "" : String(characterId)}
              onChange={(e) => setCharacterId(Number(e.currentTarget.value))}
            >
              {chars.state === "ok" &&
                chars.data.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
            </select>
            <small class="muted">{t("site.maps.submit.character_hint")}</small>
          </label>
          <label class="check">
            <input
              type="checkbox"
              data-testid="maps-license"
              checked={license}
              onChange={(e) => setLicense(e.currentTarget.checked)}
            />
            <span>
              {t("site.maps.submit.license")}{" "}
              <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
                {t("site.maps.submit.license_link")}
              </a>
            </span>
          </label>
          {error && error.code !== "unauthorized" && (
            <ErrorText
              t={t}
              code={error.code}
              {...(error.detail ? { detail: error.detail } : {})}
            />
          )}
          <button
            type="submit"
            data-testid="maps-send"
            disabled={!canSubmit({ title, characterId, license, patch: file?.text ?? null, busy })}
          >
            {busy ? t("site.maps.submit.sending") : t("site.maps.submit.send")}
          </button>
        </form>
      )}
      {error?.code === "unauthorized" && (
        // The session ended while filling the form: log in here, keep what was typed, and
        // send again.
        <SiteLogin t={t} onDone={() => setError(null)} />
      )}
    </section>
  );
}

// ---- /maps/mine ------------------------------------------------------------------

export function MinePage(props: MapsProps): JSX.Element {
  return (
    <WithAccount {...props} current="mine">
      {(mine) => <MineList {...props} mine={mine} />}
    </WithAccount>
  );
}

function MineList(props: MapsProps & { mine: MySubmissions }): JSX.Element {
  const { t, lang, mine } = props;
  return (
    <section aria-labelledby="mine-title">
      <h1 id="mine-title">{t("site.maps.mine.title")}</h1>
      {mine.submissions.length === 0 ? (
        <p class="muted">
          {t("site.maps.mine.empty")} {props.link("/maps/submit", t("site.maps.nav.submit"))}
        </p>
      ) : (
        <ul class="maps-list" data-testid="maps-mine">
          {mine.submissions.map((m) => (
            <li key={m.id} class="card" data-submission={m.id}>
              <div class="maps-row">
                <h2>{m.title}</h2>
                <StatusBadge t={t} status={m.status} />
              </div>
              <p class="muted">
                {t("site.maps.mine.meta", {
                  date: formatDateTime(m.created_at, lang),
                  files: m.files.length,
                  size: formatSize(m.size, lang),
                  author: m.author,
                })}
              </p>
              <Outcome t={t} m={m} prWorker={mine.pr_worker} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What happened to a submission, for its author. */
function Outcome(props: { t: Translate; m: MapSubmission; prWorker: boolean }): JSX.Element | null {
  const { t, m } = props;
  const pr = safePrUrl(m);
  switch (m.status) {
    case "pending":
      return <p>{t("site.maps.outcome.pending")}</p>;
    case "approved":
      return (
        <p>
          {t(props.prWorker ? "site.maps.outcome.approved" : "site.maps.outcome.approved_manual")}
        </p>
      );
    case "rejected":
      return (
        <p data-testid="maps-reason">
          <strong>{t("site.maps.outcome.rejected")}</strong>{" "}
          <span class="user-text">{m.reason}</span>
        </p>
      );
    case "failed":
      return <p data-testid="maps-failure">{t(failureKey(m.failure))}</p>;
    case "pr_opened":
      return pr ? (
        <p data-testid="maps-pr">
          <a href={pr} target="_blank" rel="noopener noreferrer">
            {t("site.maps.outcome.pr", { number: m.pr_number ?? 0 })}
          </a>
        </p>
      ) : (
        <p>{t("site.maps.outcome.pr", { number: m.pr_number ?? 0 })}</p>
      );
    default:
      return null;
  }
}

// ---- /maps/review ----------------------------------------------------------------

export function ReviewPage(props: MapsProps & { id?: number; search: string }): JSX.Element {
  return (
    <WithAccount {...props} current="review">
      {(mine) =>
        !mine.can_review ? (
          <ErrorText t={props.t} code="forbidden" />
        ) : props.id === undefined ? (
          <Queue {...props} />
        ) : (
          <Detail {...props} id={props.id} prWorker={mine.pr_worker} />
        )
      }
    </WithAccount>
  );
}

function Queue(props: MapsProps & { search: string }): JSX.Element {
  const { t, lang } = props;
  const query = new URLSearchParams(props.search);
  const param = query.get("status") ?? "pending";
  const status: MapStatus = isMapStatus(param) ? param : "pending";
  const cursor = query.get("cursor") ?? "";
  const [list] = useLoad(() => mapsApi.queue(status, cursor), [status, cursor]);
  const statusHref = (s: string): string =>
    s === "pending" ? "/maps/review" : `/maps/review?status=${s}`;
  return (
    <section aria-labelledby="queue-title">
      <h1 id="queue-title">{t("site.maps.review.title")}</h1>
      <nav class="maps-filter" aria-label={t("site.maps.review.filter")}>
        {MAP_STATUSES.map((s) => (
          <Fragment key={s}>
            {props.link(statusHref(s), t(`site.maps.status.${s}`), s === status)}
          </Fragment>
        ))}
      </nav>
      {list.state === "loading" && <p class="muted">{t("site.maps.loading")}</p>}
      {list.state === "error" && <ErrorText t={t} code={list.code} />}
      {list.state === "ok" &&
        (list.data.submissions.length === 0 ? (
          <p class="muted">{t("site.maps.review.empty")}</p>
        ) : (
          <table class="maps-queue" data-testid="maps-queue">
            <thead>
              <tr>
                <th scope="col">{t("site.maps.review.col_title")}</th>
                <th scope="col">{t("site.maps.review.col_author")}</th>
                <th scope="col">{t("site.maps.review.col_date")}</th>
                <th scope="col" class="num">
                  {t("site.maps.review.col_files")}
                </th>
                <th scope="col" class="num">
                  {t("site.maps.review.col_size")}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.submissions.map((m) => (
                <tr key={m.id}>
                  <th scope="row">{props.link(`/maps/review/${String(m.id)}`, m.title)}</th>
                  <td>{m.author}</td>
                  <td>{formatDateTime(m.created_at, lang)}</td>
                  <td class="num">{m.files.length}</td>
                  <td class="num">{formatSize(m.size, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {list.state === "ok" && (cursor !== "" || list.data.next) && (
        <nav class="maps-pager" aria-label={t("site.maps.review.pages")}>
          {cursor !== "" && props.link(statusHref(status), t("site.maps.review.first_page"))}
          {list.data.next &&
            props.link(
              `/maps/review?${new URLSearchParams({ status, cursor: list.data.next }).toString()}`,
              t("site.maps.review.next_page"),
            )}
        </nav>
      )}
    </section>
  );
}

function Detail(props: MapsProps & { id: number; prWorker: boolean }): JSX.Element {
  const { t, lang } = props;
  const [loaded] = useLoad(() => mapsApi.get(props.id), [props.id]);
  // The answer to a decision replaces the loaded row in place: nothing unmounts, and focus
  // moves to the heading, whose badge now says the new status.
  const [decided, setDecided] = useState<MapSubmission | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (decided) headingRef.current?.focus();
  }, [decided]);
  if (loaded.state === "loading") return <p class="muted">{t("site.maps.loading")}</p>;
  if (loaded.state === "error") return <ErrorText t={t} code={loaded.code} />;
  const m = decided?.id === loaded.data.id ? decided : loaded.data;
  const decide = (decision: "approve" | "reject"): void => {
    setBusy(true);
    setError(null);
    mapsApi.review(m.id, decision, cleanInput(reason)).then(
      (updated) => {
        setBusy(false);
        setReason("");
        setDecided(updated);
      },
      (e: unknown) => {
        setError(codeOf(e));
        setBusy(false);
      },
    );
  };
  return (
    <article class="card maps-detail" data-testid="maps-detail" aria-labelledby="detail-title">
      <p>{props.link("/maps/review", t("site.maps.review.back"))}</p>
      <div class="maps-row">
        <h1 id="detail-title" tabIndex={-1} ref={headingRef} aria-describedby="detail-status">
          {m.title}
        </h1>
        <span id="detail-status">
          <StatusBadge t={t} status={m.status} />
        </span>
      </div>
      <dl class="maps-facts">
        <dt>{t("site.maps.review.col_author")}</dt>
        <dd>{m.author}</dd>
        <dt>{t("site.maps.review.col_date")}</dt>
        <dd>{formatDateTime(m.created_at, lang)}</dd>
        <dt>{t("site.maps.review.col_size")}</dt>
        <dd>{formatSize(m.size, lang)}</dd>
        <dt>{t("site.maps.review.base_ref")}</dt>
        <dd>
          <code>{m.base_ref}</code>
        </dd>
        <dt>{t("site.maps.review.sha256")}</dt>
        <dd>
          <code class="hash">{m.sha256}</code>
        </dd>
        <dt>{t("site.maps.review.license")}</dt>
        <dd>
          <code>{m.license}</code>
        </dd>
      </dl>
      {m.description !== "" && (
        <>
          <h2>{t("site.maps.review.description")}</h2>
          <p class="user-text" data-testid="maps-description-text">
            {m.description}
          </p>
        </>
      )}
      <h2>{t("site.maps.review.files", { count: m.files.length })}</h2>
      {[...groupFiles(m.files)].map(([group, files]) => (
        <div key={group}>
          <h3>{groupLabel(group, t)}</h3>
          <ul class="maps-files">
            {files.map((f) => (
              <li key={f.path}>
                <span class={`badge action-${f.action}`}>{t(`site.maps.action.${f.action}`)}</span>{" "}
                <code>{f.path}</code>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {m.has_patch ? (
        <p>
          <a href={mapsApi.patchUrl(m.id)} download data-testid="maps-download">
            {t("site.maps.review.download")}
          </a>
        </p>
      ) : (
        <p class="muted" data-testid="maps-patch-gone">
          {t("site.maps.review.patch_gone")}
        </p>
      )}
      <p class="muted">{t("site.maps.review.check_hint")}</p>
      {m.status === "approved" && !props.prWorker && (
        <div class="notice" data-testid="maps-manual">
          <p>{t("site.maps.review.manual_hint", { branch: manualPr(m).branch })}</p>
          <p>{t("site.maps.review.manual_marker")}</p>
          <pre>
            <code data-testid="maps-manual-marker">{manualPr(m).marker}</code>
          </pre>
        </div>
      )}
      {(m.status === "pr_opened" || m.status === "failed") && (
        <Outcome t={t} m={m} prWorker={props.prWorker} />
      )}
      {m.status === "rejected" && m.reason && (
        <p>
          <strong>{t("site.maps.outcome.rejected")}</strong>{" "}
          <span class="user-text">{m.reason}</span>
        </p>
      )}
      {m.status === "pending" && (
        <form class="maps-form" onSubmit={(e) => e.preventDefault()}>
          <label>
            <span>{t("site.maps.review.reason")}</span>
            <textarea
              rows={3}
              maxLength={REASON_MAX}
              data-testid="maps-reason-input"
              value={reason}
              onInput={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          {error && error !== "unauthorized" && <ErrorText t={t} code={error} />}
          <div class="maps-actions">
            <button
              type="button"
              data-testid="maps-approve"
              disabled={busy}
              onClick={() => decide("approve")}
            >
              {t("site.maps.review.approve")}
            </button>
            <button
              type="button"
              class="danger"
              data-testid="maps-reject"
              disabled={busy || cleanInput(reason) === ""}
              onClick={() => decide("reject")}
            >
              {t("site.maps.review.reject")}
            </button>
          </div>
        </form>
      )}
      {m.status === "pending" && error === "unauthorized" && (
        // The session ended while writing the reason: log in here, keep it, decide again.
        <SiteLogin t={t} onDone={() => setError(null)} />
      )}
    </article>
  );
}
