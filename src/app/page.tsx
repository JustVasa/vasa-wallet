"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// --- Types
type Tx = { id: string; amount: number; ts: number; desc?: string };
type Frame = "hour" | "day" | "week" | "month" | "year";

// --- Helpers
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function isTx(x: unknown): x is Tx {
  const t = x as Partial<Tx>;
  return typeof t?.id === "string" && Number.isFinite(t?.amount) && Number.isFinite(t?.ts);
}

function startOfFrame(date: Date, frame: Frame) {
  const d = new Date(date);
  if (frame === "hour") d.setMinutes(0, 0, 0);
  if (frame === "day") d.setHours(0, 0, 0, 0);
  if (frame === "week") {
    const day = (d.getDay() + 6) % 7; // 0..6 (Mon..Sun) -> Monday start
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
  }
  if (frame === "month") {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
  }
  if (frame === "year") {
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
  }
  return d;
}

function formatTick(ts: number, frame: Frame) {
  const d = new Date(ts);
  let options: Intl.DateTimeFormatOptions;
  switch (frame) {
    case "hour":
      options = { hour: "2-digit", day: "2-digit", month: "2-digit" };
      break;
    case "day":
    case "week":
      options = { day: "2-digit", month: "2-digit" };
      break;
    case "month":
      options = { month: "short", year: "numeric" };
      break;
    case "year":
    default:
      options = { year: "numeric" };
  }
  const fmt = new Intl.DateTimeFormat("cs-CZ", options);
  return fmt.format(d);
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Group transactions into frames and compute cumulative balance per bucket
function buildSeries(txs: Tx[], frame: Frame) {
  if (txs.length === 0) return [] as { ts: number; balance: number }[];
  const sorted = [...txs].sort((a, b) => a.ts - b.ts);

  const bucket = new Map<number, number>();
  for (const t of sorted) {
    const key = startOfFrame(new Date(t.ts), frame).getTime();
    bucket.set(key, (bucket.get(key) ?? 0) + t.amount);
  }

  const keys = [...bucket.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return [];

  const series: { ts: number; balance: number }[] = [];
  let cursor = keys[0];
  const end = startOfFrame(new Date(), frame).getTime();
  let accum = 0;
  let safety = 0;

  while (cursor <= end && safety < 100000) {
    accum = round2(accum + (bucket.get(cursor) ?? 0));
    series.push({ ts: cursor, balance: accum });

    const c = new Date(cursor);
    if (frame === "month") c.setMonth(c.getMonth() + 1);
    else if (frame === "year") c.setFullYear(c.getFullYear() + 1);
    else
      cursor += frame === "hour" ? 3600_000 : frame === "day" ? 86_400_000 : frame === "week" ? 7 * 86_400_000 : 30 * 86_400_000;
    if (frame === "month" || frame === "year") cursor = c.getTime();
    safety++;
  }

  return series;
}

// --- Server persistence (API) ---
async function loadTxServer(): Promise<Tx[]> {
  try {
    const res = await fetch("/api/tx", { cache: "no-store" });
    if (!res.ok) return [];
    const json = await res.json();
    const arr = Array.isArray(json?.tx) ? json.tx : [];
    return arr.filter(isTx);
  } catch {
    return [];
  }
}

async function saveTxServer(list: Tx[]) {
  try {
    const res = await fetch("/api/tx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx: list }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn("POST /api/tx not ok:", res.status, await res.text());
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("POST /api/tx failed:", e);
  }
}

export default function FinanceTracker() {
  const [frame, setFrame] = useState<Frame>("month");
  const [tx, setTx] = useState<Tx[]>([]);
  const [amount, setAmount] = useState<string>("");
  const [desc, setDesc] = useState<string>(""); // 👈 nový popisek
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Stráže/debounce
  const loadedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Načtení ze serveru
  useEffect(() => {
    loadTxServer().then((data) => {
      setTx(data);
      loadedRef.current = true;
    });
  }, []);

  // Debounced ukládání (po změně tx)
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTxServer(tx);
    }, 250);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [tx]);

  const balance = useMemo(() => round2(tx.reduce((a, b) => a + b.amount, 0)), [tx]);
  const series = useMemo(() => buildSeries(tx, frame), [tx, frame]);

  // Okamžitý zápis při akci
  function addTransaction(sign: 1 | -1) {
    const val = parseFloat(amount.replace(",", "."));
    if (!Number.isFinite(val) || val === 0) return;
    const d = desc.trim();
    const newTx: Tx = { id: uid(), amount: round2(sign * val), ts: Date.now(), desc: d || undefined };
    setTx((prev) => {
      const next = [...prev, newTx];
      if (loadedRef.current) saveTxServer(next);
      return next;
    });
    setAmount("");
    setDesc("");
    inputRef.current?.focus();
  }

  function resetAll() {
    if (!confirm("Smazat všechny položky?")) return;
    setTx(() => {
      const next: Tx[] = [];
      if (loadedRef.current) saveTxServer(next);
      return next;
    });
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(tx, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `finance-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        if (!Array.isArray(parsed)) throw new Error("Invalid file");
        const cleaned = parsed.filter(isTx);
        setTx(() => {
          if (loadedRef.current) saveTxServer(cleaned);
          return cleaned;
        });
      } catch {
        alert("Soubor není platný JSON export.");
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900 antialiased">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <h1 className="text-2xl font-bold tracking-tight">💸 Finance Tracker</h1>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm text-gray-600">Časová osa:</label>
            <select
              value={frame}
              onChange={(e) => setFrame(e.target.value as Frame)}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="hour">Hodiny</option>
              <option value="day">Dny</option>
              <option value="week">Týdny</option>
              <option value="month">Měsíce</option>
              <option value="year">Roky</option>
            </select>
            <button
              onClick={resetAll}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-100"
              title="Smazat vše"
            >
              Reset
            </button>
            <button
              onClick={exportJson}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-100"
            >
              Export
            </button>
            <label className="cursor-pointer rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-100">
              Import
              <input type="file" accept="application/json" className="hidden" onChange={importJson} />
            </label>
          </div>
        </header>

        {/* KPI Cards */}
        <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-2xl bg-white p-4 shadow">
            <div className="text-sm text-gray-500">Zůstatek</div>
            <div className={`mt-1 text-2xl font-semibold ${balance >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {balance.toLocaleString("cs-CZ", { style: "currency", currency: "CZK", maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow">
            <div className="text-sm text-gray-500">Položek celkem</div>
            <div className="mt-1 text-2xl font-semibold">{tx.length}</div>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow">
            <div className="text-sm text-gray-500">Zobrazený rámec</div>
            <div className="mt-1 text-2xl font-semibold capitalize">{frame}</div>
          </div>
        </section>

        {/* Chart */}
        <section className="rounded-2xl bg-white p-4 shadow">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Vývoj zůstatku v čase</h2>
            <p className="text-sm text-gray-500">Cumulative P&L</p>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <LineChart data={series} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={(v) => formatTick(v as number, frame)}
                  domain={["dataMin", "dataMax"]}
                  type="number"
                />
                <YAxis tickFormatter={(v) => v.toLocaleString("cs-CZ", { maximumFractionDigits: 0 })} />
                <Tooltip
                  labelFormatter={(v) => new Date(Number(v)).toLocaleString("cs-CZ")}
                  formatter={(value: unknown) => [
                    Number(value).toLocaleString("cs-CZ", {
                      style: "currency",
                      currency: "CZK",
                      maximumFractionDigits: 2,
                    }),
                    "Zůstatek",
                  ]}
                />
                <Line type="monotone" dataKey="balance" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Input / Controls */}
        <section className="mt-6 rounded-2xl bg-white p-4 shadow">
          <h3 className="mb-3 text-lg font-semibold">Nová položka</h3>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              placeholder="Částka (např. 2500 nebo -300)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTransaction(1);
              }}
              className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 sm:max-w-xs"
            />
            <input
              type="text"
              placeholder="Popisek (např. Oběd, Benzín...)"
              value={desc}
              onChange={(e) => setDesc(e.target.value.slice(0, 120))}
              className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 sm:max-w-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => addTransaction(1)}
                className="rounded-xl bg-emerald-600 px-5 py-3 font-medium text-white shadow hover:brightness-105 active:scale-[.99]"
              >
                + Přičíst
              </button>
              <button
                onClick={() => addTransaction(-1)}
                className="rounded-xl bg-rose-600 px-5 py-3 font-medium text-white shadow hover:brightness-105 active:scale-[.99]"
              >
                − Odečíst
              </button>
            </div>
          </div>

          {/* Recent list */}
          <div className="mt-6">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">Poslední položky</h4>
            <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-gray-50">
              {[...tx]
                .sort((a, b) => b.ts - a.ts)
                .slice(0, 10)
                .map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-gray-800">
                        {t.desc ? t.desc : <span className="italic text-gray-500">Bez popisku</span>}
                      </div>
                      <div className="text-xs text-gray-500">{new Date(t.ts).toLocaleString("cs-CZ")}</div>
                    </div>
                    <div className={`shrink-0 font-medium ${t.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {t.amount >= 0 ? "+" : ""}
                      {t.amount.toLocaleString("cs-CZ", { style: "currency", currency: "CZK" })}
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-10 text-center text-xs text-gray-500">
          Data se ukládají na server (Upstash Redis) a sdílejí mezi zařízeními. Export/Import JSON je k dispozici pro zálohu.
        </footer>
      </div>
    </div>
  );
}
