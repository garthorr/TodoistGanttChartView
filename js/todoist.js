/**
 * Ganttist — a Gantt viewer for Todoist.
 *
 * Uses the Todoist REST API v1 (Bearer token, JSON) and Frappe Gantt.
 * No jQuery, no build step, no server needed.
 */

const DIRECT_API = "https://api.todoist.com/api/v1";
const PROXY_API = "/api/v1";
const TOKEN_KEY = "todoist_gantt_token";
const PROJECTS_KEY = "todoist_gantt_projects";
const VIEW_KEY = "todoist_gantt_view";
const NODUE_KEY = "todoist_gantt_nodue";
const DAY_MS = 24 * 60 * 60 * 1000;

let apiBase = null;

// Todoist API v1 may return either a plain array or { items: [...] }.
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
  addProject: document.getElementById("add_project"),
  projectChips: document.getElementById("project_chips"),
  viewMode: document.getElementById("view_mode"),
  includeNoDue: document.getElementById("include_nodue"),
  linkTasks: document.getElementById("link_tasks"),
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
// Module-level lookup by String(id) — Frappe Gantt may not preserve custom
// properties on task objects it passes to callbacks.
let currentTaskMap = new Map();
// Active projects shown on the chart: [{ id, name }, ...]
let activeProjects = [];
// Link mode: null = off, {} = waiting for source, { sourceId, sourceName } = waiting for target.
let linkState = null;

// ---------- init ----------

const savedToken = localStorage.getItem(TOKEN_KEY);
if (savedToken) els.token.value = savedToken;

const savedView = localStorage.getItem(VIEW_KEY);
if (savedView) els.viewMode.value = savedView;
if (localStorage.getItem(NODUE_KEY) === "1") els.includeNoDue.checked = true;

try {
  activeProjects = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "[]");
} catch (_) {
  activeProjects = [];
}

els.token.addEventListener("change", () =>
  localStorage.setItem(TOKEN_KEY, els.token.value.trim())
);

els.loadProjects.addEventListener("click", loadProjects);

els.addProject.addEventListener("click", () => {
  const id = els.projects.value;
  const option = els.projects.querySelector(`option[value="${CSS.escape(id)}"]`);
  if (!id || !option || activeProjects.some((p) => p.id === id)) return;
  addProjectToChart(id, option.textContent.trim());
});

// Enter key in the dropdown acts as "Add".
els.projects.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.addProject.click();
});

els.viewMode.addEventListener("change", () => {
  localStorage.setItem(VIEW_KEY, els.viewMode.value);
  if (ganttInstance) ganttInstance.change_view_mode(els.viewMode.value);
});

els.includeNoDue.addEventListener("change", () => {
  localStorage.setItem(NODUE_KEY, els.includeNoDue.checked ? "1" : "0");
  if (currentTasks.length) renderGantt(currentTasks);
});

els.linkTasks.addEventListener("click", () => {
  if (linkState !== null) {
    exitLinkMode();
  } else {
    enterLinkMode();
  }
});

// Escape cancels link mode (and the drawer key handler covers the drawer).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && linkState !== null) exitLinkMode();
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
    if (res.status !== 404) {
      apiBase = PROXY_API;
      console.info("[Ganttist] using same-origin API proxy");
      return apiBase;
    }
  } catch (err) {
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
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
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
      '<option value="">— Add a project —</option>' +
      sorted
        .map(
          (p) =>
            `<option value="${p.id}">${"  ".repeat(p.depth)}${escapeHtml(p.name)}</option>`
        )
        .join("");

    localStorage.setItem(TOKEN_KEY, els.token.value.trim());
    setStatus(`Loaded ${projects.length} projects.`, "success");

    // Restore persisted active projects. Prune any that were deleted.
    const nameById = new Map(projects.map((p) => [String(p.id), p.name]));
    activeProjects = activeProjects.filter((p) => nameById.has(p.id));
    saveActiveProjects();
    renderChips(nameById);
    if (activeProjects.length) loadAllTasks();
  } catch (err) {
    setStatus(err.message, "error");
  }
}

// ---------- Multi-project chips ----------

function saveActiveProjects() {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(activeProjects));
}

function renderChips(nameById) {
  els.projectChips.innerHTML = "";
  for (const { id, name } of activeProjects) {
    addChipDOM(id, nameById ? (nameById.get(id) || name) : name);
  }
}

function addChipDOM(id, name) {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.dataset.id = id;
  chip.innerHTML =
    `${escapeHtml(name)}` +
    `<button class="chip-remove" aria-label="Remove ${escapeHtml(name)}" data-id="${escapeHtml(id)}">&times;</button>`;
  els.projectChips.appendChild(chip);
}

function addProjectToChart(id, name) {
  if (activeProjects.some((p) => p.id === id)) return;
  activeProjects.push({ id, name });
  saveActiveProjects();
  addChipDOM(id, name);
  loadAllTasks();
}

function removeProjectFromChart(id) {
  activeProjects = activeProjects.filter((p) => p.id !== id);
  saveActiveProjects();
  const chip = els.projectChips.querySelector(`.chip[data-id="${CSS.escape(id)}"]`);
  if (chip) chip.remove();
  loadAllTasks();
}

els.projectChips.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip-remove");
  if (btn) removeProjectFromChart(btn.dataset.id);
});

// ---------- Tasks ----------

async function loadAllTasks() {
  if (!activeProjects.length) {
    currentTasks = [];
    clearGantt();
    return;
  }
  try {
    setStatus("Loading tasks…");
    const batches = await Promise.all(
      activeProjects.map(({ id }) =>
        api(`/tasks?project_id=${encodeURIComponent(id)}`).then(normalizeList)
      )
    );
    // Merge and deduplicate by task id.
    const seen = new Set();
    const merged = [];
    for (const batch of batches) {
      for (const task of batch) {
        if (!seen.has(task.id)) {
          seen.add(task.id);
          merged.push(task);
        }
      }
    }
    currentTasks = merged;
    renderGantt(currentTasks);
    const projectWord = activeProjects.length === 1 ? "project" : "projects";
    setStatus(
      `Loaded ${merged.length} tasks from ${activeProjects.length} ${projectWord}.`,
      "success"
    );
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
    end = parseIsoDate(`${due.date}T23:59:59`);
  }
  if (!end) return null;

  let start;
  // 1. Explicit start: date in description wins.
  if (descMeta && descMeta.start) {
    const s = parseIsoDate(`${descMeta.start}T00:00:00`);
    if (s && s < end) start = s;
  }
  // 2. Todoist duration field.
  if (!start && task.duration) {
    const minutes =
      task.duration.unit === "day"
        ? task.duration.amount * 24 * 60
        : task.duration.amount;
    start = new Date(end.getTime() - minutes * 60 * 1000);
  }
  // 3. added_at capped to 7 days, then a 3-day default bar.
  if (!start) {
    const addedAt =
      parseIsoDate(task.added_at) || parseIsoDate(task.created_at);
    const maxLookback = new Date(end.getTime() - 7 * DAY_MS);
    if (addedAt && addedAt > maxLookback && addedAt < end) {
      start = addedAt;
    } else {
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    bounds = { start: today, end: new Date(today.getTime() + DAY_MS) };
  }

  const priorityClass = `priority-p${5 - (task.priority || 1)}`;
  const recurringClass = task.due && task.due.is_recurring ? " recurring" : "";
  const noDueClass = !task.due ? " no-due" : "";

  const depIds = new Set();
  if (task.parent_id && taskMap.has(String(task.parent_id))) {
    depIds.add(String(task.parent_id));
  }
  for (const d of descMeta.deps) {
    if (taskMap.has(String(d))) depIds.add(String(d));
  }

  return {
    id: String(task.id),
    name: task.content,
    start: formatDate(bounds.start),
    end: formatDate(bounds.end),
    progress: 0,
    dependencies: [...depIds].join(","),
    custom_class: `${priorityClass}${recurringClass}${noDueClass}`,
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

  currentTaskMap = new Map(filtered.map((t) => [String(t.id), t]));
  const taskMap = currentTaskMap;

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
      const raw = currentTaskMap.get(String(task.id));
      if (!raw) return;
      if (linkState !== null) {
        handleLinkClick(String(task.id), task.name);
        return;
      }
      openDrawer(raw);
    },
    on_date_change: (task, start, end) => {
      const raw = currentTaskMap.get(String(task.id));
      if (raw) updateTaskDueDate(raw, end);
    },
    custom_popup_html: (task) => {
      const src = currentTaskMap.get(String(task.id)) || {};
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
          ${
            src.app_url || src.url
              ? `<div><a href="${src.app_url || src.url}" target="_blank" rel="noreferrer">Open in Todoist</a></div>`
              : ""
          }
        </div>`;
    },
  });

  scrollToToday();
}

function scrollToToday() {
  requestAnimationFrame(() => {
    const wrapper = els.gantt.closest(".gantt-wrapper");
    if (!wrapper) return;
    const today = els.gantt.querySelector(".today-highlight");
    const targetX = today ? parseFloat(today.getAttribute("x")) || 0 : 0;
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
    // Update in-memory; note recurring tasks keep their recurrence rule
    // server-side and will show the next occurrence on reload.
    task.due = { ...(task.due || {}), date: due_date };
    setStatus(`Rescheduled "${task.content}" to ${due_date}.`, "success");
  } catch (err) {
    setStatus(`Failed to reschedule: ${err.message}`, "error");
    if (activeProjects.length) loadAllTasks();
  }
}

// ---------- Link mode ----------

function enterLinkMode() {
  linkState = {};
  els.linkTasks.classList.add("btn-active");
  els.linkTasks.textContent = "Cancel linking";
  setStatus("Link mode: click the task that must finish first.", "info");
  els.gantt.closest(".gantt-wrapper").classList.add("link-mode");
}

function exitLinkMode() {
  linkState = null;
  els.linkTasks.classList.remove("btn-active");
  els.linkTasks.textContent = "Link tasks";
  els.gantt.closest(".gantt-wrapper").classList.remove("link-mode");
  setStatus("", "");
}

function handleLinkClick(id, name) {
  if (!linkState.sourceId) {
    // First click: record the source ("must finish first") task.
    linkState.sourceId = id;
    linkState.sourceName = name;
    setStatus(
      `"${name}" will be the predecessor. Now click the task that depends on it.`,
      "info"
    );
  } else if (linkState.sourceId === id) {
    // Clicked the same bar twice: cancel.
    exitLinkMode();
  } else {
    // Second click: create the arrow from source → this target.
    createDependency(linkState.sourceId, id);
    exitLinkMode();
  }
}

async function createDependency(sourceId, targetId) {
  const target = currentTaskMap.get(targetId);
  if (!target) return;

  const desc = target.description || "";
  // Look for an existing deps line to append to.
  const depsMatch = desc.match(
    /((?:^|\n)\s*(?:deps|depends|depends_on)\s*:\s*)([^\n]+)/i
  );

  let newDesc;
  if (depsMatch) {
    const existing = depsMatch[2]
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (existing.includes(sourceId)) {
      setStatus("That dependency already exists.", "info");
      return;
    }
    existing.push(sourceId);
    newDesc = desc.replace(
      depsMatch[0],
      `${depsMatch[1]}${existing.join(", ")}`
    );
  } else {
    newDesc = desc ? `${desc}\ndeps: ${sourceId}` : `deps: ${sourceId}`;
  }

  try {
    setStatus("Adding dependency…");
    const updated = await api(`/tasks/${targetId}`, {
      method: "POST",
      body: JSON.stringify({ description: newDesc }),
    });
    if (updated) {
      const idx = currentTasks.findIndex((t) => String(t.id) === targetId);
      if (idx >= 0) currentTasks[idx] = updated;
    }
    renderGantt(currentTasks);
    setStatus("Dependency added.", "success");
  } catch (err) {
    setStatus(`Failed to add dependency: ${err.message}`, "error");
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
  if (f.due_date.value) {
    body.due_date = f.due_date.value;
  } else if (drawerTask.due) {
    body.due_string = "no date";
  }
  try {
    setStatus(`Saving "${body.content}"…`);
    const updated = await api(`/tasks/${drawerTask.id}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const idx = currentTasks.findIndex(
      (t) => String(t.id) === String(drawerTask.id)
    );
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
    currentTasks = currentTasks.filter(
      (t) => String(t.id) !== String(drawerTask.id)
    );
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
