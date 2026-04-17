/**
 * Ganttist — a Gantt viewer for Todoist.
 *
 * Uses the Todoist REST API v1 (Bearer token, JSON) and Frappe Gantt.
 * No jQuery, no build step, no server needed.
 */

// Where to hit the Todoist REST API from. Two modes:
//   - "/api/v1"                — same-origin, proxied by our nginx (Docker)
//   - direct api.todoist.com   — browser talks to Todoist directly (CORS)
//
// We detect which is available on first API call. Users running the
// Docker image get the proxy automatically and avoid CORS entirely.
//
// Todoist deprecated REST v2 (/rest/v2/) in 2025; all endpoints now live
// under /api/v1/. Field renamed: created_at → added_at.
const DIRECT_API = "https://api.todoist.com/api/v1";
const PROXY_API = "/api/v1";
const TOKEN_KEY = "todoist_gantt_token";
const DAY_MS = 24 * 60 * 60 * 1000;

let apiBase = null; // resolved lazily on first call

// Todoist API v1 may return either a plain array or { items: [...] }.
// Normalise both shapes so callers always get an array.
function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

const els = {
  token: document.getElementById("auth_token"),
  loadProjects: document.getElementById("load_projects"),
  projects: document.getElementById("projects"),
  viewMode: document.getElementById("view_mode"),
  includeNoDue: document.getElementById("include_nodue"),
  status: document.getElementById("status"),
  empty: document.getElementById("empty-state"),
  gantt: document.getElementById("gantt"),
  drawer: document.getElementById("task_drawer"),
  drawerTitle: document.getElementById("drawer_title"),
  drawerForm: document.getElementById("drawer_form"),
  drawerMeta: document.getElementById("drawer_meta"),
  drawerComplete: document.getElementById("drawer_complete"),
  drawerPopup: document.getElementById("drawer_popup"),
  drawerOpen: document.getElementById("drawer_open"),
};

let ganttInstance = null;
let currentTasks = [];
let currentProjectId = "";

// ---------- init ----------

const savedToken = localStorage.getItem(TOKEN_KEY);
if (savedToken) els.token.value = savedToken;

els.token.addEventListener("change", () =>
  localStorage.setItem(TOKEN_KEY, els.token.value.trim())
);
els.loadProjects.addEventListener("click", loadProjects);
els.projects.addEventListener("change", () => {
  currentProjectId = els.projects.value;
  loadTasks(currentProjectId);
});
els.viewMode.addEventListener("change", () => {
  if (ganttInstance) ganttInstance.change_view_mode(els.viewMode.value);
});
els.includeNoDue.addEventListener("change", () => {
  if (currentTasks.length) renderGantt(currentTasks);
});

// Auto-load projects on page load if token already saved.
if (savedToken) loadProjects();

// ---------- API ----------

function buildHeaders(token, options) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
    headers["X-Request-Id"] =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random()}`;
  }
  return headers;
}

// Decide which API base to use. On file:// we can only go direct.
// On http(s), probe the proxy first (any response that isn't a 404 or
// a network error means our nginx is in front).
async function resolveApiBase(token) {
  if (apiBase) return apiBase;
  if (location.protocol === "file:") {
    apiBase = DIRECT_API;
    return apiBase;
  }
  try {
    const res = await fetch(`${PROXY_API}/projects`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    // 200 OK, 401/403 (token bad) all prove the proxy is alive.
    // 404 → no proxy, fall through to direct.
    if (res.status !== 404) {
      apiBase = PROXY_API;
      console.info("[Ganttist] using same-origin API proxy");
      return apiBase;
    }
  } catch (err) {
    // Network error on /api/ — probably no proxy; fall through.
    console.info("[Ganttist] no proxy detected, calling api.todoist.com directly");
  }
  apiBase = DIRECT_API;
  return apiBase;
}

async function api(path, options = {}) {
  const token = els.token.value.trim();
  if (!token) throw new Error("Please paste your Todoist API token first.");

  const base = await resolveApiBase(token);
  const headers = buildHeaders(token, options);

  let res;
  try {
    res = await fetch(`${base}${path}`, { ...options, headers });
  } catch (err) {
    // TypeError from fetch usually means CORS, DNS, offline, or a bad cert.
    // The browser does not expose which one to JS, so give actionable advice.
    const hint =
      base === DIRECT_API
        ? " This is often a CORS or network issue — try running the included Docker image (which proxies through nginx)."
        : "";
    throw new Error(`Could not reach Todoist (${err.message}).${hint}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Todoist rejected the API token (HTTP " +
        res.status +
        "). Double-check you copied it from Settings → Integrations → Developer."
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Todoist API error ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- UI helpers ----------

function setStatus(msg, kind = "info") {
  els.status.textContent = msg || "";
  els.status.dataset.kind = kind;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------- Projects ----------

async function loadProjects() {
  try {
    setStatus("Loading projects…");
    const projects = normalizeList(await api("/projects"));

    // Sort by hierarchy (parents first) then name.
    const byParent = new Map();
    for (const p of projects) {
      const key = p.parent_id || "root";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(p);
    }
    const sorted = [];
    const walk = (parentId, depth) => {
      const kids = byParent.get(parentId || "root") || [];
      kids.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      for (const p of kids) {
        sorted.push({ ...p, depth });
        walk(p.id, depth + 1);
      }
    };
    walk(null, 0);

    els.projects.innerHTML =
      '<option value="">— Choose a project —</option>' +
      '<option value="__all__">All projects</option>' +
      sorted
        .map(
          (p) =>
            `<option value="${p.id}">${"  ".repeat(p.depth)}${escapeHtml(
              p.name
            )}</option>`
        )
        .join("");

    localStorage.setItem(TOKEN_KEY, els.token.value.trim());
    setStatus(`Loaded ${projects.length} projects.`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

// ---------- Tasks ----------

async function loadTasks(projectId) {
  if (!projectId) {
    currentTasks = [];
    clearGantt();
    return;
  }
  try {
    setStatus("Loading tasks…");
    const path =
      projectId === "__all__"
        ? "/tasks"
        : `/tasks?project_id=${encodeURIComponent(projectId)}`;
    const tasks = normalizeList(await api(path));
    currentTasks = tasks;
    renderGantt(tasks);
    setStatus(`Loaded ${tasks.length} tasks.`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

function parseIsoDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// Todoist tasks don't have a native start date or dependency field, so we
// let users add them inside the task description using simple conventions:
//
//   start: 2026-04-10
//   deps: 7123456789, 7123456790
//   depends: 7123456789
//
// These lines are picked up here and applied to the Gantt bar.
function parseDescription(description) {
  const meta = { start: null, deps: [] };
  if (!description) return meta;
  const startMatch = description.match(
    /(?:^|\n)\s*start\s*:\s*(\d{4}-\d{2}-\d{2})\b/i
  );
  if (startMatch) meta.start = startMatch[1];
  const depsMatch = description.match(
    /(?:^|\n)\s*(?:deps|depends|depends_on)\s*:\s*([^\n]+)/i
  );
  if (depsMatch) {
    meta.deps = depsMatch[1]
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return meta;
}

function taskBounds(task, descMeta) {
  const due = task.due;
  let end;
  if (due && due.datetime) {
    end = parseIsoDate(due.datetime);
  } else if (due && due.date) {
    // due.date is always YYYY-MM-DD in v1. Append end-of-day so the bar
    // reaches the full due day in local time.
    end = parseIsoDate(`${due.date}T23:59:59`);
  }
  if (!end) return null;

  let start;
  // 1. Explicit `start: YYYY-MM-DD` in the description wins.
  if (descMeta && descMeta.start) {
    const s = parseIsoDate(`${descMeta.start}T00:00:00`);
    if (s && s < end) start = s;
  }
  // 2. Duration field from Todoist.
  if (!start && task.duration) {
    const minutes =
      task.duration.unit === "day"
        ? task.duration.amount * 24 * 60
        : task.duration.amount;
    start = new Date(end.getTime() - minutes * 60 * 1000);
  }
  // 3. Fall back to added_at, capped so ancient tasks don't blow out the scale.
  if (!start) {
    // API v1 uses added_at; v2 used created_at. Cap the lookback to
    // 7 days so an ancient creation date doesn't make the chart span
    // years and push all visible bars to one side.
    const addedAt =
      parseIsoDate(task.added_at) || parseIsoDate(task.created_at);
    const maxLookback = new Date(end.getTime() - 7 * DAY_MS);
    if (addedAt && addedAt > maxLookback && addedAt < end) {
      start = addedAt;
    } else {
      // Default: show task as a 3-day bar ending on the due date so
      // bars are wide enough to read in any view mode.
      start = new Date(end.getTime() - 3 * DAY_MS);
    }
  }

  if (start >= end) start = new Date(end.getTime() - DAY_MS);
  if (end - start < DAY_MS) start = new Date(end.getTime() - DAY_MS);
  return { start, end };
}

function toGanttTask(task, taskMap) {
  const descMeta = parseDescription(task.description);
  let bounds = taskBounds(task, descMeta);
  if (!bounds) {
    // For tasks with no due date: park them on today.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    bounds = { start: today, end: new Date(today.getTime() + DAY_MS) };
  }

  const priorityClass = `priority-p${5 - (task.priority || 1)}`;
  const recurringClass = task.due && task.due.is_recurring ? " recurring" : "";
  const noDueClass = !task.due ? " no-due" : "";

  // Dependencies: combine the implicit parent_id link with any explicit
  // `deps:` ids from the description. Filter to tasks actually on the chart
  // so Frappe Gantt doesn't warn about missing nodes.
  const depIds = new Set();
  if (task.parent_id && taskMap.has(String(task.parent_id))) {
    depIds.add(String(task.parent_id));
  }
  for (const d of descMeta.deps) {
    if (taskMap.has(String(d))) depIds.add(String(d));
  }
  const dependencies = [...depIds].join(",");

  return {
    id: String(task.id),
    name: task.content,
    start: formatDate(bounds.start),
    end: formatDate(bounds.end),
    progress: 0,
    dependencies,
    custom_class: `${priorityClass}${recurringClass}${noDueClass}`,
    _task: task,
  };
}

function clearGantt() {
  els.empty.hidden = false;
  els.gantt.innerHTML = "";
  ganttInstance = null;
}

function renderGantt(tasks) {
  const filtered = els.includeNoDue.checked
    ? tasks
    : tasks.filter((t) => t.due);

  if (!filtered.length) {
    clearGantt();
    setStatus(
      tasks.length
        ? "No tasks with due dates. Tick the checkbox to include undated tasks."
        : "No tasks in this project.",
      "info"
    );
    return;
  }

  els.empty.hidden = true;
  els.gantt.innerHTML = "";

  const taskMap = new Map(filtered.map((t) => [String(t.id), t]));

  // Sort parents before children, then by due date.
  const sorted = [...filtered].sort((a, b) => {
    const ap = a.parent_id ? 1 : 0;
    const bp = b.parent_id ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const ad = (a.due && a.due.date) || "9999-12-31";
    const bd = (b.due && b.due.date) || "9999-12-31";
    return ad.localeCompare(bd);
  });

  const ganttTasks = sorted.map((t) => toGanttTask(t, taskMap));

  ganttInstance = new Gantt(els.gantt, ganttTasks, {
    view_mode: els.viewMode.value,
    bar_height: 24,
    bar_corner_radius: 4,
    padding: 18,
    language: "en",
    on_view_change: () => scrollToToday(),
    on_click: (task) => {
      if (task._task) openDrawer(task._task);
    },
    on_date_change: (task, start, end) => {
      updateTaskDueDate(task._task, end);
    },
    custom_popup_html: (task) => {
      const src = task._task || {};
      const pr = src.priority || 1;
      const labels = (src.labels || []).join(", ") || "—";
      const due =
        (src.due && (src.due.string || src.due.date)) || "No due date";
      const recurring =
        src.due && src.due.is_recurring ? " <em>(recurring)</em>" : "";
      return `
        <div class="gantt-popup">
          <h4>${escapeHtml(task.name)}</h4>
          <div><strong>Due:</strong> ${escapeHtml(due)}${recurring}</div>
          <div><strong>Priority:</strong> P${5 - pr}</div>
          <div><strong>Labels:</strong> ${escapeHtml(labels)}</div>
          ${
            src.description
              ? `<div class="desc">${escapeHtml(src.description)}</div>`
              : ""
          }
          ${src.app_url || src.url ? `<div><a href="${src.app_url || src.url}" target="_blank" rel="noreferrer">Open in Todoist</a></div>` : ""}
        </div>`;
    },
  });

  // Frappe Gantt renders the full date range from the earliest start to the
  // latest end, which can span weeks. Today is often near the right edge,
  // leaving empty past-space on the left. Scroll the wrapper so today sits
  // near the left, giving the user a "now and what's coming" view.
  scrollToToday();
}

function scrollToToday() {
  // Wait one frame so Frappe Gantt has painted .today-highlight.
  requestAnimationFrame(() => {
    const wrapper = els.gantt.closest(".gantt-wrapper");
    if (!wrapper) return;
    const today = els.gantt.querySelector(".today-highlight");
    let targetX;
    if (today) {
      // today-highlight is a <rect>; use its x attribute.
      targetX = parseFloat(today.getAttribute("x")) || 0;
    } else {
      // Fallback: scroll roughly 2 days in from the left edge of the chart.
      targetX = 0;
    }
    // Position today ~80px from the left edge of the viewport so a little
    // past context is still visible, but upcoming work dominates the view.
    wrapper.scrollLeft = Math.max(0, targetX - 80);
  });
}

async function updateTaskDueDate(task, end) {
  try {
    const due_date = formatDate(end);
    setStatus(`Updating "${task.content}"…`);
    await api(`/tasks/${task.id}`, {
      method: "POST",
      body: JSON.stringify({ due_date }),
    });
    // Update in-memory task so further drags use the new date.
    // Note: for recurring tasks, Todoist keeps the recurrence rule and will
    // recalculate the next occurrence. Setting due_date shifts only the
    // current occurrence; the task will reappear as recurring on reload.
    task.due = { ...(task.due || {}), date: due_date };
    setStatus(`Rescheduled "${task.content}" to ${due_date}.`, "success");
  } catch (err) {
    setStatus(`Failed to reschedule: ${err.message}`, "error");
    // Re-render to snap bar back to real date.
    if (currentProjectId) loadTasks(currentProjectId);
  }
}

// ---------- Task drawer ----------
//
// A side panel that opens when a Gantt bar is clicked. Lets the user edit
// the task in-place (content, description, due date, priority, labels),
// mark it complete, or open it in a real Todoist popup window. All changes
// go through REST API v1.

let drawerTask = null;

function openDrawer(task) {
  drawerTask = task;
  const f = els.drawerForm.elements;
  els.drawerTitle.textContent = task.content;
  f.content.value = task.content;
  f.description.value = task.description || "";
  f.due_date.value = (task.due && task.due.date) || "";
  f.priority.value = String(task.priority || 1);
  f.labels.value = (task.labels || []).join(", ");
  els.drawerOpen.href = task.app_url || task.url || "#";
  els.drawerMeta.innerHTML = drawerMetaHtml(task);
  els.drawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  document.addEventListener("keydown", handleDrawerKey);
  // Focus the title for quick edits.
  setTimeout(() => f.content.focus(), 60);
}

function closeDrawer() {
  els.drawer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  document.removeEventListener("keydown", handleDrawerKey);
  drawerTask = null;
}

function handleDrawerKey(e) {
  if (e.key === "Escape") closeDrawer();
}

function drawerMetaHtml(task) {
  const parts = [];
  if (task.due && task.due.string)
    parts.push(`Due: <strong>${escapeHtml(task.due.string)}</strong>`);
  if (task.due && task.due.is_recurring) parts.push("Recurring");
  const added = task.added_at || task.created_at;
  if (added) {
    const d = new Date(added);
    if (!isNaN(d.getTime())) parts.push(`Created ${d.toLocaleDateString()}`);
  }
  if (task.comment_count) parts.push(`${task.comment_count} comment(s)`);
  // Task ID — useful when authoring `deps: <id>` in another task's description.
  parts.push(
    `ID: <code style="user-select:all">${escapeHtml(String(task.id))}</code>`
  );
  return parts.join(" • ");
}

els.drawer.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) closeDrawer();
});

els.drawerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!drawerTask) return;
  const f = els.drawerForm.elements;
  const labels = f.labels.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const body = {
    content: f.content.value,
    description: f.description.value,
    priority: Number(f.priority.value) || 1,
    labels,
  };
  // Due date: pick date picker value, or clear it if emptied.
  if (f.due_date.value) {
    body.due_date = f.due_date.value;
  } else if (drawerTask.due) {
    body.due_string = "no date"; // clears the due date in Todoist
  }
  try {
    setStatus(`Saving "${body.content}"…`);
    const updated = await api(`/tasks/${drawerTask.id}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Merge updated task into the in-memory list and re-render.
    const idx = currentTasks.findIndex((t) => t.id === drawerTask.id);
    if (idx >= 0 && updated) currentTasks[idx] = updated;
    renderGantt(currentTasks);
    setStatus(`Saved "${body.content}".`, "success");
    closeDrawer();
  } catch (err) {
    setStatus(`Failed to save: ${err.message}`, "error");
  }
});

els.drawerComplete.addEventListener("click", async () => {
  if (!drawerTask) return;
  if (!confirm(`Mark "${drawerTask.content}" as complete?`)) return;
  try {
    setStatus("Marking complete…");
    await api(`/tasks/${drawerTask.id}/close`, { method: "POST" });
    currentTasks = currentTasks.filter((t) => t.id !== drawerTask.id);
    renderGantt(currentTasks);
    setStatus("Task completed.", "success");
    closeDrawer();
  } catch (err) {
    setStatus(`Failed to complete: ${err.message}`, "error");
  }
});

els.drawerPopup.addEventListener("click", () => {
  if (!drawerTask) return;
  const url = drawerTask.app_url || drawerTask.url;
  if (!url) return;
  // Open Todoist in a sized popup window. It can't be iframed (Todoist
  // sends X-Frame-Options: DENY), but a popup feels close to embedded.
  const w = 480;
  const h = 720;
  const left = Math.max(0, window.screenX + window.outerWidth - w - 20);
  const top = Math.max(0, window.screenY + 80);
  window.open(
    url,
    "todoist-popup",
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`
  );
});
