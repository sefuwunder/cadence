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
function taskRow(t) {
  const n = (t.links || []).length;
  return `<div class="task${t.done ? " done" : ""}" data-task="${esc(t.id)}">
    <button class="check" data-toggle="${esc(t.id)}" aria-label="toggle task">${t.done ? "✓" : ""}</button>
    <span class="task-title">${esc(t.title)}</span>
    <button class="ev${n ? " has" : ""}" data-ev="${esc(t.id)}" aria-label="task feed" title="Feed">
      <span class="ev-ico">🔗</span>${n ? `<span class="ev-n">${n}</span>` : ""}
    </button>
  </div>`;
}
function roleBlocks(roles) {
  return Object.entries(roles).map(([role, tasks]) => {
    const done = tasks.filter((t) => t.done).length;
    return `<div class="role-block">
      <div class="role-head">${esc(role)} <span class="count">${done}/${tasks.length}</span></div>
      ${tasks.map(taskRow).join("")}
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
  ({ today: renderToday, playbook: renderPlaybook, kpis: renderKpis, activity: renderActivity })[state.tab]();
  // wire toggles (event delegation once)
}

document.addEventListener("click", async (e) => {
  const evb = e.target.closest("[data-ev]");
  if (evb) { feedSheet(evb.dataset.ev); return; }
  const t = e.target.closest("[data-toggle]");
  if (t) {
    t.disabled = true;
    try {
      await api(`/api/runs/${state.runId}/tasks/${t.dataset.toggle}/toggle`, "POST");
      await loadDash();
    } catch (err) { alert(err.message); t.disabled = false; }
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
  $("#view-today").innerHTML = `
    <h2>Today</h2>
    <p class="sub">Week ${wk.week} of ${d.weeks.length} · ${esc(wk.theme)} · ${wk.tasks_done}/${wk.tasks_total} tasks</p>
    <div class="bar" style="margin-bottom:16px"><i style="width:${wk.tasks_total ? Math.round(100 * wk.tasks_done / wk.tasks_total) : 0}%"></i></div>
    ${roleBlocks(wk.roles)}
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

/* ---------- sheets ---------- */
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
      <p class="meta" style="color:var(--muted);font-size:13px">Resolution order: connector config → <span class="mono">CADENCE_IMAP_HOST/PORT/USER/PASS</span> env → gitignored <span class="mono">data/imap.json</span> → GNOME Online Accounts. GOA credentials come from the keyring via goa-daemon and are never stored by Cadence; explicit host/user/pass above take precedence when set.</p>`;
  } else if (id === "webhook") {
    const keys = cfg.keys || {};
    const rows = Object.entries(keys).map(([k, v]) =>
      `<div style="padding:8px 0;border-bottom:1px solid var(--line)"><b>${esc(v.label || "key")}</b>
       <div class="mono">${location.origin}/api/hooks/${esc(k)}</div></div>`).join("");
    extra = `<div class="field"><label>New key label</label><input id="f-keylabel" placeholder="CRM nightly push"></div>
      <button class="btn ghost small" id="f-newkey" type="button">Generate key</button>
      <div id="f-keys" style="margin-top:8px">${rows || `<div class="meta">No keys yet.</div>`}</div>`;
  } else {
    extra = `<p class="meta" style="color:var(--muted)">No configuration needed.</p>`;
  }
  openSheet(`<h3>${esc(c.name)}</h3><p class="meta" style="color:var(--muted);font-size:13px">${esc(c.description)}</p>${extra}
    <div class="sheet-actions"><button class="btn ghost" id="f-cancel">Cancel</button>
    <button class="btn" id="f-go">Save</button></div>`);
  $("#f-cancel").onclick = closeSheet;
  if (id === "email-imap") fillGoaBlock(cfg.goa_account || "");
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
  const bits = [l.kind];
  if (m.from) bits.push(m.from);
  if (m.date) bits.push(m.date);
  if (m.count) bits.push(m.count + (m.count === 1 ? " message" : " messages"));
  return bits.join(" · ");
}

function linkRow(l) {
  return `<div class="link-row">
    ${srcBadge(l.source)}
    <div class="link-body"><b>${esc(l.label)}</b><div class="meta">${esc(metaLine(l))}</div></div>
    <button class="btn ghost small" data-unlink="${esc(l.id)}">Remove</button>
  </div>`;
}

async function feedSheet(taskId) {
  const task = findTask(taskId);
  if (!task) return;
  const links = task.links || [];
  openSheet(`
    <h3>Feed</h3>
    <p class="meta" style="color:var(--muted);font-size:13px;margin:-6px 0 12px">${esc(task.title)}</p>
    <div id="ev-list">${links.map(linkRow).join("") || `<div class="meta">Nothing in the feed yet.</div>`}</div>
    <h3 style="margin-top:20px">Add to feed</h3>
    <div class="pills" id="ev-src">
      <button class="pill active" data-evsrc="email">Email</button>
      <button class="pill" data-evsrc="manual">Manual note</button>
      <button class="pill" data-evsrc="webhook">Webhook</button>
    </div>
    <div id="ev-form"></div>
    <div class="sheet-actions"><button class="btn ghost" id="f-cancel">Done</button></div>`);
  $("#f-cancel").onclick = closeSheet;
  $$("#ev-src [data-evsrc]").forEach((b) => b.addEventListener("click", () => {
    $$("#ev-src .pill").forEach((x) => x.classList.toggle("active", x === b));
    evForm(taskId, b.dataset.evsrc);
  }));
  evForm(taskId, "email");
  $$("#ev-list [data-unlink]").forEach((b) => b.addEventListener("click", () =>
    removeFromFeed(taskId, b.dataset.unlink)));
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
              <div class="meta">${esc(t.from)} · ${esc(t.date)} · ${t.count} message${t.count === 1 ? "" : "s"}</div></div>
            <button class="btn ghost small" data-link-thread='${esc(JSON.stringify(t))}'>Add</button>
          </div>`).join("");
        $$("#f-results [data-link-thread]").forEach((b) => b.addEventListener("click", async () => {
          const th = JSON.parse(b.dataset.linkThread);
          try {
            await addToFeed(taskId, {
              source: "email-imap", kind: "thread", ref: th.thread_key, label: th.subject,
              meta: { from: th.from, date: th.date, count: th.count },
            });
          } catch (e) { alert(e.message); }
        }));
      } catch (e) { box.innerHTML = `<div class="meta">${esc(e.message)}</div>`; }
    };
    $("#f-search").onclick = go;
    $("#f-q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }
}
