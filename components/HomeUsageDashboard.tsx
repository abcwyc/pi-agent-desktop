"use client";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useHomeExperience } from "@/hooks/useHomeExperience";
import type { HomeUsage, HomeUsageRange } from "@/lib/home-usage";
import { ConfigButton } from "./SettingsUi";

const TOKEN_BOOKS = [
  [7607, "home.bookTao"], [27557, "home.bookMetamorphosis"], [39000, "home.bookAnimalFarm"],
  [65763, "home.bookGatsby"], [80168, "home.bookWarOfTheWorlds"], [136278, "home.book1984"],
] as const;

export function HomeUsageDashboard() {
  const { dashboard } = useHomeExperience();
  return dashboard ? <Dashboard /> : null;
}

function Dashboard() {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<HomeUsageRange>("all");
  const [expanded, setExpanded] = useState(false);
  const [hour] = useState(() => new Date().getHours());
  const [tab, setTab] = useState<"overview" | "models">("overview");
  const [result, setResult] = useState<{ range: HomeUsageRange; data: HomeUsage } | null>(null);
  const [history, setHistory] = useState<HomeUsage | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    fetch("/api/home-usage?range=" + range, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Usage unavailable");
        const data: HomeUsage = await response.json();
        if (!controller.signal.aborted) { setResult({ range, data }); if (range === "all") setHistory(data); }
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range, revision]);
  useEffect(() => {
    if (range === "all") return;
    const controller = new AbortController();
    fetch("/api/home-usage?range=all", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<HomeUsage>; })
      .then((data) => { if (!controller.signal.aborted) setHistory(data); }).catch(() => {});
    return () => controller.abort();
  }, [range, revision]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setRevision((n) => n + 1); };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const data = !loading && result?.range === range ? result.data : null;
  const format = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(locale);
  const calendar = useMemo(() => {
    if (!history) return [];
    const end = new Date(history.generatedAt);
    end.setUTCHours(0, 0, 0, 0);
    const byDay = new Map(history.days.map((day) => [day.date, day]));
    const start = new Date(end.getTime() - 181 * 86400000);
    const length = 182 + start.getUTCDay();
    const max = Math.max(1, ...history.days.map((day) => day.tokens));
    return Array.from({ length }, (_, index) => {
      const date = new Date(end.getTime() - (length - index - 1) * 86400000).toISOString().slice(0, 10);
      const day = byDay.get(date);
      const messages = day?.messages ?? 0;
      const tokens = day?.tokens ?? 0;
      return { date, messages, tokens, level: tokens === 0 ? 0 : Math.max(1, Math.ceil(tokens / max * 4)) };
    });
  }, [history]);
  const chartDays = useMemo(() => {
    if (!history) return [];
    const end = new Date(history.generatedAt); end.setUTCHours(0, 0, 0, 0);
    const byDay = new Map(history.days.map((day) => [day.date, day]));
    return Array.from({ length: 30 }, (_, i) => {
      const date = new Date(end.getTime() - (29 - i) * 86400000).toISOString().slice(0, 10);
      return byDay.get(date) ?? { date, tokens: 0, messages: 0, models: {} };
    });
  }, [history]);
  const chartMax = Math.max(1, ...chartDays.map((day) => day.tokens));
  const funBook = TOKEN_BOOKS.filter(([tokens]) => (data?.tokens ?? 0) >= tokens).at(-1);
  const funText = funBook && data?.tokens != null
    ? t("home.funBook", { count: Math.max(1, Math.round(data.tokens / funBook[0])), book: t(funBook[1]) })
    : null;
  const colors = ["#426cad", "#6a8fc3", "#94afd3", "#bbcbe0", "#93969c"];
  const metrics = [
    ["sessions", data?.sessions], ["messages", data?.messages], ["tokens", data?.tokens],
    ["activeDays", data?.activeDays], ["peakHour", data?.peakHour == null ? "—" : String(data.peakHour).padStart(2, "0") + ":00 UTC"],
    ["favoriteModel", data?.favoriteModel ?? "—"],
  ] as const;
  return <section className="home-usage" aria-label={t("home.dashboard")} aria-busy={loading}>
    <h1 className="home-greeting"><span aria-hidden="true">✳</span>{t(hour < 6 ? "home.greeting.night" : hour < 12 ? "home.greeting.morning" : hour < 18 ? "home.greeting.afternoon" : "home.greeting.evening")}</h1>
    <div className="home-usage-panel">
    <div className="home-usage-header">
      <div className="home-usage-tabs" role="group" aria-label={t("home.dashboard")}>
        {(["overview", "models"] as const).map((value) => <button type="button" key={value} aria-pressed={tab === value}
          onClick={() => setTab(value)}>{t("home." + value)}</button>)}
      </div>
      <div className="home-usage-tabs" role="group" aria-label={t("home.range")}>
        {(["all", "30", "7"] as const).map((value) => <button type="button" key={value} aria-pressed={range === value}
          onClick={() => setRange(value)}>{t("home.range." + value)}</button>)}
      </div>
    </div>
    {loading ? <div className="home-usage-loading" role="status"><p className="home-usage-note">{t("home.loading")}</p><div className="home-usage-metrics" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div key={i}><span className="home-skeleton" /><span className="home-skeleton" /></div>)}</div><div className="home-usage-calendar" aria-hidden="true">{Array.from({ length: 182 }, (_, i) => <span key={i} />)}</div></div> : error ? <div role="alert" className="home-usage-note">
      <p>{t("home.error")}</p><ConfigButton variant="secondary" size="small" onClick={() => setRevision((n) => n + 1)}>{t("home.retry")}</ConfigButton>
    </div> : data && <>
      {tab === "overview" ? <>
        <dl className="home-usage-metrics">{metrics.map(([key, value]) => <div key={key}>
          <dt>{t("home." + key)}</dt><dd title={typeof value === "string" ? value : undefined}>{typeof value === "string" ? value : format(value)}</dd>
        </div>)}</dl>
        <p className="home-usage-note">{t("home.activity182")}</p>
        <div className="home-usage-calendar" aria-label={t("home.activity")}>
          {calendar.map((day) => <span key={day.date} data-level={day.level} role="img"
            aria-label={day.date + ": " + format(day.tokens) + " tokens"}
            title={day.date + ": " + format(day.tokens) + " tokens"} />)}
        </div>
        {funText && <p className="home-usage-fun">{funText}</p>}
      </> : data.models.length > 0 ? <>
        <div className="home-model-chart" role="img" aria-label={t("home.modelTrend")}>
          <div className="home-model-chart-bars">{chartDays.map((day) => <div className="home-model-chart-day" key={day.date} title={day.date + ": " + format(day.tokens) + " tokens"}>
            {(history?.models ?? data.models).map((model, index) => <span key={model.name} style={{ height: `${(day.models?.[model.name] ?? 0) / chartMax * 100}%`, background: colors[Math.min(index, 4)] }} />)}
          </div>)}</div>
          <div className="home-model-chart-axis"><span>{chartDays[0]?.date.slice(5)}</span><span>{chartDays.at(-1)?.date.slice(5)}</span></div>
        </div>
        <ol className="home-usage-models">
        {data.models.slice(0, expanded ? undefined : 5).map((model, index) => <li key={model.name}>
          <div><span className="home-model-name"><i style={{ background: colors[Math.min(Math.max(0, history?.models.findIndex((entry) => entry.name === model.name) ?? index), 4)] }} />{index + 1}. {model.name}</span><span>{format(model.tokens)} · {((model.tokens / Math.max(1, data.tokens ?? 0)) * 100).toFixed(1)}%</span></div>
          <meter min={0} max={Math.max(1, data.tokens ?? 0)} value={model.tokens} aria-label={model.name} />
        </li>)}
        </ol>
        {data.models.length > 5 && <button className="home-model-expand" type="button" onClick={() => setExpanded(!expanded)}>{t(expanded ? "home.showLess" : "home.showMore")}</button>}
      </> : <p className="home-usage-note">{t("home.noUsage")}</p>}
      {data.messages === 0 && <p className="home-usage-note">{t("home.empty")}</p>}
      {data.skippedFiles > 0 && <p className="home-usage-note" role="status">{t("home.skipped", { count: data.skippedFiles })}</p>}
      <p className="home-usage-note">{t("home.dataHint")}</p>
    </>}
    </div>
  </section>;
}
