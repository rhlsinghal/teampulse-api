const CU_BASE    = "https://api.clickup.com/api/v2";
const DT_DOMAINS = new Set(["decision-tree.com"]);
const CLOSED = new Set([
  "closed","completed","done",
  "complete","resolved","released","deployed","finished","accepted",
]);
function isClosed(status) {
  const s = (status||"").toLowerCase();
  return CLOSED.has(s) || s.startsWith("done") || s.startsWith("closed") || s.startsWith("complete");
}

const STATUS_CLASS = {
  "completed":"pill-green","closed":"pill-green",
  "in progress - dt":"pill-blue","in progress - nectar":"pill-blue","in progress":"pill-blue",
  "open":"pill-gray","immediate next":"pill-purple",
  "blocked - internal":"pill-red","blocked":"pill-red",
  "specs needed - nectar":"pill-amber","specs needed":"pill-amber",
  "under review - nectar":"pill-amber","under review - dt":"pill-amber",
  "deploying":"pill-teal","initial analysis":"pill-gray",
  "user error":"pill-gray","rejected":"pill-gray","lost":"pill-gray",
};

async function cuGet(token, path, params={}) {
  const url = new URL(`${CU_BASE}${path}`);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  const res = await fetch(url.toString(), { headers:{ Authorization:token, "Content-Type":"application/json" } });
  if (!res.ok) return {};
  return res.json();
}

async function getTasksFromList(token, listId, extra={}) {
  let tasks=[], page=0;
  while(true) {
    const data = await cuGet(token, `/list/${listId}/task`, { page, include_closed:"true", ...extra });
    const batch = data.tasks||[];
    tasks = tasks.concat(batch);
    if(batch.length < 100 || data.last_page) break;
    page++;
  }
  return tasks;
}

function isDtEmail(email) {
  return DT_DOMAINS.has((email||"").split("@")[1]?.toLowerCase()||"");
}

function isDtTask(task) {
  // Check assignees, members, watchers, and creator
  const people = [
    ...(task.assignees||[]),
    ...(task.members||[]),
    ...(task.watchers||[]),
  ];
  if (people.some(a => isDtEmail(a.email||a.user?.email||""))) return true;
  // Also check creator
  const creatorEmail = task.creator?.email||"";
  return isDtEmail(creatorEmail);
}

function normaliseTask(raw, label="") {
  const rawStatus = raw.status||"";
  const status = typeof rawStatus==="object" ? (rawStatus.status||"unknown") : (rawStatus||"unknown");
  return {
    id:           raw.id,
    customId:     raw.custom_id||raw.customId||raw.id||"—",
    name:         raw.name||"",
    status,
    url:          raw.url||`https://app.clickup.com/t/${raw.id}`,
    assignees:    (raw.assignees||[]).map(a=>({ username:a.username||"", email:a.email||"" })),
    watchers:     (raw.watchers||[]).map(a=>({ username:a.username||"", email:a.email||"" })),
    dueDate:      raw.due_date      ? parseInt(raw.due_date)      : null,
    dateUpdated:  raw.date_updated  ? parseInt(raw.date_updated)  : null,
    dateClosed:   raw.date_closed   ? parseInt(raw.date_closed)   : null,
    _location_ids:(raw.locations||[]).map(l=>l.id),
  };
}

function fmtAssignees(assignees, watchers) {
  // Use assignees if available, fall back to DT watchers
  const dtAssignees = (assignees||[]).filter(a => isDtEmail(a.email||""));
  const display = dtAssignees.length > 0 ? dtAssignees : (assignees||[]).slice(0,2);
  if (!display.length) {
    // No assignees — show DT watchers instead
    const dtWatchers = (watchers||[]).filter(a => isDtEmail(a.email||"")).slice(0,2);
    if (dtWatchers.length) {
      return dtWatchers.map(a => {
        const n = a.username||a.email||"";
        const p = n.split(" ");
        return (p.length>1 ? `${p[0]} ${p[p.length-1][0]}.` : n.split("@")[0]) + " (w)";
      }).join(", ");
    }
    return "—";
  }
  const names = display.slice(0,2).map(a => {
    const n = a.username||a.email||"Unknown";
    const p = n.split(" ");
    return p.length>1 ? `${p[0]} ${p[p.length-1][0]}.` : n.split("@")[0];
  });
  return names.join(", ")+(display.length>2?` +${display.length-2}`:"");
}

function fmtDate(ts, isDueDate) {
  if(!ts) return null;
  let ms = parseInt(ts);
  // ClickUp due_date is stored as 1ms before next sprint starts (end-of-day).
  // Subtracting 1 full day gives the correct sprint end date.
  if(isDueDate) ms -= 86400000;
  const d = new Date(ms);
  const day   = d.getUTCDate();
  const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  const year  = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function statusPill(status) {
  const cls = STATUS_CLASS[status.toLowerCase()]||"pill-gray";
  const label = status.replace(/ - nectar/gi,"").replace(/ - dt/gi,"");
  return `<span class="pill ${cls}">${label}</span>`;
}

function isDeployTask(name) {
  return /release|deployment/i.test(name||"");
}

// ── HTML builder ──────────────────────────────────────────────────────────────
function buildHtml(sprints, bugTasks, { month, yourName, managerName }) {
  const now        = new Date().toISOString().slice(0,16).replace("T"," ");
  const sprintNames = sprints.map(s=>s.label).join(", ");
  const totalOpen  = sprints.reduce((a,s)=>a+s.open_dt.length,0);

  const resolved   = bugTasks.filter(b=>["completed","closed","user error"].includes(b.status.toLowerCase()));
  const review     = bugTasks.filter(b=>b.status.toLowerCase().includes("review"));
  const activeBugs = bugTasks.filter(b=>!["completed","closed","user error"].includes(b.status.toLowerCase())&&!b.status.toLowerCase().includes("review"));
  const bugResPct  = bugTasks.length ? Math.round(resolved.length/bugTasks.length*100) : 0;

  // ── Sprint overview cards ──
  const overviewCards = sprints.map(s => {
    const allGood = s.open_dt.length === 0;
    const cls     = allGood ? "sprint-card completed" : "sprint-card attention";
    const desc    = allGood ? "All DT tasks closed." : `${s.open_dt.length} DT task(s) still open.`;
    const deployTask = s.dt_tasks.find(t => isDeployTask(t.name))
                    || s.next_sprint_deploy_task || null;
    const deployDeadline = s.startDate || null;
    const deployDone = deployTask
      ? (deployDeadline && deployTask.dateUpdated
          ? deployTask.dateUpdated <= deployDeadline
          : isClosed(deployTask.status))
      : null;
    const releasePill = deployDone === true
      ? `<span class="release-pill rp-yes">&#10003; Release on time</span>`
      : deployDone === false
      ? `<span class="release-pill rp-no">&#10007; Release delayed</span>`
      : `<span class="release-pill rp-gray">— No release task found</span>`;

    return `<div class="${cls}">
      <div class="sprint-type">Completed sprint</div>
      <div class="sprint-name">${s.label}</div>
      <div class="sprint-desc">Product Sprint ${s.num} — ${desc}</div>
      ${(s.startDate||s.dueDate)?`<div class="sprint-dates">${s.startDate?fmtDate(s.startDate,false):"?"} → ${s.dueDate?fmtDate(s.dueDate,true):"?"}</div>`:""}
      <div class="sprint-stats">
        <div class="sstat"><div class="sstat-val dk">${s.dt_tasks.length}</div><div class="sstat-label">Total DT</div></div>
        <div class="sprint-divider"></div>
        <div class="sstat"><div class="sstat-val green">${s.done_dt.length}</div><div class="sstat-label">Completed</div></div>
        <div class="sprint-divider"></div>
        <div class="sstat"><div class="sstat-val ${s.open_dt.length>0?"amber":"gray"}">${s.open_dt.length}</div><div class="sstat-label">Still open</div></div>
      </div>
      <div class="card-sep"></div>
      ${releasePill}
    </div>`;
  }).join("\n");

  // ── Per-sprint sections ──
  const sprintSections = sprints.map(s => {
    const total  = s.dt_tasks.length;
    const done   = s.done_dt.length;
    const open   = s.open_dt.length;
    const pct    = total ? Math.round(done/total*100) : 0;
    const icon   = open > 0 ? "si-amber" : "si-green";
    const iconCh = open > 0 ? "!" : "&#10003;";

    // Progress bars only shown when there are open tasks
    const progBars = open > 0 ? `
      <div class="prog-grid">
        <div><div class="prog-label">Completed</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-green" style="width:${pct}%"></div></div><div class="prog-val">${done} / ${total} (${pct}%)</div></div>
        <div><div class="prog-label">Still open</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-amber" style="width:${total?Math.round(open/total*100):0}%"></div></div><div class="prog-val">${open} tasks</div></div>
        <div><div class="prog-label">Blocked</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-indigo" style="width:${total?Math.round(s.blocked_dt.length/total*100):0}%"></div></div><div class="prog-val">${s.blocked_dt.length} tasks</div></div>
      </div>` : "";

    // Task rows — mark open tasks with STILL OPEN tag
    // display_dt_tasks = open tasks only (closed ones counted in stats but not shown)
    const displayTasks = s.display_dt_tasks || s.dt_tasks.filter(t => !isClosed(t.status));
    const taskRows = displayTasks.map(t => {
      const tag = s.open_dt.some(o=>o.id===t.id) ? '<span class="rollover-tag">STILL OPEN</span>' : "";
      return `<tr>
        <td><a class="task-id" href="${t.url}" target="_blank">${t.customId}</a></td>
        <td><a class="task-name-link" href="${t.url}" target="_blank">${t.name}</a>${tag}</td>
        <td>${statusPill(t.status)}</td>
        <td class="assignee-text">${fmtAssignees(t.assignees, t.watchers)}</td>
      </tr>`;
    }).join("\n");

    // Open task annotation block — only shown when open tasks exist
    const openBlock = open > 0 ? `
      <div class="ann-block open-block">
        <div class="ann-label open-label">
          <span class="ann-icon open-icon">!</span>
          Why are these tasks still open?
        </div>
        ${s.open_dt.map(t => `
          <div class="open-task-item">
            <div class="open-task-name">${t.customId} — ${t.name}</div>
            <textarea class="ann-ta open-ta" placeholder="Why is this task still open? Add context for your manager..."></textarea>
          </div>`).join("")}
      </div>` : "";

    // Release deployment flag
    // Deadline = sprint's own startDate (Monday the new sprint begins)
    // Completion signal = date_updated (date_closed is always null in ClickUp)
    const deployTask = s.dt_tasks.find(t => isDeployTask(t.name))
                    || s.next_sprint_deploy_task || null;
    const deployBlock = deployTask ? (() => {
      const deadline   = s.startDate || null;
      const completed  = deployTask.dateUpdated || null;
      let onTime;
      if (deadline && completed) {
        onTime = completed <= deadline;
      } else {
        onTime = isClosed(deployTask.status);
      }

      const deadlineFmt  = deadline  ? fmtDate(deadline, false)  : "—";
      const completedFmt = completed ? fmtDate(completed, false) : "—";

      const flagClass = onTime ? "deploy-flag deploy-yes" : "deploy-flag deploy-no";
      const badge     = onTime
        ? `<span class="deploy-badge-yes">&#10003; On time</span>`
        : `<span class="deploy-badge-no">&#10007; Delayed</span>`;
      const delayInput = !onTime ? `
        <div class="delay-reason">
          <div class="delay-reason-label">Reason for delay</div>
          <textarea class="ann-ta delay-ta" placeholder="Briefly explain why the release was delayed..."></textarea>
        </div>` : "";
      return `
      <div class="${flagClass}">
        <div class="deploy-left">
          <div class="deploy-title">Release deployment completed on time?</div>
          <div class="deploy-sub">${deployTask.name} (${deployTask.customId})</div>
          <div class="deploy-dates">Deadline: ${deadlineFmt} &nbsp;·&nbsp; Completed: ${completedFmt}</div>
          ${delayInput}
        </div>
        ${badge}
      </div>`;
    })() : "";

    // Optional sprint notes
    const notesBlock = `
      <div class="ann-block notes-block">
        <div class="ann-label notes-label">
          <span class="ann-icon notes-icon">&#9998;</span>
          Sprint notes for ${s.label} (optional)
        </div>
        <textarea class="ann-ta" placeholder="Add any context or notes about this sprint for your manager..."></textarea>
      </div>`;

    const badgeColor = open > 0 ? "amber" : "green";
    const badgeText  = open > 0 ? `${done} / ${total} completed` : `${done} / ${total} completed`;
    const openBadge  = open > 0 ? `<span class="section-badge amber">${open} still open</span>` : "";

    return `
    <div class="section">
      <div class="section-head">
        <div class="section-icon ${icon}">${iconCh}</div>
        <span class="section-title">${s.label} — completed sprint (DT tasks)</span>
        <span class="section-badge ${badgeColor}">${badgeText}</span>
        ${openBadge}
      </div>
      ${progBars}
      <table><thead><tr><th>ID</th><th>Task</th><th>Status</th><th>DT Assignee</th></tr></thead>
      <tbody>${taskRows}</tbody></table>
      ${openBlock}
      ${deployBlock}
      ${notesBlock}
    </div>`;
  }).join("\n");

  // ── Bug section ──
  const bugBlocks = bugTasks.map(b => {
    const name = b.name.replace(/BUG:\s*/i,"");
    return `
      <div class="bug-block">
        <div class="bug-top">
          <a class="task-id" href="${b.url}" target="_blank">${b.customId}</a>
          <a class="task-name-link" href="${b.url}" target="_blank">${name}</a>
          ${statusPill(b.status)}
          <span class="assignee-text">${fmtAssignees(b.assignees, b.watchers)}</span>
        </div>
        <div class="ann-block bug-ann-block">
          <div class="ann-label bug-ann-label">
            <span class="ann-icon bug-ann-icon">&#9998;</span>
            Root cause note
          </div>
          <textarea class="ann-ta" placeholder="Why was this bug raised? e.g. regression, missing validation, edge case..."></textarea>
        </div>
      </div>`;
  }).join("\n");

  // ── Overall summary ──
  const completionSummary = sprints.map(s => {
    const pct = s.dt_tasks.length ? Math.round(s.done_dt.length/s.dt_tasks.length*100) : 0;
    return `${s.label}: <strong>${pct}%</strong> complete`;
  }).join(" · ");

  // ── CSS ──
  const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f1f5f9;color:#1e293b;padding:32px 16px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrapper{max-width:860px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0}
.header{background:#1e1b4b;padding:40px 44px 32px;color:#fff}
.header-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.logo-mark{font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#a5b4fc;font-family:'DM Mono',monospace}
.date-badge{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.2);border-radius:20px;padding:4px 14px;font-size:11px;font-family:'DM Mono',monospace;color:#c7d2fe;letter-spacing:1px}
h1{font-size:26px;font-weight:700;margin-bottom:8px}
h1 span{color:#a5b4fc}
.header-sub{color:#c7d2fe;font-size:13px;line-height:1.6;margin-bottom:20px}
.header-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.meta-item{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:6px 12px}
.meta-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.meta-dot.blue{background:#60a5fa}.meta-dot.amber{background:#fbbf24}.meta-dot.red{background:#f87171}
.meta-label{font-size:11px;color:#c7d2fe;font-family:'DM Mono',monospace}
.meta-val{font-size:11px;font-weight:600;color:#fff}
.body{padding:32px 44px}
.greeting{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;font-size:13px;line-height:1.8;color:#475569;margin-bottom:24px}
.greeting strong{color:#1e293b}
.sprint-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:24px}
.sprint-card{border-radius:12px;padding:18px;border:1px solid}
.sprint-card.completed{background:#f0fdf4;border-color:#86efac}
.sprint-card.attention{background:#fffbeb;border-color:#fcd34d}
.sprint-type{font-size:9px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:4px}
.sprint-name{font-size:22px;font-weight:700;color:#1e293b;margin-bottom:2px}
.sprint-desc{font-size:11px;color:#64748b;margin-bottom:12px}
.sprint-stats{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.sstat{text-align:center}
.sstat-val{font-size:18px;font-weight:700}
.sstat-val.green{color:#16a34a}.sstat-val.amber{color:#d97706}.sstat-val.gray{color:#94a3b8}.sstat-val.dk{color:#475569}
.sstat-label{font-size:9px;color:#94a3b8;font-family:'DM Mono',monospace;text-transform:uppercase}.sprint-dates{font-size:10px;color:#64748b;font-family:'DM Mono',monospace;margin-top:6px;margin-bottom:8px}
.sprint-divider{width:1px;height:28px;background:#e2e8f0;margin:0 4px}
.card-sep{height:0.5px;background:#e2e8f0;margin-bottom:10px}
.release-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:500;font-family:'DM Mono',monospace}
.rp-yes{background:#dcfce7;color:#166534}
.rp-no{background:#fef3c7;color:#92400e}
.rp-gray{background:#f1f5f9;color:#94a3b8}
.section{margin-bottom:28px}
.section-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.section-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.si-amber{background:#fef3c7}.si-red{background:#fee2e2}.si-green{background:#dcfce7}
.section-title{font-size:14px;font-weight:600;color:#1e293b;flex:1}
.section-badge{font-size:10px;font-family:'DM Mono',monospace;padding:3px 10px;border-radius:20px;font-weight:500}
.section-badge.amber{background:#fef3c7;color:#92400e}
.section-badge.red{background:#fee2e2;color:#991b1b}
.section-badge.green{background:#dcfce7;color:#166534}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:0;font-size:12px}
thead tr{background:#f8fafc}
th{text-align:left;padding:10px 12px;font-size:9px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;font-weight:500;border-bottom:1px solid #e2e8f0}
td{padding:9px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8fafc}
.task-id{font-family:'DM Mono',monospace;font-size:11px;color:#4f46e5;text-decoration:none;font-weight:500}
.task-name-link{color:#1e293b;text-decoration:none;font-size:12px}
.assignee-text{font-size:11px;color:#64748b;font-family:'DM Mono',monospace}
.pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:500;font-family:'DM Mono',monospace}
.pill-green{background:#dcfce7;color:#166634}.pill-blue{background:#dbeafe;color:#1d4ed8}.pill-gray{background:#f1f5f9;color:#64748b}.pill-purple{background:#ede9fe;color:#6d28d9}.pill-red{background:#fee2e2;color:#991b1b}.pill-amber{background:#fef3c7;color:#92400e}.pill-teal{background:#ccfbf1;color:#115e59}
.rollover-tag{display:inline-block;margin-left:6px;padding:1px 7px;background:#fef3c7;color:#92400e;border-radius:4px;font-size:9px;font-family:'DM Mono',monospace;font-weight:600;letter-spacing:.5px}
.prog-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:10px}
.prog-label{font-size:9px;font-family:'DM Mono',monospace;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px}
.prog-bar-bg{background:#e2e8f0;border-radius:3px;height:3px;margin:6px 0 4px;overflow:hidden}
.prog-bar-fill{height:100%;border-radius:3px}
.fill-green{background:#10b981}.fill-amber{background:#f59e0b}.fill-indigo{background:#6366f1}
.prog-val{font-size:10px;font-family:'DM Mono',monospace;color:#475569}
.ann-block{margin-top:10px;border-radius:8px;padding:12px 14px;border:1px dashed}.ann-frozen{font-size:12px;color:#4c1d95;line-height:1.6;font-style:italic;background:#ede9fe;padding:8px 10px;border-radius:6px;border:1px solid #c4b5fd}
.ann-label{font-size:9px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:.8px;font-weight:500;display:flex;align-items:center;gap:5px;margin-bottom:7px}
.ann-icon{width:14px;height:14px;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:8px;color:#fff;flex-shrink:0}
.ann-ta{width:100%;padding:8px 10px;border-radius:6px;font-size:12px;color:#1e293b;font-family:'Inter',sans-serif;outline:none;resize:vertical;min-height:52px;line-height:1.5;border:1px solid}
.open-block{background:#fffbeb;border-color:#fcd34d}
.open-label{color:#92400e}
.open-icon{background:#d97706}
.open-task-item{margin-bottom:10px}
.open-task-item:last-child{margin-bottom:0}
.open-task-name{font-size:11px;font-weight:500;color:#374151;margin-bottom:4px}
.open-ta{background:#fff;border-color:#fde68a}
.open-ta:focus{border-color:#f59e0b;outline:none}
.deploy-flag{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:8px;border:1px solid;margin-top:10px}
.deploy-yes{background:#f0fdf4;border-color:#86efac}
.deploy-no{background:#fffbeb;border-color:#fcd34d}
.deploy-left{flex:1}
.deploy-title{font-size:11px;font-weight:600;color:#374151;margin-bottom:2px}
.deploy-sub{font-size:11px;color:#6b7280;font-family:'DM Mono',monospace}
.deploy-badge-yes{background:#dcfce7;color:#166534;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:500;font-family:'DM Mono',monospace;white-space:nowrap;flex-shrink:0}
.deploy-badge-no{background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:500;font-family:'DM Mono',monospace;white-space:nowrap;flex-shrink:0}
.deploy-dates{font-size:10px;color:#6b7280;font-family:'DM Mono',monospace;margin-top:3px}.delay-reason{margin-top:10px;padding-top:10px;border-top:1px dashed #fde68a}
.delay-reason-label{font-size:9px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:.8px;color:#92400e;margin-bottom:5px;font-weight:500}
.delay-ta{background:#fff;border-color:#fde68a}
.delay-ta:focus{border-color:#f59e0b;outline:none}
.notes-block{background:#f5f3ff;border-color:#c4b5fd}
.notes-label{color:#7c3aed}
.notes-icon{background:#7c3aed}
.ann-ta:focus{outline:none}
.bug-outer{border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:0}
.bug-block{padding:12px 14px;border-bottom:1px solid #f1f5f9}
.bug-block:last-child{border-bottom:none}
.bug-top{display:grid;grid-template-columns:90px 1fr 120px 110px;gap:10px;align-items:center}
.bug-ann-block{background:#f5f3ff;border-color:#c4b5fd}
.bug-ann-label{color:#7c3aed}
.bug-ann-icon{background:#7c3aed}
.overall-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.overall-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px}
.oc-title{font-size:9px;font-family:'DM Mono',monospace;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.oc-body{font-size:12px;color:#64748b;line-height:1.7}
.oc-body strong{color:#1e293b;font-weight:500}
.callout{display:flex;gap:12px;padding:14px 16px;border-radius:10px;border:1px solid}
.callout-green{background:#f0fdf4;border-color:#86efac}
.callout-icon{font-size:14px;flex-shrink:0;margin-top:1px}
.callout-body strong{display:block;font-weight:600;margin-bottom:2px;font-size:13px}
.callout-body span{color:#64748b;font-size:12px}
.divider{height:1px;background:#e2e8f0;margin:28px 0 0}
.footer{background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:20px 44px;display:flex;align-items:center;justify-content:space-between}
.footer-left{font-size:10px;color:#94a3b8;line-height:1.7;font-family:'DM Mono',monospace}
.footer-left strong{color:#4f46e5}
.footer-sign{font-size:12px;color:#64748b}
.footer-sign strong{color:#1e293b;font-weight:500}
@media print{body{padding:0;background:#fff}.wrapper{border-radius:0;border:none}.ann-block,.deploy-flag,.bug-ann-block{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iDerive Monthly Update — ${month}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head>
<body><div class="wrapper">

<div class="header">
  <div class="header-top">
    <div class="logo-mark">iDerive</div>
    <div style="display:flex;align-items:center;gap:8px">

      <div class="date-badge">${month.toUpperCase()}</div>
    </div>
  </div>
  <h1>Monthly Progress <span>Update</span></h1>
  <p class="header-sub">Sprint overview · Deployments · Bug tracking · Overall progress · Source: ClickUp<br>
  <span style="color:#94a3b8;font-size:12px;font-family:'DM Mono',monospace">Filtered: decision-tree.com assignees only · Completed sprints only</span></p>
  <div class="header-meta">
    <div class="meta-item"><div class="meta-dot blue"></div><span class="meta-label">Completed sprints</span><span class="meta-val">${sprintNames}</span></div>
    <div class="meta-item"><div class="meta-dot amber"></div><span class="meta-label">DT carry-overs</span><span class="meta-val">${totalOpen} open</span></div>
    <div class="meta-item"><div class="meta-dot red"></div><span class="meta-label">DT bugs</span><span class="meta-val">${bugTasks.length} this month</span></div>
  </div>
</div>

<div class="body">
  <div class="greeting">Hi <strong>${managerName}</strong>,<br>
  Below is the iDerive monthly progress update for <strong>${month}</strong>. This report covers <strong>${sprints.length} completed sprint(s)</strong> (${sprintNames}). Tasks and bugs are <strong>filtered to Decision Tree team members only</strong>.</div>

  <div class="sprint-overview">${overviewCards}</div>

  ${sprintSections}

  <div class="section">
    <div class="section-head">
      <div class="section-icon si-red">&#128027;</div>
      <span class="section-title">Bug tracking — ${month} (DT assignees only)</span>
      <span class="section-badge amber">${bugTasks.length} DT bugs</span>
    </div>
    <div class="bug-outer">${bugBlocks}</div>
    <div class="prog-grid" style="margin-top:10px">
      <div><div class="prog-label">Resolved</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-green" style="width:${bugResPct}%"></div></div><div class="prog-val">${resolved.length} bugs (${bugResPct}%)</div></div>
      <div><div class="prog-label">Under review</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-amber" style="width:${bugTasks.length?Math.round(review.length/bugTasks.length*100):0}%"></div></div><div class="prog-val">${review.length} bugs</div></div>
      <div><div class="prog-label">Active</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-indigo" style="width:${bugTasks.length?Math.round(activeBugs.length/bugTasks.length*100):0}%"></div></div><div class="prog-val">${activeBugs.length} bugs</div></div>
    </div>
  </div>

  <div class="divider"></div>

  <div class="section" style="margin-top:20px">
    <div class="section-head"><div class="section-icon si-green">&#128200;</div><span class="section-title">Overall progress &amp; highlights</span></div>
    <div class="overall-grid">
      <div class="overall-card"><div class="oc-title">&#128640; Deployment</div><div class="oc-body">Completed sprints: ${sprintNames}. See release flags above for deployment status per sprint.</div></div>
      <div class="overall-card"><div class="oc-title">&#128027; Bug rate</div><div class="oc-body"><strong>${bugResPct}%</strong> of DT bugs resolved this month. <strong>${review.length}</strong> under active review.</div></div>
      <div class="overall-card"><div class="oc-title">&#8629; Carry-overs</div><div class="oc-body"><strong>${totalOpen}</strong> DT task(s) from completed sprints remain open.</div></div>
      <div class="overall-card"><div class="oc-title">&#128203; Sprint summary</div><div class="oc-body">${completionSummary}.</div></div>
    </div>
    <div class="callout callout-green" style="margin-top:12px">
      <div class="callout-icon">&#128172;</div>
      <div class="callout-body"><strong>Next steps</strong><span>Happy to walk through any of the above in our next sync. Let me know if you would like deeper detail on any sprint, bug, or client status.</span></div>
    </div>
  </div>
</div>

<div class="footer">
  <div class="footer-left"><strong>iDerive</strong> · Monthly Report · ${month} · DT team view<br>Sprints: ${sprintNames} · Generated: ${now} · Source: ClickUp</div>
  <div class="footer-sign">Best regards,<br><strong>${yourName}</strong></div>
</div>

</div>
<script>
(function(){
  // Respond to parent page requesting annotated HTML
  window.addEventListener("message", function(e){
    if(!e.data || e.data.type !== "teampulse-get-html") return;
    // Assign IDs to all textareas
    var areas = document.querySelectorAll("textarea.ann-ta");
    areas.forEach(function(ta, i){ ta.id = ta.id || ("ann-ta-" + i); });
    // Clone the full document
    var clone = document.documentElement.cloneNode(true);
    // In the clone, set each textarea's textContent to current value
    var cloneAreas = clone.querySelectorAll("textarea.ann-ta");
    areas.forEach(function(ta, i){
      if(cloneAreas[i]){
        cloneAreas[i].textContent = ta.value;
        cloneAreas[i].removeAttribute("data-frozen");
      }
    });
    var serialized = "<!DOCTYPE html>" + clone.outerHTML;
    e.source.postMessage({ type: "teampulse-html", html: serialized }, "*");
  });

  // Convert textareas to styled divs so they appear in print/PDF
  function freezeAll(){
    document.querySelectorAll("textarea.ann-ta").forEach(function(ta){
      if(ta.dataset.frozen) return;
      ta.dataset.frozen = "1";
      var val = ta.value.trim();
      var div = document.createElement("div");
      div.className = "ann-frozen";
      div.textContent = val || "(no note added)";
      div.style.color = val ? "" : "#9ca3af";
      div.style.fontStyle = val ? "italic" : "normal";
      ta.parentNode.insertBefore(div, ta.nextSibling);
      ta.style.display = "none";
    });
  }

  // Freeze before printing (covers browser Print and Ctrl+P)
  window.addEventListener("beforeprint", freezeAll);

  // Save with annotations — attach directly (DOMContentLoaded may have already fired)
  function attachSaveBtn() {
    var btn = document.getElementById("save-annotated");
    if(!btn) return;
    btn.addEventListener("click", function(){
      btn.textContent = "Saving...";
      // Assign IDs to all textareas
      document.querySelectorAll("textarea.ann-ta").forEach(function(ta, i){
        ta.id = ta.id || ("ann-ta-" + i);
      });
      // Clone DOM and bake in textarea values
      var clone = document.documentElement.cloneNode(true);
      var origAreas  = document.querySelectorAll("textarea.ann-ta");
      var cloneAreas = clone.querySelectorAll("textarea.ann-ta");
      origAreas.forEach(function(ta, i){
        if(cloneAreas[i]) cloneAreas[i].textContent = ta.value;
      });
      // Remove the save button from downloaded file (not needed there)
      var cloneBtn = clone.querySelector("#save-annotated");
      if(cloneBtn) cloneBtn.style.display = "none";
      var blob = new Blob(["<!DOCTYPE html>" + clone.outerHTML],{type:"text/html"});
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement("a");
      a.href   = url;
      a.download = document.title.replace(/[^a-z0-9]/gi,"_") + "_annotated.html";
      a.click();
      setTimeout(function(){
        URL.revokeObjectURL(url);
        btn.textContent = "Saved!";
        setTimeout(function(){ btn.textContent = "Save with annotations"; }, 2000);
      }, 500);
    });
  }
  // Try immediately, then also on DOMContentLoaded as fallback
  attachSaveBtn();
  document.addEventListener("DOMContentLoaded", attachSaveBtn);
})();
</script>
</div></body></html>`;
}

export default async function handler(req, res) {
  const allowedOrigins = ["https://rhlsinghal.github.io","http://localhost:3000"];
  const origin = req.headers.origin||"";
  if(allowedOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS"){ res.status(200).end(); return; }
  if(req.method!=="POST")   { res.status(405).json({error:"Method not allowed"}); return; }

  const token        = process.env.CLICKUP_API_TOKEN;
  const sprintFolder = process.env.SPRINT_FOLDER_ID  || "90091150377";
  const bugListId    = process.env.BUG_LIST_ID        || "900902273006";
  const crossListIds = (process.env.CROSS_LIST_IDS||"901601528769,900902273006").split(",").map(s=>s.trim()).filter(Boolean);
  const yourName     = process.env.YOUR_NAME          || "Rahul Singhal";
  const managerName  = process.env.MANAGER_NAME       || "Abhishek";

  if(!token){ res.status(500).json({error:"CLICKUP_API_TOKEN not configured"}); return; }

  try {
    const now   = new Date();
    const month = now.toLocaleDateString("en-US",{month:"long",year:"numeric"});

    // ── Discover sprint lists with their start/end dates ──────────────────
    const listsData = await cuGet(token,`/folder/${sprintFolder}/list`,{archived:"false"});
    const allLists  = listsData.lists||[];

    const sprintListMap   = {};  // num → { id, startDate, dueDate }
    for(const lst of allLists){
      const m = lst.name?.match(/product sprint\s+(\d+)/i);
      if(m){
        sprintListMap[parseInt(m[1])] = {
          id:        lst.id,
          startDate: lst.start_date ? parseInt(lst.start_date) : null,
          dueDate:   lst.due_date   ? parseInt(lst.due_date)   : null,
        };
      }
    }
    if(!Object.keys(sprintListMap).length){ res.status(200).json({error:"No sprint lists found"}); return; }

    // ── Determine which sprints to fetch ──────────────────────────────────
    const requestedNums = (req.body?.sprintNums||[]).map(Number).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
    const dateFrom      = req.body?.dateFrom ? parseInt(req.body.dateFrom) : null;
    const dateTo        = req.body?.dateTo   ? parseInt(req.body.dateTo)   : null;

    let sprintWindow = [];

    if(requestedNums.length > 0){
      // Manual sprint numbers — validate each exists
      for(const n of requestedNums){
        if(sprintListMap[n]) sprintWindow.push(n);
      }
      if(!sprintWindow.length){ res.status(200).json({error:`None of the requested sprints (${requestedNums.map(n=>`PS${n}`).join(", ")}) were found in ClickUp`}); return; }

    } else if(dateFrom && dateTo){
      // Date range — include sprints whose dueDate falls within the range
      // Fall back to task-based detection if no dates on the list
      for(const [numStr, info] of Object.entries(sprintListMap)){
        const num = parseInt(numStr);
        if(info.dueDate){
          // Sprint end date falls within selected range → include
          if(info.dueDate >= dateFrom && info.dueDate <= dateTo) sprintWindow.push(num);
        } else {
          // No list dates — fall back: check if tasks were updated in range
          const raw = await getTasksFromList(token, info.id, {date_updated_gt:String(dateFrom)});
          const hasActivity = raw.some(t=>parseInt(t.date_updated||"0")<=dateTo);
          if(hasActivity) sprintWindow.push(num);
        }
      }
      sprintWindow.sort((a,b)=>a-b);
      if(!sprintWindow.length){ res.status(200).json({error:"No completed sprints found in the selected date range"}); return; }

    } else {
      res.status(400).json({error:"Please provide either sprint numbers or a date range"}); return;
    }

    // ── Cross-list tasks ───────────────────────────────────────────────────
    const rangeStart = dateFrom || Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const crossRaw   = [];
    for(const lid of crossListIds){
      const batch = await getTasksFromList(token,lid,{date_updated_gt:String(rangeStart)});
      for(const t of batch) if(isDtTask(t)) crossRaw.push(t);
    }

    // ── Build sprint data — completed sprints only ─────────────────────────
    const sprints = [];
    for(const n of sprintWindow){
      const info = sprintListMap[n];
      if(!info) continue;
      const label      = `PS${n}`;
      const rawTasks   = [...await getTasksFromList(token,info.id)];
      const seenIds    = new Set(rawTasks.map(t=>t.id));
      for(const t of crossRaw){
        const locIds = (t.locations||[]).map(l=>l.id);
        if(locIds.includes(info.id)&&!seenIds.has(t.id)){ rawTasks.push(t); seenIds.add(t.id); }
      }
      // Filter DT tasks from RAW tasks (before normalising strips members/watchers)
      const rawDtTasks = rawTasks.filter(isDtTask);
      const allTasks   = rawTasks.map(t=>normaliseTask(t,label));
      const dtTasks    = rawDtTasks.map(t=>normaliseTask(t,label));
      const openDt    = dtTasks.filter(t=>!isClosed(t.status));
      const doneDt    = dtTasks.filter(t=>isClosed(t.status));
      const blockedDt = dtTasks.filter(t=>t.status.toLowerCase().includes("blocked")||t.status.toLowerCase().includes("specs needed"));
      // Only show open/non-closed tasks in the task table — completed ones are counted but not listed
      const displayDtTasks = dtTasks.filter(t=>!isClosed(t.status));

      // Look for deploy task in next sprint too (release may be created there)
      let nextSprintDeployTask = null;
      const nextInfo = sprintListMap[n+1];
      if(nextInfo){
        const nextRaw    = await getTasksFromList(token, nextInfo.id);
        const nextRawDt  = nextRaw.filter(isDtTask);
        const nextDt     = nextRawDt.map(t=>normaliseTask(t,`PS${n+1}`));
        nextSprintDeployTask = nextDt.find(t => isDeployTask(t.name)) || null;
      }

      sprints.push({
        label, num:n,
        type:"completed",
        startDate: info.startDate,
        dueDate:   info.dueDate,
        next_sprint_deploy_task: nextSprintDeployTask,
        all_tasks:allTasks, dt_tasks:dtTasks,
        display_dt_tasks: displayDtTasks,
        open_dt:openDt, done_dt:doneDt, blocked_dt:blockedDt,
      });
    }

    // ── Bug tasks ──────────────────────────────────────────────────────────
    // Bugs: fetch with both start AND end date to scope to selected period only
    const rangeEnd = dateTo || Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+1, 0, 23, 59, 59, 999);
    const rawBugs  = await getTasksFromList(token, bugListId, {
      date_created_gt: String(rangeStart),
      date_created_lt: String(rangeEnd),
    });
    // Only include if a DT user is a watcher (explicit involvement signal)
    const bugTasks = rawBugs
      .filter(t => (t.watchers||[]).some(w => isDtEmail(w.email||"")))
      .map(t => normaliseTask(t));

    // ── Month label — use label sent from app if available ───────────────
    const reportMonth = req.body?.monthLabel || month;

    const html = buildHtml(sprints,bugTasks,{month:reportMonth,yourName,managerName});
    const sprintNames = sprints.map(s=>s.label);

    res.status(200).json({html, sprints:sprints.length, bugs:bugTasks.length, month:reportMonth, sprintNames});

  } catch(e){
    console.error("ClickUp error:",e);
    res.status(500).json({error:e.message||"Failed to fetch ClickUp data"});
  }
}
