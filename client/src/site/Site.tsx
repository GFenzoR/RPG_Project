// The public website (T4.3): landing, highscores and news. A small single-page app at /,
// /highscores and /news[/<slug>]; the game is another page at /play/. Every text comes
// from i18n (site.yaml, plus skill and vocation names) or from data/news.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import type { NewsPost, SiteContent } from "../content-types.ts";
import { Markdown } from "./Markdown.tsx";
import { MinePage, ReviewPage, SubmitPage } from "./Maps.tsx";
import { ForgotPage, ResetPage, VerifyPage } from "./Account.tsx";
import { AccountPage, OAuthConfirmPage, OAuthErrorPage } from "./OAuth.tsx";
import { excerpt } from "./markdown.ts";
import {
  LEVEL,
  categoryKey,
  guildRankKey,
  filtersToSearch,
  highscoresPath,
  parseFilters,
  parseRoute,
} from "./routes.ts";
import type { Filters, Route } from "./routes.ts";

export interface SiteProps {
  site: SiteContent;
  t: Translate;
  lang: string;
  languagePicker: JSX.Element;
}

interface Status {
  online: boolean;
  players: number;
  version: string;
}

interface HighscoreEntry {
  rank: number;
  name: string;
  vocation: string;
  value: number;
}

interface HighscorePage {
  has_more: boolean;
  entries: HighscoreEntry[];
}

/** Moves to an internal URL without reloading (the router listens to popstate). */
export function navigate(href: string): void {
  history.pushState(null, "", href);
  dispatchEvent(new PopStateEvent("popstate"));
}

function useLocation(): { pathname: string; search: string } {
  const read = (): { pathname: string; search: string } => ({
    pathname: location.pathname,
    search: location.search,
  });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = (): void => setLoc(read());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return loc;
}

/** An internal link: a real <a> (opens in a new tab, keyboard, screen readers) that
 *  navigates in place on a plain click. */
function Link(props: {
  href: string;
  class?: string;
  current?: boolean;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <a
      href={props.href}
      class={props.class}
      aria-current={props.current ? "page" : undefined}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(props.href);
        scrollTo(0, 0);
      }}
    >
      {props.children}
    </a>
  );
}

/** Internal links for the map portal's pages. */
const mapLink = (href: string, text: string, current?: boolean): JSX.Element => (
  <Link href={href} current={current ?? false}>
    {text}
  </Link>
);

function getJSON<T>(path: string, signal: AbortSignal): Promise<T> {
  return fetch(path, { signal, credentials: "omit" }).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });
}

function useStatus(): Status | null | undefined {
  // undefined = loading, null = unreachable.
  const [status, setStatus] = useState<Status | null | undefined>(undefined);
  useEffect(() => {
    const ctl = new AbortController();
    const load = (): void => {
      getJSON<Status>("/api/status", ctl.signal).then(setStatus, () => {
        if (!ctl.signal.aborted) setStatus(null);
      });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      clearInterval(timer);
      ctl.abort();
    };
  }, []);
  return status;
}

function useHighscores(f: Filters): HighscorePage | "error" | undefined {
  const [data, setData] = useState<HighscorePage | "error" | undefined>(undefined);
  const path = highscoresPath(f);
  useEffect(() => {
    const ctl = new AbortController();
    setData(undefined);
    getJSON<HighscorePage>(path, ctl.signal).then(setData, () => {
      if (!ctl.signal.aborted) setData("error");
    });
    return () => ctl.abort();
  }, [path]);
  return data;
}

function formatDate(date: string, lang: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(d);
  } catch {
    return date;
  }
}

function localized(texts: Record<string, string>, lang: string): string {
  return texts[lang] ?? texts["es"] ?? Object.values(texts)[0] ?? "";
}

export function Site(props: SiteProps): JSX.Element {
  const { t } = props;
  const loc = useLocation();
  const route = parseRoute(loc.pathname);
  // No ?lang=: both pages share the stored choice (i18n LANGUAGE_STORAGE_KEY), and a
  // ?lang= in the game's URL would win over a language picked there after a reload.
  const playHref = "/play/";
  // Client-side navigation: move focus to the new page's content so keyboard and screen
  // reader users land on it (not on the link, which may be gone). Filters change only the
  // query, so a select keeps its focus.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [loc.pathname]);
  const section =
    route.page === "post"
      ? "news"
      : route.page === "guild"
        ? "guilds"
        : route.page.startsWith("maps_")
          ? "maps"
          : route.page;
  return (
    <>
      <a class="skip" href="#main">
        {t("site.skip")}
      </a>
      <header class="site-header">
        <Link href="/" class="brand">
          {t("client.title")}
        </Link>
        <nav aria-label={t("site.nav.label")}>
          <Link href="/" current={section === "home"}>
            {t("site.nav.home")}
          </Link>
          <Link href="/highscores" current={section === "highscores"}>
            {t("site.nav.highscores")}
          </Link>
          <Link href="/news" current={section === "news"}>
            {t("site.nav.news")}
          </Link>
          <Link href="/guilds" current={section === "guilds"}>
            {t("site.nav.guilds")}
          </Link>
          <Link href="/houses" current={section === "houses"}>
            {t("site.nav.houses")}
          </Link>
          <Link href="/maps/submit" current={section === "maps"}>
            {t("site.nav.maps")}
          </Link>
          <Link href="/account" current={section === "account"}>
            {t("site.nav.account")}
          </Link>
        </nav>
        <div class="site-tools">
          {props.languagePicker}
          <a class="play-button" href={playHref} data-testid="play">
            {t("site.play")}
          </a>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Page route={route} search={loc.search} playHref={playHref} {...props} />
      </main>
      <footer class="site-footer">
        <p>{t("site.footer")}</p>
      </footer>
    </>
  );
}

function Page(props: SiteProps & { route: Route; search: string; playHref: string }): JSX.Element {
  const { route, t } = props;
  useEffect(() => {
    const titles: Record<Route["page"], string> = {
      home: "",
      highscores: t("site.highscores.title"),
      guilds: t("site.guilds.title"),
      guild: t("site.guilds.title"),
      houses: t("site.houses.title"),
      news: t("site.news.title"),
      post: "",
      maps_submit: t("site.maps.submit.title"),
      maps_mine: t("site.maps.mine.title"),
      maps_review: t("site.maps.review.title"),
      not_found: t("site.not_found.title"),
      verify: t("site.account.verify.title"),
      forgot_password: t("site.account.forgot.title"),
      reset_password: t("site.account.reset.title"),
      account: t("site.account.title"),
      oauth_confirm: t("site.oauth.confirm.title"),
      oauth_error: t("site.oauth.error.title"),
    };
    let title = titles[route.page];
    if (route.page === "post") {
      const post = props.site.news.find((p) => p.slug === route.slug);
      title = post ? localized(post.title, props.lang) : t("site.news.not_found");
    }
    document.title = title ? `${title} · ${t("client.title")}` : t("client.title");
  }, [route, t, props.lang, props.site.news]);
  switch (route.page) {
    case "home":
      return <Home {...props} />;
    case "highscores":
      return <HighscoresPage {...props} />;
    case "guilds":
      return <GuildsPage t={t} lang={props.lang} />;
    case "guild":
      return <GuildPage t={t} lang={props.lang} id={route.id} />;
    case "houses":
      return <HousesPage t={t} />;
    case "news":
      return <NewsList {...props} />;
    case "post":
      return <NewsDetail {...props} slug={route.slug} />;
    case "maps_submit":
      return <SubmitPage t={t} lang={props.lang} link={mapLink} />;
    case "maps_mine":
      return <MinePage t={t} lang={props.lang} link={mapLink} />;
    case "maps_review":
      return (
        <ReviewPage
          t={t}
          lang={props.lang}
          link={mapLink}
          search={props.search}
          {...(route.id === undefined ? {} : { id: route.id })}
        />
      );
    case "verify":
      return <VerifyPage t={t} lang={props.lang} playHref={props.playHref} />;
    case "forgot_password":
      return <ForgotPage t={t} lang={props.lang} playHref={props.playHref} />;
    case "reset_password":
      return <ResetPage t={t} lang={props.lang} playHref={props.playHref} />;
    case "account":
      return (
        <AccountPage t={t} lang={props.lang} playHref={props.playHref} search={props.search} />
      );
    case "oauth_confirm":
      return <OAuthConfirmPage t={t} lang={props.lang} playHref={props.playHref} />;
    case "oauth_error":
      return (
        <OAuthErrorPage t={t} lang={props.lang} playHref={props.playHref} search={props.search} />
      );
    default:
      return (
        <section class="card" data-testid="not-found">
          <h1>{t("site.not_found.title")}</h1>
          <p>{t("site.not_found.body")}</p>
          <Link href="/">{t("site.nav.home")}</Link>
        </section>
      );
  }
}

function ServerStatus(props: { t: Translate }): JSX.Element {
  const { t } = props;
  const s = useStatus();
  const state = s === undefined ? "unknown" : s?.online ? "online" : "offline";
  return (
    <section class="card status" aria-labelledby="status-title" data-testid="status">
      <h2 id="status-title">{t("site.status.title")}</h2>
      <p aria-live="polite">
        <span class={`dot ${state}`} aria-hidden="true" />
        <strong data-state={state}>{t(`site.status.${state}`)}</strong>
        {s?.online && (
          <span>
            {" · "}
            {s.players === 0
              ? t("site.status.nobody")
              : t("site.status.players", { count: s.players })}
          </span>
        )}
      </p>
      {s?.version && <small>{t("site.status.version", { version: s.version })}</small>}
    </section>
  );
}

const SHOTS = ["town", "cave", "coast"] as const;

function Home(props: SiteProps & { playHref: string }): JSX.Element {
  const { t, site, lang } = props;
  return (
    <>
      <section class="hero">
        <div>
          <h1>{t("site.hero.title")}</h1>
          <p class="tagline">{t("site.hero.tagline")}</p>
          <p>
            <a class="play-button big" href={props.playHref}>
              {t("site.play")}
            </a>
          </p>
          <small>{t("site.play_hint")}</small>
        </div>
        <ServerStatus t={t} />
      </section>

      <section aria-labelledby="about-title">
        <h2 id="about-title">{t("site.about.title")}</h2>
        <ul class="features">
          {(["tiles", "skills", "world"] as const).map((k) => (
            <li key={k} class="card">
              {t(`site.about.${k}`)}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="voc-title">
        <h2 id="voc-title">{t("site.vocations.title")}</h2>
        <ul class="vocations">
          {site.vocations.map((v) => (
            <li key={v} class="card">
              <h3>{t(`vocation.${v}.name`)}</h3>
              <p>{t(`vocation.${v}.desc`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="shots-title">
        <h2 id="shots-title">{t("site.shots.title")}</h2>
        <ul class="shots">
          {SHOTS.map((s) => (
            <li key={s}>
              <figure>
                <div
                  class={`shot shot-${s}`}
                  role="img"
                  aria-label={t("site.shots.placeholder", { caption: t(`site.shots.${s}`) })}
                />
                <figcaption>{t(`site.shots.${s}`)}</figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </section>

      <div class="columns">
        <section aria-labelledby="latest-title">
          <h2 id="latest-title">{t("site.news.latest")}</h2>
          <NewsItems posts={site.news.slice(0, 3)} t={t} lang={lang} />
          <Link href="/news">{t("site.news.all")}</Link>
        </section>
        <section aria-labelledby="top-title">
          <h2 id="top-title">{t("site.highscores.top")}</h2>
          <HighscoreTable
            t={t}
            filters={{ category: LEVEL, vocation: "", page: 1 }}
            limit={5}
            testid="top5"
          />
          <Link href="/highscores">{t("site.highscores.all")}</Link>
        </section>
      </div>
    </>
  );
}

function HighscoreTable(props: {
  t: Translate;
  filters: Filters;
  limit?: number;
  testid: string;
  onMore?: (hasMore: boolean) => void;
}): JSX.Element {
  const { t, filters } = props;
  const data = useHighscores(filters);
  const { onMore } = props;
  useEffect(() => {
    if (data && data !== "error") onMore?.(data.has_more);
  }, [data, onMore]);
  if (data === undefined)
    return (
      <p class="muted" aria-live="polite">
        {t("site.highscores.loading")}
      </p>
    );
  if (data === "error")
    return (
      <p class="error" role="alert">
        {t("site.highscores.error")}
      </p>
    );
  const rows = props.limit ? data.entries.slice(0, props.limit) : data.entries;
  if (rows.length === 0) return <p class="muted">{t("site.highscores.empty")}</p>;
  return (
    <table class="highscores" data-testid={props.testid}>
      <caption class="visually-hidden">
        {t("site.highscores.title")}: {t(categoryKey(filters.category))}
      </caption>
      <thead>
        <tr>
          <th scope="col">{t("site.highscores.rank")}</th>
          <th scope="col">{t("site.highscores.name")}</th>
          <th scope="col">{t("site.highscores.vocation")}</th>
          <th scope="col" class="num">
            {t(categoryKey(filters.category))}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.rank}>
            <td class="num">{r.rank}</td>
            <th scope="row">{r.name}</th>
            <td>{t(`vocation.${r.vocation}.name`)}</td>
            <td class="num">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HighscoresPage(props: SiteProps & { search: string }): JSX.Element {
  const { t, site } = props;
  const filters = parseFilters(props.search, site.skills, site.vocations);
  const [hasMore, setHasMore] = useState(false);
  const go = (f: Filters): void => navigate(`/highscores${filtersToSearch(f, props.search)}`);
  return (
    <section class="card" aria-labelledby="hs-title">
      <h1 id="hs-title">{t("site.highscores.title")}</h1>
      <form class="filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          <span>{t("site.highscores.category")}</span>
          <select
            data-testid="hs-category"
            value={filters.category}
            onChange={(e) => go({ ...filters, category: e.currentTarget.value, page: 1 })}
          >
            {[LEVEL, ...site.skills].map((c) => (
              <option key={c} value={c}>
                {t(categoryKey(c))}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("site.highscores.vocation")}</span>
          <select
            data-testid="hs-vocation"
            value={filters.vocation}
            onChange={(e) => go({ ...filters, vocation: e.currentTarget.value, page: 1 })}
          >
            <option value="">{t("site.highscores.all_vocations")}</option>
            {site.vocations.map((v) => (
              <option key={v} value={v}>
                {t(`vocation.${v}.name`)}
              </option>
            ))}
          </select>
        </label>
      </form>
      <HighscoreTable t={t} filters={filters} testid="highscores" onMore={setHasMore} />
      <nav class="pager" aria-label={t("site.highscores.pagination")}>
        <button
          type="button"
          disabled={filters.page <= 1}
          onClick={() => go({ ...filters, page: filters.page - 1 })}
        >
          {t("site.highscores.prev")}
        </button>
        <span aria-current="page">{t("site.highscores.page", { page: filters.page })}</span>
        <button
          type="button"
          data-testid="hs-next"
          disabled={!hasMore}
          onClick={() => go({ ...filters, page: filters.page + 1 })}
        >
          {t("site.highscores.next")}
        </button>
      </nav>
      <small>{t("site.highscores.refresh")}</small>
    </section>
  );
}

function NewsItems(props: { posts: NewsPost[]; t: Translate; lang: string }): JSX.Element {
  const { t, lang } = props;
  if (props.posts.length === 0) return <p class="muted">{t("site.news.empty")}</p>;
  return (
    <ul class="news-list">
      {props.posts.map((p) => (
        <li key={p.slug} class="card">
          <article>
            <h3>
              <Link href={`/news/${p.slug}`}>{localized(p.title, lang)}</Link>
            </h3>
            <time dateTime={p.date}>{formatDate(p.date, lang)}</time>
            <p>{excerpt(localized(p.body, lang))}</p>
          </article>
        </li>
      ))}
    </ul>
  );
}

function NewsList(props: SiteProps): JSX.Element {
  const { t } = props;
  return (
    <section aria-labelledby="news-title">
      <h1 id="news-title">{t("site.news.title")}</h1>
      <NewsItems posts={props.site.news} t={t} lang={props.lang} />
    </section>
  );
}

function NewsDetail(props: SiteProps & { slug: string }): JSX.Element {
  const { t, lang } = props;
  const post = props.site.news.find((p) => p.slug === props.slug);
  return (
    <article class="card post">
      {post ? (
        <>
          <h1>{localized(post.title, lang)}</h1>
          <time dateTime={post.date}>{formatDate(post.date, lang)}</time>
          <Markdown source={localized(post.body, lang)} />
        </>
      ) : (
        <h1>{t("site.news.not_found")}</h1>
      )}
      <p>
        <Link href="/news">{t("site.news.back")}</Link>
      </p>
    </article>
  );
}

// ---- guilds (T5.1): GET /api/guilds and /api/guilds/{id}, public data only -------------

interface GuildSummary {
  id: number;
  name: string;
  leader: string;
  members: number;
  created_at: string;
}

interface GuildDetail {
  id: number;
  name: string;
  created_at: string;
  members: { name: string; vocation: string; level: number; rank: string }[];
}

/** Loads path as JSON: undefined while loading, "missing" on 404, "error" otherwise. */
function useJSON<T>(path: string): T | "missing" | "error" | undefined {
  const [data, setData] = useState<T | "missing" | "error" | undefined>(undefined);
  useEffect(() => {
    const ctl = new AbortController();
    setData(undefined);
    fetch(path, { signal: ctl.signal, credentials: "omit" })
      .then(async (r) => {
        if (r.status === 404) return setData("missing");
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        setData((await r.json()) as T);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setData("error");
      });
    return () => ctl.abort();
  }, [path]);
  return data;
}

function formatInstant(iso: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

function GuildsPage(props: { t: Translate; lang: string }): JSX.Element {
  const { t } = props;
  const data = useJSON<{ guilds: GuildSummary[] }>("/api/guilds");
  return (
    <section class="card" aria-labelledby="guilds-title">
      <h1 id="guilds-title">{t("site.guilds.title")}</h1>
      <p class="muted">{t("site.guilds.intro")}</p>
      {data === undefined ? (
        <p class="muted" role="status">
          {t("site.guilds.loading")}
        </p>
      ) : data === "error" || data === "missing" ? (
        <p class="error" role="alert">
          {t("site.guilds.error")}
        </p>
      ) : data.guilds.length === 0 ? (
        <p class="muted">{t("site.guilds.empty")}</p>
      ) : (
        <table class="highscores" data-testid="guilds">
          <thead>
            <tr>
              <th scope="col">{t("site.guilds.name")}</th>
              <th scope="col">{t("site.guilds.leader")}</th>
              <th scope="col">{t("site.guilds.members")}</th>
              <th scope="col">{t("site.guilds.founded")}</th>
            </tr>
          </thead>
          <tbody>
            {data.guilds.map((g) => (
              <tr key={g.id}>
                <td>
                  <Link href={`/guilds/${g.id}`}>{g.name}</Link>
                </td>
                <td>{g.leader}</td>
                <td>{g.members}</td>
                <td>{formatInstant(g.created_at, props.lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function GuildPage(props: { t: Translate; lang: string; id: number }): JSX.Element {
  const { t } = props;
  const data = useJSON<GuildDetail>(`/api/guilds/${props.id}`);
  if (data === undefined) {
    return (
      <p class="muted" role="status">
        {t("site.guilds.loading")}
      </p>
    );
  }
  if (data === "missing" || data === "error") {
    return (
      <section class="card" data-testid="guild-missing">
        <h1>{t("site.guilds.title")}</h1>
        <p class={data === "error" ? "error" : "muted"}>
          {t(data === "missing" ? "site.guilds.not_found" : "site.guilds.error")}
        </p>
        <p>
          <Link href="/guilds">{t("site.guilds.back")}</Link>
        </p>
      </section>
    );
  }
  return (
    <section class="card" aria-labelledby="guild-title" data-testid="guild-page">
      <h1 id="guild-title">{data.name}</h1>
      <p class="muted">
        {t("site.guilds.founded_on", { date: formatInstant(data.created_at, props.lang) })}
      </p>
      <table class="highscores" data-testid="guild-members">
        <thead>
          <tr>
            <th scope="col">{t("site.guilds.member")}</th>
            <th scope="col">{t("site.guilds.rank")}</th>
            <th scope="col">{t("site.highscores.vocation")}</th>
            <th scope="col">{t("site.highscores.level")}</th>
          </tr>
        </thead>
        <tbody>
          {data.members.map((m) => (
            <tr key={m.name}>
              <td>{m.name}</td>
              <td>{t(guildRankKey(m.rank))}</td>
              <td>{t(`vocation.${m.vocation}.name`)}</td>
              <td>{m.level}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <Link href="/guilds">{t("site.guilds.back")}</Link>
      </p>
    </section>
  );
}

// ---- houses (T5.4): GET /api/houses, the houses of the map by town -------------------

interface HouseEntry {
  id: string;
  name: string;
  island: string;
  rent: number;
  size: number;
  taken: boolean;
  owner: string;
}

function HousesPage(props: { t: Translate }): JSX.Element {
  const { t } = props;
  const data = useJSON<{ houses: HouseEntry[] }>("/api/houses");
  const towns: string[] = [];
  if (data && typeof data === "object")
    for (const h of data.houses) if (!towns.includes(h.island)) towns.push(h.island);
  return (
    <section class="card" aria-labelledby="houses-title">
      <h1 id="houses-title">{t("site.houses.title")}</h1>
      <p class="muted">{t("site.houses.intro")}</p>
      {data === undefined ? (
        <p class="muted" role="status">
          {t("site.houses.loading")}
        </p>
      ) : data === "error" || data === "missing" ? (
        <p class="error" role="alert">
          {t("site.houses.error")}
        </p>
      ) : (
        towns.map((town) => (
          <section key={town} data-testid={`houses-${town}`}>
            <h2>{t(`island.${town}.name`)}</h2>
            <table class="highscores">
              <thead>
                <tr>
                  <th scope="col">{t("site.houses.name")}</th>
                  <th scope="col">{t("site.houses.size")}</th>
                  <th scope="col">{t("site.houses.rent")}</th>
                  <th scope="col">{t("site.houses.status")}</th>
                </tr>
              </thead>
              <tbody>
                {data.houses
                  .filter((h) => h.island === town)
                  .map((h) => (
                    <tr key={h.id} data-house={h.id}>
                      <td>{t(h.name)}</td>
                      <td>{t("site.houses.tiles", { count: h.size })}</td>
                      <td>{t("site.houses.coins", { price: h.rent })}</td>
                      <td>
                        {h.owner
                          ? t("site.houses.rented", { name: h.owner })
                          : h.taken
                            ? t("site.houses.taken")
                            : t("site.houses.free")}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </section>
  );
}
