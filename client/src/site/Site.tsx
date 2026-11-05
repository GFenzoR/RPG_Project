// The public website (T4.3): landing, highscores and news. A small single-page app at /,
// /highscores and /news[/<slug>]; the game is another page at /play/. Every text comes
// from i18n (site.yaml, plus skill and vocation names) or from data/news.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import type { NewsPost, SiteContent } from "../content-types.ts";
import { Markdown } from "./Markdown.tsx";
import { excerpt } from "./markdown.ts";
import {
  LEVEL,
  categoryKey,
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
  const { t, lang } = props;
  const loc = useLocation();
  const route = parseRoute(loc.pathname);
  const playHref = `/play/?lang=${encodeURIComponent(lang)}`;
  const section = route.page === "post" ? "news" : route.page;
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
      news: t("site.news.title"),
      post: "",
      not_found: "",
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
    case "news":
      return <NewsList {...props} />;
    case "post":
      return <NewsDetail {...props} slug={route.slug} />;
    default:
      return (
        <section class="card">
          <h1>{t("site.news.not_found")}</h1>
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
