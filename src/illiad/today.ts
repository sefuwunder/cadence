// Illiad programs the Today page. The page's job is keeping the cadence —
// the weekly rhythm of the playbook — and the user should always feel hope
// and progression. So Today leads with genuine wins (real numbers), names
// one focus (the single highest-leverage move), and frames gaps as moves,
// never verdicts. Deterministic: same dashboard + same clock → same program.

import { analyzeRun, fmt } from "./analyze.ts";
import { daypart } from "./brief.ts";

export interface TodayFocus {
  task_id: string;
  title: string;
  role: string;
  week: number;
  reason: string;
}

export interface TodayProgram {
  greeting: string;
  /** One-line state of play, wins first. */
  line: string;
  focus: TodayFocus | null;
  /** Short win phrases for chips ("3 tasks done this week"). */
  wins: string[];
  momentum: { thisWeek: number; lastWeek: number } | null;
}

/** Pick the single highest-leverage incomplete task to move today. */
function pickFocus(dash: any, a: ReturnType<typeof analyzeRun>): TodayFocus | null {
  // 1. The quietest stalled task — one check-in restarts it.
  const s = a.stalled[0];
  if (s) {
    return {
      task_id: s.id, title: s.title, role: s.role, week: s.week,
      reason: `Quiet ${s.days_quiet}d — one check-in restarts the quietest corner of the board`,
    };
  }
  // 2. The thread with the most unread replies — responsiveness is momentum.
  const u = a.unreadThreads[0];
  if (u) {
    const t = findTask(dash, u.taskTitle);
    if (t) {
      return {
        task_id: t.id, title: t.title, role: t.role, week: t.week,
        reason: `${u.unseen} unread ${u.unseen === 1 ? "reply" : "replies"} waiting — answer it and keep the thread warm`,
      };
    }
  }
  // 3. The next incomplete task in the current week — the next move on the board.
  for (const w of dash.weeks || []) {
    if (w.week > a.currentWeek) continue;
    for (const [role, ts] of Object.entries(w.roles || {}) as [string, any[]][]) {
      const t = ts.find((x) => !x.done);
      if (t) {
        return {
          task_id: t.id, title: t.title, role, week: w.week,
          reason: "The next move on the board — one task closer",
        };
      }
    }
  }
  return null; // everything's done; the wins carry the page
}

function findTask(dash: any, title: string): { id: string; title: string; role: string; week: number } | null {
  for (const w of dash.weeks || []) {
    for (const [role, ts] of Object.entries(w.roles || {}) as [string, any[]][]) {
      const t = (ts as any[]).find((x) => x.title === title);
      if (t) return { id: t.id, title: t.title, role, week: w.week };
    }
  }
  return null;
}

export function programToday(dash: any, nowMs = Date.now()): TodayProgram {
  const a = analyzeRun(dash, nowMs);
  const wins: string[] = [];

  if (a.tasksDone > 0) {
    wins.push(`${a.tasksDone} of ${a.tasksTotal} tasks done`);
  }
  for (const p of a.pacing.filter((x) => x.status === "ahead")) {
    wins.push(`${p.name} ahead of pace`);
  }
  if (a.newReplies > 0) {
    wins.push(`${a.newReplies} new ${a.newReplies === 1 ? "reply" : "replies"} in linked threads`);
  }
  if (a.momentum > 0) {
    wins.push(`${a.completionsThisWeek} completion${a.completionsThisWeek === 1 ? "" : "s"} this week`);
  }

  const behind = a.pacing.filter((p) => p.status === "behind");
  const line = wins.length
    ? `${wins.join(" · ")}${behind.length ? ` · ${behind.length} KPI${behind.length === 1 ? "" : "s"} to pull back` : ""}`
    : behind.length
      ? `Week ${a.currentWeek} is underway — ${behind.length} KPI${behind.length === 1 ? " needs" : "s need"} a push, and the moves are clear`
      : `Week ${a.currentWeek} is underway — the board is set, and the first win is one task away`;

  const momentum = a.momentum !== 0 || a.completionsThisWeek > 0
    ? { thisWeek: a.completionsThisWeek, lastWeek: a.completionsLastWeek }
    : null;

  return {
    greeting: daypart(nowMs),
    line,
    focus: pickFocus(dash, a),
    wins,
    momentum,
  };
}
