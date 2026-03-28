const CU_BASE = "https://api.clickup.com/api/v2";
const DT_DOMAINS = new Set(["decision-tree.com"]);
const CLOSED = new Set(["closed","completed","done"]);

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

function isDtTask(task) {
  return (task.assignees||[]).some(a => DT_DOMAINS.has((a.email||"").split("@")[1]?.toLowerCase()||""));
}

function normaliseTask(raw, label="") {
  const rawStatus = raw.status||"";
  const status = typeof rawStatus==="object" ? (rawStatus.status||"unknown") : (rawStatus||"unknown");
  return {
    id: raw.id,
    customId: raw.custom_id||raw.customId||raw.id||"—",
    name: raw.name||"",
    status,
    url: raw.url||`https://app.clickup.com/t/${raw.id}`,
    assignees: (raw.assignees||[]).map(a=>({ username:a.username||"", email:a.email||"" })),
    _location_ids: (raw.locations||[]).map(l=>l.id),
  };
}

function fmtAssignees(assignees) {
  if(!assignees?.length) return "—";
  const names = assignees.slice(0,2).map(a => {
    const n = a.username||a.email||"Unknown";
    const p = n.split(" ");
    return p.length>1 ? `${p[0]} ${p[p.length-1][0]}.` : n;
  });
  const rest = assignees.length-2;
  return names.join(", ")+(rest>0?` +${rest}`:"");
}

function statusPill(status) {
  const cls = STATUS_CLASS[status.toLowerCase()]||"pill-gray";
  const label = status.replace(/ - nectar/gi,"").replace(/ - dt/gi,"");
  return `<span class="pill ${cls}">${label}</span>`;
}

function buildSprintRows(tasks, rollover=false) {
  return tasks.map(t => `<tr>
    <td><a class="task-id" href="${t.url}" target="_blank">${t.customId}</a></td>
    <td><a class="task-name-link" href="${t.url}" target="_blank">${t.name}</a>${rollover?'<span class="rollover-tag">STILL OPEN</span>':""}</td>
    <td>${statusPill(t.status)}</td>
    <td class="assignee-text">${fmtAssignees(t.assignees)}</td>
  </tr>`).join("\n");
}

function buildBugRows(bugs) {
  return bugs.map(b => `<tr>
    <td><a class="task-id" href="${b.url}" target="_blank">${b.customId}</a></td>
    <td><a class="task-name-link" href="${b.url}" target="_blank">${b.name.replace(/BUG:\s*/i,"")}</a></td>
    <td>${statusPill(b.status)}</td>
    <td class="assignee-text">${fmtAssignees(b.assignees)}</td>
  </tr>`).join("\n");
}

function buildHtml(sprints, bugTasks, { month, yourName, managerName }) {
  const now = new Date().toISOString().slice(0,16).replace("T"," ");
  const active = sprints.find(s=>s.type==="active");
  const activeLabel = active?.label||"—";
  const sprintNames = sprints.map(s=>s.label).join(", ");
  const totalDtOpen = sprints.filter(s=>s.type==="completed").reduce((a,s)=>a+s.open_dt.length,0);
  const totalBlockers = sprints.reduce((a,s)=>a+s.blocked_dt.length,0);
  const resolved = bugTasks.filter(b=>["completed","closed","user error"].includes(b.status.toLowerCase()));
  const review   = bugTasks.filter(b=>b.status.toLowerCase().includes("review"));
  const activeBugs = bugTasks.filter(b=>!["completed","closed","user error"].includes(b.status.toLowerCase())&&!b.status.toLowerCase().includes("review"));
  const bugResPct = bugTasks.length ? Math.round(resolved.length/bugTasks.length*100) : 0;

  const overviewCards = sprints.map(s => {
    const isActive = s.type==="active";
    const cls = isActive?"sprint-card active":(s.open_dt.length>0?"sprint-card attention":"sprint-card completed");
    const desc = isActive?"Currently in progress.":(s.open_dt.length>0?`${s.open_dt.length} DT task(s) still open.`:"All DT tasks closed.");
    return `<div class="${cls}">
      <div class="sprint-type">${isActive?"Active sprint":"Completed sprint"}</div>
      <div class="sprint-name">${s.label}</div>
      <div class="sprint-desc">Product Sprint ${s.num} — ${desc}</div>
      <div class="sprint-stats">
        <div class="sstat"><div class="sstat-val green">${s.done_dt.length}</div><div class="sstat-label">DT done</div></div>
        <div class="sprint-divider"></div>
        <div class="sstat"><div class="sstat-val ${isActive?"blue":s.open_dt.length>0?"amber":"gray"}">${s.open_dt.length}</div><div class="sstat-label">${isActive?"In progress":"Still open"}</div></div>
        <div class="sprint-divider"></div>
        <div class="sstat"><div class="sstat-val red">${s.blocked_dt.length}</div><div class="sstat-label">Blocked</div></div>
      </div>
    </div>`;
  }).join("\n");

  const completedSections = sprints.filter(s=>s.type==="completed"&&s.open_dt.length>0).map(s=>`
    <div class="section">
      <div class="section-head">
        <div class="section-icon si-amber">↩</div>
        <span class="section-title">${s.label} — open DT tasks (carry-overs)</span>
        <span class="section-badge amber">${s.open_dt.length} still open</span>
      </div>
      <table><thead><tr><th>ID</th><th>Task</th><th>Status</th><th>DT Assignee</th></tr></thead>
      <tbody>${buildSprintRows(s.open_dt,true)}</tbody></table>
    </div>`).join("\n");

  const activeSections = sprints.filter(s=>s.type==="active").map(s=>{
    const comp = s.dt_tasks.filter(t=>CLOSED.has(t.status.toLowerCase()));
    const inp  = s.dt_tasks.filter(t=>!CLOSED.has(t.status.toLowerCase())&&!t.status.toLowerCase().includes("blocked")&&!t.status.toLowerCase().includes("specs needed"));
    const blk  = s.blocked_dt;
    const pct  = s.dt_tasks.length ? Math.round(comp.length/s.dt_tasks.length*100) : 0;
    return `<div class="section">
      <div class="section-head">
        <div class="section-icon si-blue">⚡</div>
        <span class="section-title">${s.label} — active sprint (DT tasks)</span>
        <span class="section-badge blue">${s.dt_tasks.length} DT tasks</span>
        ${blk.length?`<span class="section-badge red">${blk.length} blocked`:""}
      </div>
      <div class="prog-grid">
        <div><div class="prog-label">Completed</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-green" style="width:${pct}%"></div></div><div class="prog-val">${comp.length} / ${s.dt_tasks.length} (${pct}%)</div></div>
        <div><div class="prog-label">In Progress</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-indigo" style="width:${s.dt_tasks.length?Math.round(inp.length/s.dt_tasks.length*100):0}%"></div></div><div class="prog-val">${inp.length} tasks</div></div>
        <div><div class="prog-label">Blocked</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-amber" style="width:${s.dt_tasks.length?Math.round(blk.length/s.dt_tasks.length*100):0}%"></div></div><div class="prog-val">${blk.length} tasks</div></div>
      </div>
      <table><thead><tr><th>ID</th><th>Task</th><th>Status</th><th>DT Assignee</th></tr></thead>
      <tbody>${buildSprintRows(s.dt_tasks)}</tbody></table>
    </div>`;
  }).join("\n");

  const CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',sans-serif;background:#f1f5f9;color:#1e293b;padding:32px 16px;-webkit-print-color-adjust:exact;print-color-adjust:exact}.wrapper{max-width:860px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0}.header{background:linear-gradient(135deg,#1e1b4b 0%,#312e81 50%,#4338ca 100%);padding:40px 44px 32px;color:#fff}.header-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.logo-mark{font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#a5b4fc;font-family:'DM Mono',monospace}.date-badge{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.2);border-radius:20px;padding:4px 14px;font-size:11px;font-family:'DM Mono',monospace;color:#c7d2fe;letter-spacing:1px}h1{font-size:26px;font-weight:700;margin-bottom:8px}h1 span{color:#a5b4fc}.header-sub{color:#c7d2fe;font-size:13px;line-height:1.6;margin-bottom:20px}.header-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.meta-item{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:6px 12px}.meta-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}.meta-dot.blue{background:#60a5fa}.meta-dot.green{background:#34d399}.meta-dot.amber{background:#fbbf24}.meta-dot.red{background:#f87171}.meta-label{font-size:11px;color:#c7d2fe;font-family:'DM Mono',monospace}.meta-val{font-size:11px;font-weight:600;color:#fff}.body{padding:32px 44px}.greeting{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;font-size:13px;line-height:1.8;color:#475569;margin-bottom:24px}.greeting strong{color:#1e293b}.sprint-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:24px}.sprint-card{border-radius:12px;padding:18px;border:1px solid}.sprint-card.active{background:linear-gradient(135deg,#eff6ff,#dbeafe);border-color:#93c5fd}.sprint-card.completed{background:#f0fdf4;border-color:#86efac}.sprint-card.attention{background:#fffbeb;border-color:#fcd34d}.sprint-type{font-size:9px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:4px}.sprint-name{font-size:22px;font-weight:700;color:#1e293b;margin-bottom:2px}.sprint-desc{font-size:11px;color:#64748b;margin-bottom:12px}.sprint-stats{display:flex;gap:8px;align-items:center}.sstat{text-align:center}.sstat-val{font-size:18px;font-weight:700}.sstat-val.green{color:#16a34a}.sstat-val.blue{color:#2563eb}.sstat-val.amber{color:#d97706}.sstat-val.red{color:#dc2626}.sstat-val.gray{color:#94a3b8}.sstat-label{font-size:9px;color:#94a3b8;font-family:'DM Mono',monospace;text-transform:uppercase}.sprint-divider{width:1px;height:28px;background:#e2e8f0;margin:0 4px}.section{margin-bottom:28px}.section-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}.section-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}.si-blue{background:#dbeafe}.si-amber{background:#fef3c7}.si-red{background:#fee2e2}.si-green{background:#dcfce7}.section-title{font-size:14px;font-weight:600;color:#1e293b;flex:1}.section-badge{font-size:10px;font-family:'DM Mono',monospace;padding:3px 10px;border-radius:20px;font-weight:500}.section-badge.blue{background:#dbeafe;color:#1d4ed8}.section-badge.amber{background:#fef3c7;color:#92400e}.section-badge.red{background:#fee2e2;color:#991b1b}.section-badge.green{background:#dcfce7;color:#166534}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:0;font-size:12px}thead tr{background:#f8fafc}th{text-align:left;padding:10px 12px;font-size:9px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;font-weight:500;border-bottom:1px solid #e2e8f0}td{padding:9px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}tr:last-child td{border-bottom:none}tr:hover td{background:#f8fafc}.task-id{font-family:'DM Mono',monospace;font-size:11px;color:#4f46e5;text-decoration:none;font-weight:500}.task-name-link{color:#1e293b;text-decoration:none;font-size:12px}.assignee-text{font-size:11px;color:#64748b;font-family:'DM Mono',monospace}.pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:500;font-family:'DM Mono',monospace}.pill-green{background:#dcfce7;color:#166634}.pill-blue{background:#dbeafe;color:#1d4ed8}.pill-gray{background:#f1f5f9;color:#64748b}.pill-purple{background:#ede9fe;color:#6d28d9}.pill-red{background:#fee2e2;color:#991b1b}.pill-amber{background:#fef3c7;color:#92400e}.pill-teal{background:#ccfbf1;color:#115e59}.rollover-tag{display:inline-block;margin-left:6px;padding:1px 7px;background:#fef3c7;color:#92400e;border-radius:4px;font-size:9px;font-family:'DM Mono',monospace;font-weight:600;letter-spacing:.5px}.prog-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-top:10px}.prog-label{font-size:9px;font-family:'DM Mono',monospace;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px}.prog-bar-bg{background:#e2e8f0;border-radius:3px;height:3px;margin:6px 0 4px;overflow:hidden}.prog-bar-fill{height:100%;border-radius:3px}.fill-green{background:#10b981}.fill-amber{background:#f59e0b}.fill-indigo{background:#6366f1}.prog-val{font-size:10px;font-family:'DM Mono',monospace;color:#475569}.overall-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.overall-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px}.oc-title{font-size:9px;font-family:'DM Mono',monospace;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}.oc-body{font-size:12px;color:#64748b;line-height:1.7}.oc-body strong{color:#1e293b;font-weight:500}.callout{display:flex;gap:12px;padding:14px 16px;border-radius:10px;border:1px solid}.callout-green{background:#f0fdf4;border-color:#86efac}.callout-icon{font-size:14px;flex-shrink:0;margin-top:1px}.callout-body strong{display:block;font-weight:600;margin-bottom:2px;font-size:13px}.callout-body span{color:#64748b;font-size:12px}.divider{height:1px;background:#e2e8f0;margin:28px 0 0}.footer{background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:20px 44px;display:flex;align-items:center;justify-content:space-between}.footer-left{font-size:10px;color:#94a3b8;line-height:1.7;font-family:'DM Mono',monospace}.footer-left strong{color:#4f46e5}.footer-sign{font-size:12px;color:#64748b}.footer-sign strong{color:#1e293b;font-weight:500}@media print{body{padding:0;background:#fff}.wrapper{border-radius:0;border:none}}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iDerive Monthly Update — ${month}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="wrapper">
<div class="header">
  <div class="header-top"><div class="logo-mark">iDerive</div><div class="date-badge">${month.toUpperCase()}</div></div>
  <h1>Monthly Progress <span>Update</span></h1>
  <p class="header-sub">Sprint overview · Deployments · Bug tracking · Overall progress · Source: ClickUp<br>
  <span style="color:#94a3b8;font-size:12px;font-family:'DM Mono',monospace">Filtered: decision-tree.com assignees only</span></p>
  <div class="header-meta">
    <div class="meta-item"><div class="meta-dot blue"></div><span class="meta-label">Sprints this month</span><span class="meta-val">${sprints.length} (${sprintNames})</span></div>
    <div class="meta-item"><div class="meta-dot green"></div><span class="meta-label">Active sprint</span><span class="meta-val">${activeLabel} (ongoing)</span></div>
    <div class="meta-item"><div class="meta-dot amber"></div><span class="meta-label">DT carry-overs</span><span class="meta-val">${totalDtOpen} open</span></div>
    <div class="meta-item"><div class="meta-dot red"></div><span class="meta-label">DT blockers</span><span class="meta-val">${totalBlockers}</span></div>
  </div>
</div>
<div class="body">
  <div class="greeting">Hi <strong>${managerName}</strong>,<br>Below is the iDerive monthly progress update for <strong>${month}</strong>. This month covered <strong>${sprints.length} sprint(s)</strong> (${sprintNames}). Tasks and bugs are <strong>filtered to Decision Tree team members only</strong>.</div>
  <div class="sprint-overview">${overviewCards}</div>
  ${completedSections}
  ${activeSections}
  <div class="section">
    <div class="section-head"><div class="section-icon si-red">🐛</div><span class="section-title">Bug tracking — ${month} (DT assignees only)</span><span class="section-badge amber">${bugTasks.length} DT bugs</span></div>
    <table><thead><tr><th>ID</th><th>Issue</th><th>Status</th><th>DT Assignee</th></tr></thead><tbody>${buildBugRows(bugTasks)}</tbody></table>
    <div class="prog-grid">
      <div><div class="prog-label">Resolved</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-green" style="width:${bugResPct}%"></div></div><div class="prog-val">${resolved.length} bugs (${bugResPct}%)</div></div>
      <div><div class="prog-label">Under review</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-amber" style="width:${bugTasks.length?Math.round(review.length/bugTasks.length*100):0}%"></div></div><div class="prog-val">${review.length} bugs</div></div>
      <div><div class="prog-label">Active</div><div class="prog-bar-bg"><div class="prog-bar-fill fill-indigo" style="width:${bugTasks.length?Math.round(activeBugs.length/bugTasks.length*100):0}%"></div></div><div class="prog-val">${activeBugs.length} bugs</div></div>
    </div>
  </div>
  <div class="divider"></div>
  <div class="section">
    <div class="section-head"><div class="section-icon si-green">📈</div><span class="section-title">Overall progress &amp; highlights</span></div>
    <div class="overall-grid">
      <div class="overall-card"><div class="oc-title">🚀 Deployment</div><div class="oc-body">Active sprint <strong>${activeLabel}</strong> in progress. Prior sprint release completed.</div></div>
      <div class="overall-card"><div class="oc-title">🐛 Bug rate</div><div class="oc-body"><strong>${bugResPct}%</strong> of DT bugs resolved. <strong>${review.length}</strong> under active review.</div></div>
      <div class="overall-card"><div class="oc-title">⚠️ Blockers</div><div class="oc-body"><strong>${totalBlockers}</strong> DT task(s) blocked in active sprint.</div></div>
      <div class="overall-card"><div class="oc-title">↩ Carry-overs</div><div class="oc-body"><strong>${totalDtOpen}</strong> DT task(s) from completed sprints remain open.</div></div>
    </div>
    <div class="callout callout-green" style="margin-top:12px"><div class="callout-icon">💬</div><div class="callout-body"><strong>Next steps</strong><span>Happy to walk through any of the above in our next sync.</span></div></div>
  </div>
</div>
<div class="footer">
  <div class="footer-left"><strong>iDerive</strong> · Monthly Report · ${month} · DT team view<br>Sprints: ${sprintNames} · Generated: ${now} · Source: ClickUp</div>
  <div class="footer-sign">Best regards,<br><strong>${yourName}</strong></div>
</div>
</div></body></html>`;
}

export default async function handler(req, res) {
  const allowedOrigins = ["https://rhlsinghal.github.io","http://localhost:3000"];
  const origin = req.headers.origin||"";
  if(allowedOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS"){ res.status(200).end(); return; }
  if(req.method!=="POST"){ res.status(405).json({error:"Method not allowed"}); return; }

  const token        = process.env.CLICKUP_API_TOKEN;
  const sprintFolder = process.env.SPRINT_FOLDER_ID  || "90091150377";
  const bugListId    = process.env.BUG_LIST_ID        || "900902273006";
  const lookback     = parseInt(process.env.SPRINT_LOOKBACK||"2");
  const crossListIds = (process.env.CROSS_LIST_IDS||"901601528769,900902273006").split(",").map(s=>s.trim()).filter(Boolean);
  const yourName     = process.env.YOUR_NAME          || "Rahul Singhal";
  const managerName  = process.env.MANAGER_NAME       || "Abhishek";

  if(!token){ res.status(500).json({error:"CLICKUP_API_TOKEN not configured"}); return; }

  try {
    const now = new Date();
    const month = now.toLocaleDateString("en-US",{month:"long",year:"numeric"});
    const monthStartTs = new Date(now.getFullYear(),now.getMonth(),1).getTime();

    const listsData = await cuGet(token,`/folder/${sprintFolder}/list`,{archived:"false"});
    const lists = listsData.lists||[];
    const sprintListMap = {};
    for(const lst of lists){
      const m = lst.name?.match(/product sprint\s+(\d+)/i);
      if(m) sprintListMap[parseInt(m[1])]=lst.id;
    }
    if(!Object.keys(sprintListMap).length){ res.status(200).json({error:"No sprint lists found"}); return; }

    let activeNum=null;
    const taskCache={};
    for(const num of Object.keys(sprintListMap).map(Number).sort((a,b)=>b-a)){
      const raw = await getTasksFromList(token,sprintListMap[num]);
      taskCache[num]=raw;
      if(!raw.length) continue;
      const hasActive = raw.some(t=>{
        const s=(typeof t.status==="object"?t.status?.status:t.status||"").toLowerCase();
        return !CLOSED.has(s)&&(t.assignees||[]).length>0;
      });
      if(hasActive){ activeNum=num; break; }
    }
    if(!activeNum){ res.status(200).json({error:"Could not identify active sprint"}); return; }

    const crossRaw=[];
    for(const lid of crossListIds){
      const batch = await getTasksFromList(token,lid,{date_updated_gt:String(monthStartTs)});
      for(const t of batch) if(isDtTask(t)) crossRaw.push(t);
    }

    const sprints=[];
    for(let n=activeNum-lookback; n<=activeNum; n++){
      if(!sprintListMap[n]) continue;
      const sprintListId=sprintListMap[n];
      const label=`PS${n}`;
      const rawTasks=[...(taskCache[n]||await getTasksFromList(token,sprintListMap[n]))];
      const seenIds=new Set(rawTasks.map(t=>t.id));
      for(const t of crossRaw){
        const locIds=(t.locations||[]).map(l=>l.id);
        if(locIds.includes(sprintListId)&&!seenIds.has(t.id)){ rawTasks.push(t); seenIds.add(t.id); }
      }
      const allTasks=rawTasks.map(t=>normaliseTask(t,label));
      const dtTasks=allTasks.filter(isDtTask);
      const openDt=dtTasks.filter(t=>!CLOSED.has(t.status.toLowerCase()));
      const doneDt=dtTasks.filter(t=>CLOSED.has(t.status.toLowerCase()));
      const blockedDt=dtTasks.filter(t=>t.status.toLowerCase().includes("blocked")||t.status.toLowerCase().includes("specs needed"));
      sprints.push({label,num:n,type:n===activeNum?"active":"completed",all_tasks:allTasks,dt_tasks:dtTasks,open_dt:openDt,done_dt:doneDt,blocked_dt:blockedDt});
    }

    const rawBugs=await getTasksFromList(token,bugListId,{date_created_gt:String(monthStartTs)});
    const bugTasks=rawBugs.map(t=>normaliseTask(t)).filter(isDtTask);

    const html=buildHtml(sprints,bugTasks,{month,yourName,managerName});
    res.status(200).json({html,sprints:sprints.length,bugs:bugTasks.length,month});

  } catch(e){
    console.error("ClickUp error:",e);
    res.status(500).json({error:e.message||"Failed to fetch ClickUp data"});
  }
}
