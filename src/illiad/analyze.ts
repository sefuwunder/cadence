// Illiad analysis — pure functions over a dashboard payload. Deterministic:
// same dashboard + same clock → same numbers. No I/O, no AI.

export type PaceStatus = "ahead" | "on_track" | "behind" | "no_target";

export interface KpiPace {
  id: string; name: string; unit: string; week: number;
  target: number; actual: number; expected: number; ratio: number;
  status: PaceStatus;
}

export interface RunAnalysis {
  tasksDone: number; tasksTotal: number; pct: number;
  currentWeek: number; weekCount: number;
  pacing: KpiPace[];
  stalled: { id: string; title: string; role: string; week: number; days_quiet: number }[];
  unreadThreads: { subject: string; taskTitle: string; unseen: number; last_from: string }[];
  newReplies: number;
  completionsThisWeek: number; completionsLastWeek: number;
  momentum: number; // this-week completions minus last-week completions
}

/** ISO week range for a run, mirroring server.ts weekRange. */
function weekRange(startDate: string, week: number): { from: string; to: string } {
  const s = new Date(startDate + "T00:00:00Z").getTime();
  return {
    from: new Date(s + (week - 1) * 7 * 864e5).toISOString().slice(0, 10),
    to: new Date(s + week * 7 * 864e5).toISOString().slice(0, 10),
  };
}

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function kpiPacing(dash: any, nowMs = Date.now()): KpiPace[] {
  const w = dash.current_week as number;
  const weekStartMs = new Date(dash.run.start_date + "T00:00:00Z").getTime() + (w - 1) * 7 * 864e5;
  const elapsed = Math.min(1, Math.max(0, (nowMs - weekStartMs) / (7 * 864e5)));
  return (dash.kpis || []).map((k: any) => {
    const targets: number[] = k.targets || [];
    let expected = 0;
    for (let i = 0; i < w - 1; i++) expected += num(targets[i]);
    expected += num(targets[w - 1]) * elapsed;
    const actual = (k.actuals || []).slice(0, w).reduce((a: number, b: any) => a + num(b), 0);
    let status: PaceStatus;
    let ratio = 0;
    if (expected <= 0) {
      status = actual > 0 ? "ahead" : "no_target";
      ratio = actual > 0 ? 2 : 0;
    } else {
      ratio = actual / expected;
      status = ratio >= 1 ? "ahead" : ratio >= 0.75 ? "on_track" : "behind";
    }
    return {
      id: k.id, name: k.name, unit: k.unit || "", week: w,
      target: num(targets[w - 1]), actual, expected, ratio, status,
    };
  });
}

export function analyzeRun(dash: any, nowMs = Date.now()): RunAnalysis {
  const w = dash.current_week as number;
  const weeks: any[] = dash.weeks || [];
  const stalled: RunAnalysis["stalled"] = [];
  const unreadThreads: RunAnalysis["unreadThreads"] = [];
  let newReplies = 0;

  for (const wk of weeks) {
    for (const [role, ts] of Object.entries(wk.roles || {}) as [string, any[]][]) {
      for (const t of ts) {
        if (t.stalled) {
          stalled.push({
            id: t.id, title: t.title, role, week: wk.week,
            days_quiet: t.days_quiet ?? 0,
          });
        }
        for (const l of t.links || []) {
          const unseen = Number(l.meta?.unseen) || 0;
          if (l.source === "email-imap" && l.kind === "thread" && unseen > 0) {
            newReplies += unseen;
            unreadThreads.push({
              subject: l.label, taskTitle: t.title, unseen,
              last_from: String(l.meta?.last_from || l.meta?.from || ""),
            });
          }
        }
      }
    }
  }
  stalled.sort((a, b) => b.days_quiet - a.days_quiet);
  unreadThreads.sort((a, b) => b.unseen - a.unseen);

  // Momentum: completions in the current vs previous week window.
  const inWeek = (iso: string, week: number) => {
    const { from, to } = weekRange(dash.run.start_date, week);
    return iso >= from && iso < to;
  };
  let thisW = 0, lastW = 0;
  for (const wk of weeks) {
    for (const ts of Object.values(wk.roles || {}) as any[][]) {
      for (const t of ts) {
        if (!t.done || !t.done_at) continue;
        const at = String(t.done_at).slice(0, 10);
        if (inWeek(at, w)) thisW++;
        else if (w > 1 && inWeek(at, w - 1)) lastW++;
      }
    }
  }

  const o = dash.overall || { tasks_done: 0, tasks_total: 0, pct: 0 };
  return {
    tasksDone: o.tasks_done, tasksTotal: o.tasks_total, pct: o.pct,
    currentWeek: w, weekCount: weeks.length,
    pacing: kpiPacing(dash, nowMs),
    stalled, unreadThreads, newReplies,
    completionsThisWeek: thisW, completionsLastWeek: lastW,
    momentum: thisW - lastW,
  };
}

/** Compact number formatting for prose: 14, 14.5 — never 14.00. */
export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** Whole-number display for prorated targets in prose — "2 more", never "1.2 more". */
export function whole(n: number): string {
  return String(Math.max(0, Math.ceil(n)));
}
