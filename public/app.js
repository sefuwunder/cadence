/* Cadence — vanilla SPA. No dependencies. */
"use strict";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const state = {
  runs: [], runId: localStorage.getItem("cadence.runId") || null,
  dash: null, connectors: [], tab: "today", playbookWeek: null,
};

const TABS = [
  ["today", "◉", "Today"],
  ["playbook", "▤", "Playbook"],
  ["kpis", "◔", "KPIs"],
  ["activity", "≋", "Activity"],
  ["illiad", "✦", "Illiad"],
  ["people", "◍", "People"],
];

/* ---------- sheet ---------- */
function openSheet(html) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  $("#sheet-backdrop").hidden = false;
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-backdrop").hidden = true;
}
$("#sheet-backdrop").addEventListener("click", closeSheet);

/* ---------- boot ---------- */
async function boot() {
  // side nav tabs
  $("#side-tabs").innerHTML = TABS.map(([id, ico, label]) =>
    `<button data-tab="${id}" class="tab${id === "today" ? " active" : ""}"><span class="tab-ico">${ico}</span><span>${label}</span></button>`).join("");
  $$("#tabbar .tab, #side-tabs .tab").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#run-select").addEventListener("change", (e) => selectRun(e.target.value));
  $("#btn-new-run").addEventListener("click", newRunSheet);
  state.connectors = await api("/api/connectors").catch(() => []);
  await loadRuns();
}
document.addEventListener("DOMContentLoaded", boot);

async function loadRuns() {
  state.runs = await api("/api/runs").catch(() => []);
  const sel = $("#run-select");
  sel.innerHTML = state.runs.map((r) =>
    `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  if (!state.runs.length) { renderEmpty(); return; }
  if (!state.runId || !state.runs.some((r) => r.id === state.runId)) {
    state.runId = state.runs[0].id;
    localStorage.setItem("cadence.runId", state.runId);
  }
  sel.value = state.runId;
  await loadDash();
}

async function selectRun(id) {
  state.runId = id;
  localStorage.setItem("cadence.runId", id);
  state.playbookWeek = null;
  await loadDash();
}

async function loadDash() {
  state.dash = await api(`/api/runs/${state.runId}`);
  state.people = null; // stakeholder rollup is per-run; refetch on demand
  if (!state.playbookWeek) state.playbookWeek = state.dash.current_week;
  render();
}

function setTab(tab) {
  state.tab = tab;
  $$("#tabbar .tab, #side-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".view").forEach((v) => (v.hidden = true));
  $(`#view-${tab}`).hidden = false;
  render();
}

/* ---------- shared render bits ---------- */
function taskState(t) {
  if (t.done) return "done";
  if (t.unread) return "unread";
  if (t.stalled) return "stalled";
  return "todo";
}
function unreadCount(t) {
  return (t.links || []).reduce((a, l) => a + (Number((l.meta || {}).unseen) || 0), 0);
}
/** Task card. Whole card opens the feed sheet (data-ev). State → accent color. */
function taskCard(t, sub) {
  const n = (t.links || []).length;
  const st = taskState(t);
  const uc = unreadCount(t);
  const chip = t.done ? `<span class="state-chip">Done</span>`
    : uc > 0 ? `<span class="state-chip">${uc} new</span>`
    : t.stalled ? `<span class="state-chip">${t.days_quiet || 0}d quiet</span>` : "";
  return `<div class="task-card st-${st}" data-ev="${esc(t.id)}" role="button" tabindex="0" aria-label="${esc(t.title)} — open feed">
    <div class="task-card-main"><span class="task-title">${esc(t.title)}</span>${chip}</div>
    ${sub ? `<div class="task-card-sub">${sub}</div>` : ""}
    ${n ? `<div class="task-card-sub">${n} in feed</div>` : ""}
  </div>`;
}
/** Folded section: first card visible, rest behind an expander. */
function foldCards(cards) {
  if (cards.length <= 1) return cards.join("");
  const [first, ...rest] = cards;
  return `${first}
    <button class="fold-more" data-foldmore>Show all ${cards.length} ▾</button>
    <div class="fold-rest" hidden>${rest.join("")}</div>`;
}
function roleBlocks(roles, folded) {
  return Object.entries(roles).map(([role, tasks]) => {
    const done = tasks.filter((t) => t.done).length;
    const cards = tasks.map((t) => taskCard(t));
    return `<div class="role-block">
      <div class="role-head">${esc(role)} <span class="count">${done}/${tasks.length}</span></div>
      ${folded ? foldCards(cards) : cards.join("")}
    </div>`;
  }).join("");
}
function kpiGlance(k) {
  const w = state.dash.current_week - 1;
  const tgt = k.targets[w] ?? 0, act = k.actuals[w] ?? 0;
  const pct = tgt > 0 ? Math.min(100, Math.round((100 * act) / tgt)) : (act > 0 ? 100 : 0);
  return `<div class="card">
    <div class="kpi-top"><span class="kpi-name">${esc(k.name)}</span><span class="kpi-unit">${esc(k.unit)}</span></div>
    <div class="bar-row" style="margin-top:8px"><span>Week ${w + 1} target</span><span><b style="color:var(--text)">${act}</b> / ${tgt}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
  </div>`;
}

/* ---------- views ---------- */
function render() {
  if (!state.dash) return;
  renderSideFoot();
  ({ today: renderToday, playbook: renderPlaybook, kpis: renderKpis, activity: renderActivity, illiad: renderIlliad, people: renderPeople })[state.tab]();
  // wire toggles (event delegation once)
}

document.addEventListener("click", async (e) => {
  const evb = e.target.closest("[data-ev]");
  if (evb) { feedSheet(evb.dataset.ev); return; }
  const fm = e.target.closest("[data-foldmore]");
  if (fm) {
    const rest = fm.nextElementSibling;
    const open = rest.hidden;
    rest.hidden = !open;
    fm.textContent = open ? "Show less ▴" : `Show all ${rest.children.length + 1} ▾`;
    return;
  }
  const ft = e.target.closest("[data-foldtoggle]");
  if (ft) {
    const body = document.getElementById(ft.dataset.foldtoggle);
    const open = body.hidden;
    body.hidden = !open;
    ft.setAttribute("aria-expanded", String(open));
    ft.querySelector(".fold-arrow").textContent = open ? "▾" : "▸";
    return;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const c = e.target && e.target.closest ? e.target.closest("[data-ev]") : null;
    if (c) feedSheet(c.dataset.ev);
  }
});

function renderSideFoot() {
  const o = state.dash.overall;
  $("#side-overall").innerHTML =
    `<div><b style="color:var(--gold)">${o.pct}%</b> complete · ${o.tasks_done}/${o.tasks_total} tasks · week ${state.dash.current_week}</div>`;
}

function renderEmpty() {
  $("#views").innerHTML = `<div class="empty"><div class="big">◈</div>
    <p>No playbook runs yet.<br>Start the 30-day sprint to begin tracking.</p>
    <button class="btn" id="empty-start">Start a run</button></div>`;
  $("#empty-start").addEventListener("click", newRunSheet);
}

function renderToday() {
  const d = state.dash;
  const wk = d.weeks[d.current_week - 1];
  // Stalled tasks: incomplete, feed quiet ≥3 days, current/past weeks only.
  const stalled = [];
  for (const w of d.weeks) {
    if (w.week > d.current_week) continue;
    for (const [role, ts] of Object.entries(w.roles))
      for (const t of ts) if (t.stalled) stalled.push({ ...t, week: w.week, role });
  }
  stalled.sort((a, b) => (b.days_quiet || 0) - (a.days_quiet || 0));
  $("#view-today").innerHTML = `
    <h2>Today</h2>
    <p class="sub">Week ${wk.week} of ${d.weeks.length} · ${esc(wk.theme)} · ${wk.tasks_done}/${wk.tasks_total} tasks</p>
    <div class="bar" style="margin-bottom:16px"><i style="width:${wk.tasks_total ? Math.round(100 * wk.tasks_done / wk.tasks_total) : 0}%"></i></div>
    ${stalled.length ? `
    <h2 style="margin-top:4px">Needs attention</h2>
    <p class="sub">Stalled — no feed activity in 3+ days</p>
    ${foldCards(stalled.map((t) => taskCard(t, `W${t.week} · ${esc(t.role)}`)))}` : ""}
    ${roleBlocks(wk.roles, true)}
    <h2 style="margin-top:24px">KPI glance</h2>
    <p class="sub">Week ${d.current_week} targets vs actuals</p>
    ${d.kpis.map(kpiGlance).join("")}`;
}

function renderPlaybook() {
  const d = state.dash;
  const w = Math.min(state.playbookWeek || d.current_week, d.weeks.length);
  state.playbookWeek = w;
  const wk = d.weeks[w - 1];
  $("#view-playbook").innerHTML = `
    <h2>Playbook</h2>
    <p class="sub">${esc(d.run.playbook_name)}</p>
    <div class="pills">${d.weeks.map((x) =>
      `<button class="pill${x.week === w ? " active" : ""}" data-week="${x.week}">W${x.week}</button>`).join("")}</div>
    <div class="card"><h3>Week ${wk.week} — ${esc(wk.theme)}</h3>
      <div class="meta">${wk.from} → ${wk.to} · ${wk.tasks_done}/${wk.tasks_total} done</div></div>
    ${roleBlocks(wk.roles)}`;
  $$("#view-playbook [data-week]").forEach((b) =>
    b.addEventListener("click", () => { state.playbookWeek = Number(b.dataset.week); renderPlaybook(); }));
}

function srcBadge(s) { return `<span class="src-badge ${esc(s)}">${esc(s)}</span>`; }

function renderKpis() {
  const d = state.dash;
  $("#view-kpis").innerHTML = `
    <h2>KPIs</h2>
    <p class="sub">Targets vs actuals · overall ${d.overall.pct}% of tasks done</p>
    <div class="kpi-grid">${d.kpis.map((k) => `
      <div class="card">
        <div class="kpi-top"><span class="kpi-name">${esc(k.name)}</span><span class="kpi-unit">${esc(k.unit)}</span></div>
        <div class="kpi-total">${k.total_actual}<small> / ${k.total_target} total</small></div>
        <div class="bar"><i style="width:${k.pct}%"></i></div>
        ${k.targets.map((t, i) => `
          <div class="week-row"><span class="wk">W${i + 1}</span>
            <div class="bar" style="margin:0"><i style="width:${t > 0 ? Math.min(100, Math.round(100 * k.actuals[i] / t)) : (k.actuals[i] > 0 ? 100 : 0)}%"></i></div>
            <span class="nums"><b>${k.actuals[i]}</b> / ${t}</span>
          </div>`).join("")}
        <div style="margin:10px 0 4px">${k.recent.slice(0, 4).map((en) =>
          `<div style="font-size:13px;color:var(--muted);padding:3px 0">${srcBadge(en.source)} ${esc(en.date)} · <b style="color:var(--text)">${en.value}</b>${en.note ? " · " + esc(en.note) : ""}</div>`).join("") || `<div style="font-size:13px;color:var(--faint)">No entries yet</div>`}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn ghost small" data-log="${esc(k.id)}">Log value</button>
          <button class="btn ghost small" data-sync="${esc(k.id)}">Sync…</button>
        </div>
      </div>`).join("")}</div>
    <div class="card" style="margin-top:4px">
      <h3>Connectors</h3>
      <div class="meta" style="margin-bottom:8px">Sources that feed KPI actuals. A new connector is one file in <span class="mono">src/connectors/</span>.</div>
      ${state.connectors.map((c) => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
          <div style="flex:1"><b>${esc(c.name)}</b><div class="meta">${esc(c.description)}</div></div>
          <button class="btn ghost small" data-conn="${esc(c.id)}">${c.configured ? "Configure" : "Set up"}</button>
        </div>`).join("")}
    </div>`;
  $$("#view-kpis [data-log]").forEach((b) => b.addEventListener("click", () => logSheet(b.dataset.log)));
  $$("#view-kpis [data-sync]").forEach((b) => b.addEventListener("click", () => syncSheet(b.dataset.sync)));
  $$("#view-kpis [data-conn]").forEach((b) => b.addEventListener("click", () => connSheet(b.dataset.conn)));
}

function renderActivity() {
  const d = state.dash;
  const items = d.activity.map((a) => a.type === "task"
    ? `<div class="feed-item"><span class="feed-dot"></span><div class="feed-body">
         <b>${esc(a.role)}</b> completed “${esc(a.title)}”
         <div class="feed-when">Week ${a.week} · ${esc((a.at || "").slice(0, 16).replace("T", " "))}</div></div></div>`
    : `<div class="feed-item"><span class="feed-dot metric"></span><div class="feed-body">
         ${srcBadge(a.source)} <b>${esc(a.kpi)}</b>: ${a.value} ${esc(a.unit)}${a.note ? ` — ${esc(a.note)}` : ""}
         <div class="feed-when">${esc(a.date || a.at)}</div></div></div>`).join("");
  $("#view-activity").innerHTML = `<h2>Activity</h2><p class="sub">Completions and metric entries across all tasks</p>
    <div class="card" style="padding:8px 16px">${items || `<div class="empty" style="padding:24px">Nothing yet.</div>`}</div>`;
}

/* ---------- people (stakeholder rollup) ---------- */
async function renderPeople() {
  const el = $("#view-people");
  if (!state.people || state.peopleRun !== state.runId) {
    el.innerHTML = `<h2>People</h2><p class="sub">Loading…</p>`;
    try {
      const r = await api(`/api/stakeholders?run_id=${encodeURIComponent(state.runId)}`);
      state.people = r.stakeholders || [];
      state.peopleRun = state.runId;
    } catch (e) {
      el.innerHTML = `<h2>People</h2><p class="sub">Couldn’t load stakeholders.</p><p class="meta">${esc(e.message)}</p>`;
      return;
    }
  }
  const list = state.people;
  el.innerHTML = `<h2>People</h2>
    <p class="sub">Stakeholders across this run’s threads — tap to expand, hover an avatar to change its photo</p>
    <input type="file" id="avatar-file" accept="image/*" hidden>
    ${list.length ? `<div class="card" style="padding:8px 16px">` + list.map((s, i) => `
      <div class="person-row" data-person="${i}">
        <span class="avatar-edit" data-avatar-email="${esc(s.email)}" title="Change photo">${avatarHtml(s.name ? `${s.name} <${s.email}>` : s.email, 34)}<span class="avatar-pencil">✎</span></span>
        <div style="flex:1;min-width:0"><b>${esc(s.name)}</b>
          <div class="meta">${esc(s.email)}</div></div>
        <span class="meta">${s.threads.length} thread${s.threads.length === 1 ? "" : "s"} · ${s.tasks.length} task${s.tasks.length === 1 ? "" : "s"}</span>
        ${s.threads.some((t) => t.unseen > 0) ? `<span class="unread-dot" title="Unread replies"></span>` : ""}
      </div>
      <div class="person-detail" id="person-${i}" hidden>
        ${s.threads.map((t) => `
          <div class="thread-row" data-ev="${esc(t.task_id)}" style="cursor:pointer">
            <div class="thread-body"><b>${esc(t.subject)}</b>
              <div class="meta">${esc(t.task_title)} · ${esc(t.last_date || "")}${t.unseen > 0 ? ` · <b style="color:var(--gold)">${t.unseen} new</b>` : ""}</div></div>
          </div>`).join("") || `<div class="meta">No threads yet.</div>`}
        ${s.tasks.length ? `<div class="meta" style="margin-top:6px">Tasks: ${s.tasks.map((t) =>
          `<span class="taglike">${esc(t.title)} (W${t.week} · ${esc(t.role)})</span>`).join(" ")}</div>` : ""}
        <div style="margin-top:8px"><button class="btn ghost small" data-photo-remove="${esc(s.email)}" type="button">Remove photo</button></div>
      </div>`).join("") + `</div>`
      : `<div class="card"><div class="empty" style="padding:24px">No stakeholders yet — link or send an email thread from a task’s feed.</div></div>`}`;
  $$("#view-people [data-person]").forEach((r) => r.addEventListener("click", (e) => {
    if (e.target.closest("[data-ev]") || e.target.closest("[data-avatar-email]")) return;
    const d = $(`#person-${r.dataset.person}`);
    if (d) d.hidden = !d.hidden;
  }));
  $$("#view-people [data-avatar-email]").forEach((a) => a.addEventListener("click", (e) => {
    e.stopPropagation(); // don't toggle the person detail
    const inp = $("#avatar-file");
    if (inp) { inp.dataset.email = a.dataset.avatarEmail; inp.click(); }
  }));
  const fi = $("#avatar-file");
  if (fi) fi.onchange = () => {
    const f = fi.files && fi.files[0];
    const em = fi.dataset.email;
    fi.value = "";
    if (!f || !em) return;
    if (f.size > 2 * 1024 * 1024) { alert("That image is too large — 2 MB max."); return; }
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        await api("/api/contacts/photo", "POST", { email: em, data: rd.result });
        state.peopleRun = null; // refetch: the new photo isn't in any cache yet (404s are no-store)
        renderPeople();
      } catch (err) { alert(err.message); }
    };
    rd.onerror = () => alert("Couldn't read that file.");
    rd.readAsDataURL(f);
  };
  $$("#view-people [data-photo-remove]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await api(`/api/contacts/photo?email=${encodeURIComponent(b.dataset.photoRemove)}`, "DELETE");
      state.peopleRun = null;
      renderPeople();
    } catch (err) { alert(err.message); }
  }));
}

/* ---------- illiad (C-suite assistant) ---------- */
const ILLIAD_CHIPS = ["Brief me", "What's stalled?", "Sync feeds", "KPIs", "Any new replies?"];

/* *bold* → <b>, escaped first so Illiad's plain text can't inject HTML. */
function illiadMd(s) {
  return esc(s).replace(/\*([^*]+)\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}

function renderIlliad() {
  const el = $("#view-illiad");
  if (!state.illiad) state.illiad = { msgs: [], busy: false };
  const c = state.illiad;
  el.innerHTML = `<h2>Illiad</h2>
    <p class="sub">Your chief of staff — automates, analyzes, keeps the state of play positive</p>
    <div class="chat" id="il-chat">
      ${c.msgs.length ? "" : `<div class="chat-empty">Ask me anything about the run — try “Brief me”.</div>`}
      ${c.msgs.map((m) => `<div class="msg ${m.who}"><div class="bubble">${illiadMd(m.text)}</div></div>`).join("")}
    </div>
    <div class="chips">${ILLIAD_CHIPS.map((q) =>
      `<button class="chip" data-chip="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <div class="chat-input">
      <input id="il-in" placeholder="Ask Illiad…" autocomplete="off" enterkeyhint="send"${c.busy ? " disabled" : ""}>
      <button class="btn" id="il-send">Send</button>
    </div>`;
  const chat = $("#il-chat");
  chat.scrollTop = chat.scrollHeight;
  $$("#view-illiad [data-chip]").forEach((b) =>
    b.addEventListener("click", () => illiadAsk(b.dataset.chip)));
  const send = () => {
    const v = $("#il-in").value.trim();
    if (v && !c.busy) illiadAsk(v);
  };
  $("#il-send").addEventListener("click", send);
  $("#il-in").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
}

async function illiadAsk(text) {
  const c = state.illiad;
  c.msgs.push({ who: "user", text });
  c.busy = true;
  renderIlliad();
  try {
    const r = await api("/api/illiad/ask", "POST", { message: text, run_id: state.runId });
    c.msgs.push({ who: "illiad", text: r.reply });
  } catch (e) {
    c.msgs.push({ who: "illiad", text: `Sorry — ${e.message}` });
  }
  c.busy = false;
  renderIlliad();
  const inp = $("#il-in");
  if (inp) inp.focus();
}

// ---------- sheets ----------
async function newRunSheet() {
  const pbs = await api("/api/playbooks").catch(() => []);
  const today = new Date().toISOString().slice(0, 10);
  openSheet(`<h3>Start a run</h3>
    <div class="field"><label>Playbook</label><select id="f-pb">${pbs.map((p) =>
      `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></div>
    <div class="field"><label>Run name</label><input id="f-name" placeholder="Q4 sales sprint"></div>
    <div class="field"><label>Start date</label><input id="f-date" type="date" value="${today}"></div>
    <div class="sheet-actions"><button class="btn ghost" id="f-cancel">Cancel</button>
    <button class="btn" id="f-go">Start run</button></div>`);
  $("#f-cancel").onclick = closeSheet;
  $("#f-go").onclick = async () => {
    try {
      const r = await api("/api/runs", "POST", {
        playbook_id: $("#f-pb").value, name: $("#f-name").value || undefined, start_date: $("#f-date").value || undefined,
      });
      closeSheet(); await loadRuns(); state.runId = r.id;
      localStorage.setItem("cadence.runId", r.id); $("#run-select").value = r.id;
      await loadDash();
    } catch (e) { alert(e.message); }
  };
}

function logSheet(kpiId) {
  const k = state.dash.kpis.find((x) => x.id === kpiId);
  const today = new Date().toISOString().slice(0, 10);
  openSheet(`<h3>Log — ${esc(k.name)}</h3>
    <div class="field"><label>Date</label><input id="f-date" type="date" value="${today}"></div>
    <div class="field"><label>Value (${esc(k.unit)})</label><input id="f-value" type="number" step="any" inputmode="decimal" placeholder="0"></div>
    <div class="field"><label>Note (optional)</label><input id="f-note" placeholder="e.g. week-2 push"></div>
    <div class="sheet-actions"><button class="btn ghost" id="f-cancel">Cancel</button>
    <button class="btn" id="f-go">Save</button></div>`);
  $("#f-cancel").onclick = closeSheet;
  $("#f-go").onclick = async () => {
    try {
      await api(`/api/kpis/${kpiId}/entries`, "POST", {
        date: $("#f-date").value, value: Number($("#f-value").value), note: $("#f-note").value,
      });
      closeSheet(); await loadDash();
    } catch (e) { alert(e.message); }
  };
}

function syncSheet(kpiId) {
  const k = state.dash.kpis.find((x) => x.id === kpiId);
  const wk = state.dash.weeks[state.dash.current_week - 1];
  openSheet(`<h3>Sync — ${esc(k.name)}</h3>
    <div class="field"><label>Connector</label><select id="f-conn">${state.connectors.map((c) =>
      `<option value="${esc(c.id)}">${esc(c.name)}${c.configured ? "" : " (not configured)"}</option>`).join("")}</select></div>
    <div class="field"><label>From</label><input id="f-from" type="date" value="${wk.from}"></div>
    <div class="field"><label>To</label><input id="f-to" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
    <div class="sheet-actions"><button class="btn ghost" id="f-cancel">Cancel</button>
    <button class="btn" id="f-go">Run sync</button></div>
    <p class="meta" style="color:var(--muted);font-size:13px">Synced rows are stored as metric entries with the connector as their source.</p>`);
  $("#f-cancel").onclick = closeSheet;
  $("#f-go").onclick = async () => {
    const btn = $("#f-go"); btn.disabled = true; btn.textContent = "Syncing…";
    try {
      const r = await api(`/api/connectors/${$("#f-conn").value}/sync`, "POST", {
        kpi_id: kpiId, from: $("#f-from").value, to: $("#f-to").value,
      });
      closeSheet(); await loadDash();
      alert(`Synced ${r.inserted} entr${r.inserted === 1 ? "y" : "ies"}.`);
    } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = "Run sync"; }
  };
}

async function connSheet(id) {
  const c = await api(`/api/connectors/${id}`);
  const cfg = c.config || {};
  let extra = "";
  if (id === "email-imap") {
    extra = `
      <div class="field"><label>Host</label><input id="f-host" value="${esc(cfg.host || "")}" placeholder="mail.example.com" autocomplete="off"></div>
      <div class="field"><label>Port</label><input id="f-port" value="${esc(cfg.port || "993")}" inputmode="numeric" autocomplete="off"></div>
      <div class="field"><label>Username</label><input id="f-user" value="${esc(cfg.user || "")}" autocomplete="off"></div>
      <div class="field"><label>Password / app password</label><input id="f-pass" type="password" value="${esc(cfg.pass || "")}" autocomplete="off"></div>
      <div class="field"><label>Sent folder (blank = auto-detect)</label><input id="f-folder" value="${esc(cfg.folder || "")}" autocomplete="off"></div>
      <div class="field"><label>GNOME Online Accounts</label><div id="f-goa" class="meta" style="color:var(--muted);font-size:13px">Checking…</div></div>
      <div class="field"><label>Sending accounts</label>
        <div id="f-accounts" class="meta" style="color:var(--muted);font-size:13px">Loading…</div>
        <div id="f-acct-add" style="margin-top:8px" hidden>
          <input id="f-acct-email" placeholder="email@company.com" autocomplete="off" style="margin-bottom:8px">
          <input id="f-acct-label" placeholder="Label (optional)" autocomplete="off" style="margin-bottom:8px">
          <select id="f-acct-goa" style="margin-bottom:8px"></select>
          <div class="meta" style="color:var(--muted);font-size:12px;margin:6px 0">— or manual SMTP —</div>
          <input id="f-acct-host" placeholder="SMTP host" autocomplete="off" style="margin-bottom:8px">
          <input id="f-acct-user" placeholder="SMTP username" autocomplete="off" style="margin-bottom:8px">
          <input id="f-acct-pass" type="password" placeholder="SMTP password" autocomplete="off" style="margin-bottom:8px">
          <button class="btn ghost small" id="f-acct-save" type="button">Add account</button>
        </div>
        <button class="btn ghost small" id="f-acct-toggle" type="button" style="margin-top:8px">Add account</button>
        <p class="meta" style="color:var(--muted);font-size:12px;margin-top:6px">Online Accounts identities work with no setup — credentials come from the keyring per send. The default account is used when the composer doesn't pick one.</p>
      </div>
      <p class="meta" style="color:var(--muted);font-size:13px">Resolution order: connector config → <span class="mono">CADENCE_IMAP_HOST/PORT/USER/PASS</span> env → gitignored <span class="mono">data/imap.json</span> → GNOME Online Accounts. GOA credentials come from the keyring via goa-daemon and are never stored by Cadence; explicit host/user/pass above take precedence when set.</p>`;
  } else if (id === "webhook") {
    const keys = cfg.keys || {};
    const rows = Object.entries(keys).map(([k, v]) =>
      `<div style="padding:8px 0;border-bottom:1px solid var(--line)"><b>${esc(v.label || "key")}</b>
       <div class="mono">${location.origin}/api/hooks/${esc(k)}</div></div>`).join("");
    extra = `<div class="field"><label>New key label</label><input id="f-keylabel" placeholder="CRM nightly push"></div>
      <button class="btn ghost small" id="f-newkey" type="button">Generate key</button>
      <div id="f-keys" style="margin-top:8px">${rows || `<div class="meta">No keys yet.</div>`}</div>`;
  } else if (id === "calendar-ical") {
    extra = `
      <div class="field"><label>iCal feed URL</label>
        <input id="f-calurl" type="password" value="${esc(cfg.url || "")}" placeholder="https://…" autocomplete="off"></div>
      <div class="field"><label>SUMMARY filter (optional)</label>
        <input id="f-calquery" value="${esc(cfg.query || "")}" placeholder="e.g. discovery" autocomplete="off"></div>
      <p class="meta" style="color:var(--muted);font-size:13px">Resolution order: connector config → <span class="mono">CALENDAR_ICAL_URL</span> env → gitignored <span class="mono">data/calendar.json</span>. The secret lives in the URL and is never logged. RRULE recurrence is not expanded in v1 — recurring events count once at their base instance.</p>`;
  } else {
    extra = `<p class="meta" style="color:var(--muted)">No configuration needed.</p>`;
  }
  openSheet(`<h3>${esc(c.name)}</h3><p class="meta" style="color:var(--muted);font-size:13px">${esc(c.description)}</p>${extra}
    <div class="sheet-actions"><button class="btn ghost" id="f-cancel">Cancel</button>
    <button class="btn" id="f-go">Save</button></div>`);
  $("#f-cancel").onclick = closeSheet;
  if (id === "email-imap") {
    fillGoaBlock(cfg.goa_account || "");
    renderSendAccounts();
    fillAcctGoa();
    $("#f-acct-toggle").onclick = () => {
      const add = $("#f-acct-add");
      add.hidden = !add.hidden;
      $("#f-acct-toggle").hidden = !add.hidden;
    };
    $("#f-acct-save").onclick = async () => {
      const goaSel = $("#f-acct-goa");
      const goaOpt = goaSel && goaSel.value ? goaSel.selectedOptions[0] : null;
      const payload = goaOpt
        ? { email: goaOpt.dataset.email, goa_account: goaSel.value,
            label: $("#f-acct-label").value.trim() }
        : { email: $("#f-acct-email").value.trim(), label: $("#f-acct-label").value.trim(),
            smtp_host: $("#f-acct-host").value.trim(), smtp_user: $("#f-acct-user").value.trim(),
            smtp_pass: $("#f-acct-pass").value };
      try {
        await api("/api/email-accounts", "POST", { action: "add", account: payload });
        $("#f-acct-add").hidden = true;
        $("#f-acct-toggle").hidden = false;
        ["f-acct-email", "f-acct-label", "f-acct-host", "f-acct-user", "f-acct-pass"]
          .forEach((fid) => { $("#" + fid).value = ""; });
        renderSendAccounts();
      } catch (e) { alert(e.message); }
    };
  }
  const nk = $("#f-newkey");
  if (nk) nk.onclick = () => {
    const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) + (crypto.randomUUID ? "" : "-hook");
    const label = $("#f-keylabel").value || "webhook key";
    cfg.keys = cfg.keys || {};
    cfg.keys[key] = { label, created: new Date().toISOString().slice(0, 10) };
    connSheetSave(id, cfg);
  };
  $("#f-go").onclick = () => {
    if (id === "email-imap") {
      cfg.host = $("#f-host").value.trim(); cfg.port = $("#f-port").value.trim();
      cfg.user = $("#f-user").value.trim(); cfg.pass = $("#f-pass").value;
      cfg.folder = $("#f-folder").value.trim();
      const gs = $("#f-goa-account");
      cfg.goa_account = gs ? gs.value : (cfg.goa_account || "");
    } else if (id === "calendar-ical") {
      cfg.url = $("#f-calurl").value.trim();
      cfg.query = $("#f-calquery").value.trim();
    }
    connSheetSave(id, cfg);
  };
  async function fillGoaBlock(selected) {
    const el = $("#f-goa");
    if (!el) return;
    let g;
    try { g = await api("/api/connectors/email-imap/goa-accounts"); }
    catch { el.textContent = "Could not reach the GOA endpoint."; return; }
    if (!$("#f-goa")) return; // sheet closed while loading
    if (!g.available) {
      el.textContent = "GNOME Online Accounts not found on this machine — use host/user/pass above.";
      return;
    }
    if (!g.accounts.length) {
      el.textContent = "GOA is reachable but has no mail-enabled accounts.";
      return;
    }
    const opts = [`<option value="">First available account</option>`]
      .concat(g.accounts.map((a) =>
        `<option value="${esc(a.id)}"${a.id === selected || a.email === selected ? " selected" : ""}>${esc(a.email)} (${esc(a.provider)})</option>`))
      .join("");
    el.innerHTML = `<select id="f-goa-account">${opts}</select>
      <p class="meta" style="color:var(--muted);font-size:12px;margin-top:6px">Credentials come from GNOME Settings and are never stored.</p>`;
  }
  async function renderSendAccounts() {
    const box = $("#f-accounts");
    if (!box) return;
    let r;
    try { r = await api("/api/email-accounts"); }
    catch { box.textContent = "Couldn't load sending accounts."; return; }
    if (!$("#f-accounts")) return; // sheet closed while loading
    const acc = r.accounts || [];
    box.innerHTML = acc.length ? acc.map((a) => `
      <div class="acct-row">
        <div style="flex:1;min-width:0"><b>${esc(a.label || a.email)}</b>
          <div class="meta">${esc(a.email)} · ${a.kind === "goa" ? "Online Accounts" : "manual"}</div></div>
        ${a.id === r.default_account
          ? `<span class="state-chip acct-default">Default</span>`
          : `<button class="btn ghost small" data-acct-default="${esc(a.id)}" type="button">Set default</button>`}
        ${a.id.startsWith("cfg:") ? `<button class="btn ghost small" data-acct-remove="${esc(a.id)}" type="button">Remove</button>` : ""}
      </div>`).join("")
      : `<div class="meta">No sending accounts yet — add one below.</div>`;
    box.querySelectorAll("[data-acct-default]").forEach((b) => b.onclick = async () => {
      try {
        await api("/api/email-accounts", "POST", { action: "set-default", id: b.dataset.acctDefault });
        renderSendAccounts();
      } catch (e) { alert(e.message); }
    });
    box.querySelectorAll("[data-acct-remove]").forEach((b) => b.onclick = async () => {
      if (!confirm("Remove this sending account?")) return;
      try {
        await api("/api/email-accounts", "POST", { action: "remove", id: b.dataset.acctRemove });
        renderSendAccounts();
      } catch (e) { alert(e.message); }
    });
  }
  async function fillAcctGoa() {
    const sel = $("#f-acct-goa");
    if (!sel) return;
    let g;
    try { g = await api("/api/connectors/email-imap/goa-accounts"); }
    catch { sel.hidden = true; return; }
    if (!$("#f-acct-goa")) return;
    if (!g.available || !g.accounts.length) { sel.hidden = true; return; }
    sel.innerHTML = `<option value="">— pick an Online Accounts identity —</option>` +
      g.accounts.map((a) =>
        `<option value="${esc(a.id)}" data-email="${esc(a.email)}">${esc(a.email)} (${esc(a.provider)})</option>`).join("");
  }
  async function connSheetSave(cid, cfgObj) {
    try {
      await api(`/api/connectors/${cid}`, "POST", { config: cfgObj });
      state.connectors = await api("/api/connectors");
      closeSheet(); renderKpis();
    } catch (e) { alert(e.message); }
  }
}

/* ---------- task feed ---------- */
function findTask(taskId) {
  for (const w of state.dash.weeks)
    for (const ts of Object.values(w.roles)) {
      const t = ts.find((x) => x.id === taskId);
      if (t) return t;
    }
  return null;
}

function metaLine(l) {
  const m = l.meta || {};
  if (l.kind === "event" && m.starts_at) {
    return `event · ${m.starts_at.slice(0, 16).replace("T", " ")}`;
  }
  const bits = [l.kind];
  // Prefer the display name; the avatar tooltip carries the raw address.
  if (m.from) bits.push(addrParts(m.from).name || m.from);
  if (m.date) bits.push(m.date);
  if (m.count) bits.push(m.count + (m.count === 1 ? " message" : " messages"));
  if (m.unseen > 0) bits.push(`${m.unseen} new`);
  return bits.join(" · ");
}

function linkRow(l) {
  const av = (l.source === "email-imap" && (l.kind === "thread" || l.kind === "message"))
    ? threadAvatars(l) : "";
  return `<div class="link-row">
    ${av}${srcBadge(l.source)}
    <div class="link-body"><b>${esc(l.label)}</b><div class="meta">${esc(metaLine(l))}</div></div>
    <button class="btn ghost small" data-unlink="${esc(l.id)}">Remove</button>
  </div>`;
}

/* ---------- contact avatars ---------- */
const AV_COLORS = ["#c9a227", "#57b883", "#6aa8ff", "#9b7ede", "#4fb8a8", "#b08968"];
function avColor(email) {
  let h = 0;
  const s = String(email || "").toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function addrParts(s) {
  const m = String(s || "").match(/^(.*?)<([^<>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^["']|["']$/g, ""), email: m[2].trim() };
  return { name: "", email: String(s || "").trim() };
}
function avInitials(name, email) {
  if (name) {
    const w = name.split(/\s+/).filter(Boolean);
    if (w.length) return (w[0][0] + (w[1] ? w[1][0] : "")).toUpperCase();
  }
  const u = email.split("@")[0].replace(/[^a-z0-9]/gi, "");
  return (u.slice(0, 2) || "?").toUpperCase();
}
function avatarHtml(addr, size) {
  size = size || 30;
  const { name, email } = addrParts(addr);
  if (!email || !email.includes("@")) return "";
  const photo = `/api/contacts/photo?email=${encodeURIComponent(email.toLowerCase())}`;
  return `<span class="avatar" style="width:${size}px;height:${size}px;` +
    `font-size:${Math.round(size * 0.36)}px;background:${avColor(email)}" ` +
    `title="${esc(name || email)}">` +
    `<img src="${photo}" alt="" loading="lazy" onerror="this.remove()">` +
    `<span class="avatar-initials">${esc(avInitials(name, email))}</span></span>`;
}
/** Overlapping avatar stack for a thread link's participants (from/to). */
function threadAvatars(l) {
  const m = l.meta || {};
  const tos = Array.isArray(m.to) ? m.to : [];
  const seen = new Set(), uniq = [];
  for (const a of [m.from, m.last_from, ...tos]) {
    const { email } = addrParts(a);
    const k = email.toLowerCase();
    if (k.includes("@") && !seen.has(k)) { seen.add(k); uniq.push(a); }
    if (uniq.length >= 3) break;
  }
  if (!uniq.length) return "";
  const extra = new Set(
    [m.from, m.last_from, ...tos].map((a) => addrParts(a).email.toLowerCase())
      .filter((e) => e.includes("@"))).size - uniq.length;
  return `<span class="avatar-stack">${uniq.map((a) => avatarHtml(a)).join("")}` +
    `${extra > 0 ? `<span class="avatar avatar-more" title="${extra} more">+${extra}</span>` : ""}</span>`;
}

async function feedSheet(taskId) {
  const task = findTask(taskId);
  if (!task) return;
  const links = task.links || [];
  const hasThreads = links.some((l) => l.source === "email-imap" && l.kind === "thread");
  openSheet(`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <h3 style="margin:0">Feed</h3>
      <div style="display:flex;gap:8px">
        <button class="btn ghost small" id="f-toggle">${task.done ? "Reopen" : "Mark done"}</button>
        ${hasThreads ? `<button class="btn ghost small" id="f-sync">Sync</button>` : ""}
      </div>
    </div>
    <p class="meta" style="color:var(--muted);font-size:13px;margin:6px 0 12px">${esc(task.title)}</p>
    <div id="ev-list">${links.map(linkRow).join("") || `<div class="meta">Nothing in the feed yet.</div>`}</div>
    <button class="fold-toggle" id="f-addtoggle" data-foldtoggle="f-addbody" aria-expanded="false">
      <span>Add to feed</span><span class="fold-arrow">▸</span>
    </button>
    <div id="f-addbody" hidden>
      <div class="pills" id="ev-src">
        <button class="pill active" data-evsrc="email">Email</button>
        <button class="pill" data-evsrc="assign">Assign</button>
        <button class="pill" data-evsrc="meeting">Meeting</button>
        <button class="pill" data-evsrc="manual">Manual note</button>
        <button class="pill" data-evsrc="webhook">Webhook</button>
      </div>
      <div id="ev-form"></div>
    </div>
    <div class="sheet-actions"><button class="btn ghost" id="f-cancel">Done</button></div>`);
  $("#f-cancel").onclick = closeSheet;
  $("#f-toggle").onclick = async () => {
    try {
      await api(`/api/runs/${state.runId}/tasks/${taskId}/toggle`, "POST");
      await loadDash();
      feedSheet(taskId);
    } catch (e) { alert(e.message); }
  };
  let addInit = false;
  $("#f-addtoggle").addEventListener("click", () => {
    // capture phase runs before the global toggle handler opens the body
    if (!addInit && $("#f-addbody").hidden) { addInit = true; evForm(taskId, "email"); }
  }, true);
  const syncBtn = $("#f-sync");
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "Syncing…";
    try {
      const r = await api(`/api/runs/${state.runId}/tasks/${taskId}/sync-feed`, "POST");
      await loadDash();
      feedSheet(taskId);
      if (r.new_replies > 0) { /* the refreshed sheet shows them */ }
    } catch (e) {
      alert(e.message);
      syncBtn.disabled = false;
      syncBtn.textContent = "Sync";
    }
  };
  $$("#ev-src [data-evsrc]").forEach((b) => b.addEventListener("click", () => {
    $$("#ev-src .pill").forEach((x) => x.classList.toggle("active", x === b));
    evForm(taskId, b.dataset.evsrc);
  }));
  $$("#ev-list [data-unlink]").forEach((b) => b.addEventListener("click", () =>
    removeFromFeed(taskId, b.dataset.unlink)));
  // Opening the feed marks its threads read (clears unread dots on next render).
  api(`/api/runs/${state.runId}/tasks/${taskId}/feed/read`, "POST")
    .then(() => loadDash())
    .catch(() => { /* non-fatal */ });
}

async function removeFromFeed(taskId, linkId) {
  try {
    await api(`/api/links/${linkId}`, "DELETE");
    await loadDash();
    feedSheet(taskId);
  } catch (e) { alert(e.message); }
}

async function addToFeed(taskId, payload) {
  await api(`/api/runs/${state.runId}/tasks/${taskId}/links`, "POST", payload);
  await loadDash();
  feedSheet(taskId);
}

function evForm(taskId, src) {
  const f = $("#ev-form");
  if (src === "manual") {
    f.innerHTML = `<div class="field"><label>Note</label>
      <textarea id="f-note" rows="2" placeholder="e.g. Signed SOW received from Acme"></textarea></div>
      <button class="btn" id="f-link">Add note</button>`;
    $("#f-link").onclick = async () => {
      const label = $("#f-note").value.trim();
      if (!label) { alert("Note is required"); return; }
      try { await addToFeed(taskId, { source: "manual", kind: "note", label }); }
      catch (e) { alert(e.message); }
    };
  } else if (src === "webhook") {
    f.innerHTML = `<p class="meta">Generating keys…</p>`;
    api("/api/connectors/webhook").then((c) => {
      const keys = Object.entries((c.config && c.config.keys) || {});
      const hook = keys.length
        ? `${location.origin}/api/hooks/${keys[0][0]}`
        : `${location.origin}/api/hooks/:key`;
      f.innerHTML = `<p class="meta" style="color:var(--muted);font-size:13px">Any system can post to this task\u2019s feed:</p>
        <div class="mono" style="margin-bottom:8px">POST ${esc(hook)}</div>
        <div class="mono">{ "task_id": "${esc(taskId)}", "kind": "record",
  "ref": "ext-123", "label": "CRM opportunity closed" }</div>
        ${keys.length ? "" : `<p class="meta" style="color:var(--muted);font-size:13px;margin-top:8px">Generate a key under KPIs → Connectors → Inbound webhook.</p>`}`;
    }).catch((e) => { f.innerHTML = `<p class="meta">${esc(e.message)}</p>`; });
  } else if (src === "assign") {
    // Assign from feed — start an email thread with contact(s). The Send
    // button is the confirmation; nothing is sent until it is tapped.
    const task = findTask(taskId);
    f.innerHTML = `<p class="meta" style="color:var(--muted);font-size:13px">Assign from feed — start an email thread with contact(s). Sent from your mail account, then linked here.</p>
      <div class="field"><label>From</label><select id="f-from"></select></div>
      <div class="field"><label>To</label>
        <input id="f-to" list="f-contacts" placeholder="name@company.com, …" autocomplete="off">
        <datalist id="f-contacts"></datalist></div>
      <div class="field"><label>Subject</label>
        <input id="f-subject" value="${esc(task?.title || "")}"></div>
      <div class="field"><label>Message</label>
        <textarea id="f-body" rows="4" placeholder="Write the first message…"></textarea></div>
      <button class="btn" id="f-send">Send</button>`;
    api("/api/email-accounts").then((r) => {
      const sel = $("#f-from");
      if (!sel || !r.accounts) return;
      sel.innerHTML = r.accounts.map((a) =>
        `<option value="${esc(a.id)}"${a.id === r.default_account ? " selected" : ""}>${esc(a.label || a.email)}</option>`).join("");
    }).catch(() => { /* single-account setups still send via the default */ });
    api("/api/email-contacts").then((r) => {
      const dl = $("#f-contacts");
      if (dl && r.contacts) {
        dl.innerHTML = r.contacts.map((c) =>
          `<option value="${esc(c.email)}">${esc(c.name || c.email)}</option>`).join("");
      }
    }).catch(() => { /* datalist is a nicety, not a gate */ });
    $("#f-send").onclick = async () => {
      const to = $("#f-to").value.split(",").map((s) => s.trim()).filter(Boolean);
      const subject = $("#f-subject").value.trim();
      const body = $("#f-body").value.trim();
      if (!to.length) { alert("Add at least one recipient"); return; }
      if (!subject) { alert("Subject is required"); return; }
      if (!body) { alert("Write a message first"); return; }
      const btn = $("#f-send");
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        await api("/api/connectors/email-imap/send", "POST",
          { to, subject, body, task_id: taskId, run_id: state.runId,
            from_account: $("#f-from") ? $("#f-from").value : "" });
        await loadDash();
        feedSheet(taskId); // links are newest-first, so the thread lands on top
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
        btn.textContent = "Send";
      }
    };
  } else if (src === "meeting") {
    // Meeting — link a calendar event from the iCal feed into the feed.
    const iso = (d) => d.toISOString().slice(0, 10);
    const ago = new Date(Date.now() - 14 * 864e5), ahead = new Date(Date.now() + 14 * 864e5);
    f.innerHTML = `<p class="meta" style="color:var(--muted);font-size:13px">Link a calendar event as evidence. Configure the iCal feed under KPIs → Connectors → Calendar.</p>
      <div class="field"><label>From</label><input id="f-mfrom" type="date" value="${iso(ago)}"></div>
      <div class="field"><label>To</label><input id="f-mto" type="date" value="${iso(ahead)}"></div>
      <div class="field"><label>Search (optional)</label>
        <input id="f-mq" placeholder="e.g. discovery" autocomplete="off"></div>
      <button class="btn" id="f-msearch">Search</button>
      <div id="f-mresults" style="margin-top:12px"></div>`;
    const go = async () => {
      const box = $("#f-mresults");
      box.innerHTML = `<div class="meta">Searching…</div>`;
      try {
        const r = await api(`/api/connectors/calendar-ical/events?from=${$("#f-mfrom").value}&to=${$("#f-mto").value}&q=${encodeURIComponent($("#f-mq").value.trim())}`);
        if (!r.events.length) { box.innerHTML = `<div class="meta">No events found.</div>`; return; }
        box.innerHTML = r.events.map((e) => `
          <div class="thread-row">
            <div class="thread-body"><b>${esc(e.summary)}</b>
              <div class="meta">${esc(e.starts_at.slice(0, 16).replace("T", " "))}${e.recurring ? " · recurring" : ""}</div></div>
            <button class="btn ghost small" data-link-event='${esc(JSON.stringify(e))}'>Add</button>
          </div>`).join("");
        $$("#f-mresults [data-link-event]").forEach((b) => b.addEventListener("click", async () => {
          const ev = JSON.parse(b.dataset.linkEvent);
          try {
            await addToFeed(taskId, {
              source: "calendar-ical", kind: "event", ref: ev.uid || ev.summary, label: ev.summary,
              meta: { starts_at: ev.starts_at, ends_at: ev.ends_at },
            });
          } catch (e) { alert(e.message); }
        }));
      } catch (e) { box.innerHTML = `<div class="meta">${esc(e.message)}</div>`; }
    };
    $("#f-msearch").onclick = go;
    $("#f-mq").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  } else {
    f.innerHTML = `<div class="field"><label>Search email threads</label>
      <input id="f-q" placeholder="e.g. Delivery Kickoff" autocomplete="off"></div>
      <button class="btn" id="f-search">Search</button>
      <div id="f-results" style="margin-top:12px"></div>`;
    const go = async () => {
      const q = $("#f-q").value.trim();
      const box = $("#f-results");
      if (!q) return;
      box.innerHTML = `<div class="meta">Searching…</div>`;
      try {
        const r = await api(`/api/connectors/email-imap/threads?q=${encodeURIComponent(q)}`);
        if (!r.threads.length) { box.innerHTML = `<div class="meta">No threads found.</div>`; return; }
        box.innerHTML = r.threads.map((t) => `
          <div class="thread-row">
            <div class="thread-body"><b>${esc(t.subject)}</b>
              <div class="meta">${esc(t.from)}${t.to && t.to.length ? ` → ${esc(t.to[0])}${t.to.length > 1 ? ` +${t.to.length - 1}` : ""}` : ""} · ${esc(t.date)} · ${t.count} message${t.count === 1 ? "" : "s"}</div></div>
            <button class="btn ghost small" data-link-thread='${esc(JSON.stringify(t))}'>Add</button>
          </div>`).join("");
        $$("#f-results [data-link-thread]").forEach((b) => b.addEventListener("click", async () => {
          const th = JSON.parse(b.dataset.linkThread);
          try {
            await addToFeed(taskId, {
              source: "email-imap", kind: "thread", ref: th.thread_key, label: th.subject,
              meta: { from: th.from, to: th.to || [], date: th.date, count: th.count },
            });
          } catch (e) { alert(e.message); }
        }));
      } catch (e) { box.innerHTML = `<div class="meta">${esc(e.message)}</div>`; }
    };
    $("#f-search").onclick = go;
    $("#f-q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }
}
