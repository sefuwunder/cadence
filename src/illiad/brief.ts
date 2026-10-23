// Illiad brief composer — chief-of-staff voice: crisp, warm, direct.
// Structure: daypart greeting → wins (real numbers first) → KPI pacing
// (honest about what's behind, no sugarcoating) → nudges (max 3,
// constructive) → one suggested focus → encouraging close.
// Positive state of play means leading with genuine progress and framing
// gaps as moves — never cheerleading. No emojis. *bold* used sparingly.

import { analyzeRun, fmt, whole, type RunAnalysis } from "./analyze.ts";

export function daypart(nowMs = Date.now()): string {
  const h = Number(new Date(nowMs).toLocaleString("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  }));
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  return "Good evening";
}

function paceWord(s: string): string {
  return s === "on_track" ? "on track" : s;
}

/** Full state-of-play brief for a dashboard payload. */
export function composeBrief(dash: any, nowMs = Date.now()): string {
  const a = analyzeRun(dash, nowMs);
  const paras: string[] = [];
  paras.push(`${daypart(nowMs)}. Here's the state of play on *${dash.run.name}*.`);

  // Wins — genuine progress, real numbers, first.
  const winBits: string[] = [];
  if (a.tasksDone > 0) {
    winBits.push(`${a.tasksDone} of ${a.tasksTotal} tasks done (${a.pct}%)`);
  }
  const ahead = a.pacing.filter((p) => p.status === "ahead");
  for (const p of ahead) {
    winBits.push(`*${p.name}* ahead of pace (${fmt(p.actual)} vs ${whole(p.expected)} expected)`);
  }
  if (a.newReplies > 0) {
    winBits.push(`${a.newReplies} new ${a.newReplies === 1 ? "reply" : "replies"} in linked threads`);
  }
  if (a.momentum > 0) {
    winBits.push(`completions accelerating — ${a.completionsThisWeek} this week vs ${a.completionsLastWeek} last`);
  }
  paras.push(winBits.length
    ? `Wins: ${winBits.join("; ")}.`
    : "No wins on the board yet — the week is young, and the board is set.");

  // Pacing — honest, names what's behind.
  const paced = a.pacing.filter((p) => p.status !== "no_target");
  if (paced.length) {
    const lines = paced.map((p) =>
      `- *${p.name}*: ${fmt(p.actual)} of ${whole(p.expected)} expected by now — ${paceWord(p.status)}`);
    paras.push(`KPI pacing (week ${a.currentWeek}):\n${lines.join("\n")}`);
  }

  // Nudges — constructive, at most three.
  const nudges: string[] = [];
  for (const s of a.stalled.slice(0, 2)) {
    nudges.push(`"${s.title}" (${s.role}, W${s.week}) has been quiet ${s.days_quiet}d — worth a check-in`);
  }
  const behind = a.pacing.filter((p) => p.status === "behind");
  for (const p of behind.slice(0, 2)) {
    const gap = p.expected - p.actual;
    nudges.push(`*${p.name}* needs ${whole(gap)} more by week's end to get back on pace`);
  }
  for (const u of a.unreadThreads.slice(0, 1)) {
    nudges.push(`${u.unseen} unread ${u.unseen === 1 ? "reply" : "replies"} in "${u.subject}" — don't let it sit`);
  }
  if (nudges.length) {
    paras.push(`Nudges:\n${nudges.slice(0, 3).map((n) => `- ${n}`).join("\n")}`);
  }

  // One suggested focus — the single highest-leverage move.
  let focus: string;
  const mostBehind = behind.sort((x, y) => x.ratio - y.ratio)[0];
  if (mostBehind) {
    focus = `Close the *${mostBehind.name}* gap — it's the furthest off pace, and it moves the number that matters.`;
  } else if (a.stalled.length) {
    focus = `Unstick "${a.stalled[0].title}" — one nudge there restarts the quietest corner of the board.`;
  } else if (a.newReplies > 0) {
    focus = `Answer the thread replies first — responsiveness is momentum you don't have to manufacture.`;
  } else {
    focus = `Protect the lead: pick the next incomplete task in week ${a.currentWeek} and move it today.`;
  }
  paras.push(`Suggested focus: ${focus}`);

  // Encouraging close — grounded in the actual state, never cheerleading.
  const close = behind.length
    ? "The gaps are real, but they're all moves waiting to happen — and you know exactly which ones."
    : a.tasksDone > 0
      ? "This is what a well-run sprint looks like. Keep the pressure on the inputs and the outputs follow."
      : "Every sprint starts at zero. The plan is set — now it's just execution, one task at a time.";
  paras.push(close);

  return paras.join("\n\n");
}

/** Standalone encouragement ("motivate me") — short, grounded in real numbers. */
export function composeEncouragement(dash: any, nowMs = Date.now()): string {
  const a = analyzeRun(dash, nowMs);
  const bits: string[] = [];
  if (a.tasksDone > 0) bits.push(`${a.tasksDone} tasks already done`);
  const aheadN = a.pacing.filter((p) => p.status === "ahead").length;
  if (aheadN > 0) bits.push(`${aheadN} ${aheadN === 1 ? "KPI" : "KPIs"} ahead of pace`);
  if (a.momentum > 0) bits.push("completions accelerating week over week");
  const proof = bits.length ? ` The board says so: ${bits.join(", ")}.` : "";
  const behindN = a.pacing.filter((p) => p.status === "behind").length;
  const tail = behindN > 0
    ? ` ${behindN} ${behindN === 1 ? "KPI is" : "KPIs are"} behind — that's not a verdict, it's a to-do list, and you know the moves.`
    : " Keep doing exactly what you're doing.";
  return `Here's the real picture: you're ${a.pct}% through the playbook in week ${a.currentWeek} of ${a.weekCount}.${proof}${tail}`;
}
