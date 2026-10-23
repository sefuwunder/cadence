// Calendar (iCal) connector — read-only event feed from an iCal URL.
// Two roles:
//   sync({from,to,config}) → per-day counts of events whose SUMMARY matches
//     config.query (empty query matches everything), for KPI actuals.
//   The events endpoint in server.ts reuses parseIcs/fetchIcs/filterEvents
//     for the "Meeting" pill in the task feed.
//
// Config resolution (first hit wins):
//   1. connector config (saved in connector_cfg): { url, query }
//   2. env: CALENDAR_ICAL_URL, CALENDAR_QUERY
//   3. gitignored JSON: $CADENCE_DATA_DIR/calendar.json { "url": "...", "query": "..." }
// The secret lives in the URL — it is never logged.
//
// ICS parsing is a minimal subset ported from docket's src/ical.js (unfold,
// parseProp, parseIcalDt): UID, SUMMARY, DTSTART/DTEND with UTC (Z),
// floating (server-local), and all-day DATE values. RRULE recurrence is NOT
// expanded in v1 — a recurring event contributes only its base instance.

import { readFileSync } from "fs";
import { join } from "path";

class CalError extends Error {}

// ---------- minimal ICS parsing (ported from docket) ----------

function unfold(text: string): string {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
}

function parseProp(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const parts = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const k = p.indexOf("=");
    if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: parts[0].toUpperCase(), params, value: line.slice(i + 1) };
}

/** Parse a DT value → Date. UTC (Z), floating (server-local), or all-day DATE. */
export function parseIcalDt(value: string, params: Record<string, string>): Date | null {
  const m = String(value || "").trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(?:(\d{2}))?(Z)?)?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, da = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0);
  if (params.VALUE === "DATE") return new Date(y, mo, da);
  if (m[7] === "Z") return new Date(Date.UTC(y, mo, da, h, mi));
  return new Date(y, mo, da, h, mi); // floating → server-local (TZID ignored v1)
}

export interface CalEvent {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean; // RRULE present — base instance only in v1
}

/** Parse ICS text → events. Drops malformed VEVENTs; never throws on content. */
export function parseIcs(text: string): CalEvent[] {
  const events: CalEvent[] = [];
  let cur: any = null;
  for (const line of unfold(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t === "BEGIN:VEVENT") { cur = {}; continue; }
    if (t === "END:VEVENT") {
      if (cur?.dtstart) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseProp(t);
    if (!p) continue;
    if (p.name === "UID") cur.uid = p.value.trim();
    else if (p.name === "SUMMARY") cur.title = p.value.replace(/\\(.)/g, "$1").trim();
    else if (p.name === "DTSTART") {
      cur.dtstart = parseIcalDt(p.value, p.params);
      cur.allDay = p.params.VALUE === "DATE";
    } else if (p.name === "DTEND") cur.dtend = parseIcalDt(p.value, p.params);
    else if (p.name === "RRULE") cur.recurring = true;
  }
  const out: CalEvent[] = [];
  for (const e of events) {
    if (!(e.dtstart instanceof Date) || isNaN(+e.dtstart)) continue;
    let end = e.dtend instanceof Date && !isNaN(+e.dtend) ? e.dtend : null;
    if (!end) end = e.allDay
      ? new Date(e.dtstart.getTime() + 864e5)
      : new Date(e.dtstart.getTime() + 36e5);
    if (end <= e.dtstart) end = new Date(e.dtstart.getTime() + 36e5);
    out.push({
      uid: e.uid || "", title: e.title || "Busy",
      start: e.dtstart, end, allDay: !!e.allDay, recurring: !!e.recurring,
    });
  }
  return out;
}

const p2 = (n: number) => String(n).padStart(2, "0");
/** Server-local YYYY-MM-DD for day bucketing. */
export function fmtDay(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Overlap with [from, to] (inclusive days) + optional case-insensitive
 *  SUMMARY substring. Returns matches sorted by start. */
export function filterEvents(events: CalEvent[], from: string, to: string, query: string): CalEvent[] {
  const q = String(query || "").toLowerCase().trim();
  const fromT = new Date(from + "T00:00:00").getTime();
  const toT = new Date(to + "T23:59:59").getTime();
  return events
    .filter((e) => {
      if (q && !e.title.toLowerCase().includes(q)) return false;
      return e.end.getTime() > fromT && e.start.getTime() <= toT;
    })
    .sort((a, b) => +a.start - +b.start);
}

// ---------- config + fetch ----------

export function resolveCalConfig(config: any): { url: string; query: string } {
  const o = config && typeof config === "object" ? config : {};
  let fileCfg: any = {};
  try {
    fileCfg = JSON.parse(readFileSync(join(process.env.CADENCE_DATA_DIR || "data", "calendar.json"), "utf8"));
  } catch { /* optional file */ }
  const url = String(o.url || process.env.CALENDAR_ICAL_URL || fileCfg.url || "").trim();
  if (!url) {
    throw new CalError(
      "calendar-ical: no iCal URL configured — set it in the connector setup, " +
      "CALENDAR_ICAL_URL env, or $CADENCE_DATA_DIR/calendar.json");
  }
  return { url, query: String(o.query || process.env.CALENDAR_QUERY || fileCfg.query || "") };
}

export async function fetchIcs(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new CalError(`calendar-ical: feed returned HTTP ${res.status}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      throw new CalError("calendar-ical: URL did not return iCalendar data");
    }
    return text;
  } catch (e: any) {
    if (e instanceof CalError) throw e;
    throw new CalError(`calendar-ical: fetch failed — ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

export const connector = {
  id: "calendar-ical",
  name: "Calendar (iCal feed)",
  description:
    "Counts matching calendar events per day from an iCal URL (read-only). " +
    "Configure the feed URL in the connector setup (masked), CALENDAR_ICAL_URL env, " +
    "or data/calendar.json. Optional SUMMARY query filters which events count. " +
    "RRULE recurrence is not expanded in v1 — recurring events count once at their base instance.",
  async sync(opts: { from: string; to: string; config: any }) {
    const { url, query } = resolveCalConfig(opts.config); // URL never logged
    const events = filterEvents(parseIcs(await fetchIcs(url)), opts.from, opts.to, query);
    const byDay = new Map<string, number>();
    for (const e of events) byDay.set(fmtDay(e.start), (byDay.get(fmtDay(e.start)) || 0) + 1);
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, value]) => ({ date, value, note: `${value} event${value === 1 ? "" : "s"}` }));
  },
};

export const _test = { parseIcs, parseIcalDt, fmtDay, filterEvents, resolveCalConfig };
