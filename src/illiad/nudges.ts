// Illiad behavior nudges — deterministic, derived from the dashboard payload.
// Surfaced in the Activity pane ("Nudges from Illiad"). Pure function: no I/O,
// no AI. Same dashboard + same clock → same nudges. No emojis (Illiad voice).

import { analyzeRun, whole } from "./analyze.ts";

export interface Nudge {
  kind: "stalled" | "pacing" | "unread" | "momentum";
  text: string;
  task_id?: string; // stalled nudges tap through to the task's feed
}

/** At most 4 nudges: stalled tasks first, then pacing gaps, unread replies,
 *  and a momentum note when completions are accelerating. */
export function nudgeList(dash: any, nowMs = Date.now()): Nudge[] {
  const a = analyzeRun(dash, nowMs);
  const out: Nudge[] = [];

  for (const s of a.stalled.slice(0, 2)) {
    out.push({
      kind: "stalled",
      task_id: s.id,
      text: `“${s.title}” (${s.role}) has been quiet ${s.days_quiet}d — worth a check-in`,
    });
  }

  const behind = a.pacing.filter((p) => p.status === "behind");
  for (const p of behind.slice(0, 2)) {
    out.push({
      kind: "pacing",
      text: `${p.name} needs ${whole(p.expected - p.actual)} more by week's end to get back on pace`,
    });
  }

  for (const u of a.unreadThreads.slice(0, 2)) {
    out.push({
      kind: "unread",
      text: `${u.unseen} unread ${u.unseen === 1 ? "reply" : "replies"} in “${u.subject}” — don't let it sit`,
    });
  }

  if (a.momentum > 0 && out.length < 4) {
    out.push({
      kind: "momentum",
      text: `Completions accelerating — ${a.completionsThisWeek} this week vs ${a.completionsLastWeek} last`,
    });
  }

  return out.slice(0, 4);
}
