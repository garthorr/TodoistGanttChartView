/**
 * Ganttist — a Gantt viewer for Todoist.
 *
 * Uses the Todoist REST API v1 (Bearer token, JSON) and dhtmlxGantt.
 * No jQuery, no build step, no server needed.
 */

const DIRECT_API = "https://api.todoist.com/api/v1";
const PROXY_API = "/api/v1";
const TOKEN_KEY = "todoist_gantt_token";
const PROJECTS_KEY = "todoist_gantt_projects";
const VIEW_KEY = "todoist_gantt_view";
const NODUE_KEY = "todoist_gantt_nodue";
const DEFAULT_DUR_KEY = "todoist_gantt_defdur";
const DAY_MS = 24 * 60 * 60 * 1000;

function getDefaultDurationMs() {
  const val = localStorage.getItem(DEFAULT_DUR_KEY) || "480";
  return parseInt(val, 10) * 60 * 1000;
}

let apiBase = null;

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
  defaultDuration: document.getElementById("default_duration"),
};

let ganttReady = false;
let currentTasks = [];
let currentTaskMap = new Map();
let activeProjects = [];

// ---------- init ----------

const savedToken = localStorage.getItem(TOKEN_KEY);
if (savedToken) els.token.value = savedToken;

const savedView = localStorage.getItem(VIEW_KEY);
if (savedView) els.viewMode.value = savedView;
if (localStorage.getItem(NODUE_KEY) === "1") els.includeNoDue.checked = true;
const savedDefdur = localStorage.getItem(DEFAULT_DUR_KEY);
if (savedDefdur) els.defaultDuration.value = savedDefdur;

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

els.projects.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.addProject.click();
});

els.viewMode.addEventListener("change", () => {
  localStorage.setItem(VIEW_KEY, els.viewMode.value);
  applyViewMode(els.viewMode.value);
});

els.includeNoDue.addEventListener("change", () => {
  localStorage.setItem(NODUE_KEY, els.includeNoDue.checked ? "1" : "0");
  if (currentTasks.length) renderGantt(currentTasks);
});

els.defaultDuration.addEventListener("change", () => {
  localStorage.setItem(DEFAULT_DUR_KEY, els.defaultDuration.value);
  if (currentTasks.length) renderGantt(currentTasks);
});

initGantt();
if (savedToken) loadProjects();

// ---------- dhtmlxGantt setup ----------

function initGantt() {
  gantt.config.date_format = "%Y-%m-%d %H:%i";
  gantt.config.drag_links = true;
  gantt.config.drag_move = true;
  gantt.config.drag_resize = true;
  gantt.config.drag_progress = false;
  gantt.config.show_links = true;
  gantt.config.details_on_dblclick = false;
  gantt.config.details_on_create = false;
  gantt.config.row_height = 36;
  gantt.config.bar_height = 24;
  gantt.config.fit_tasks = true;
  gantt.config.auto_scheduling = false;
  gantt.config.open_tree_initially = true;
  gantt.config.show_grid = true;
  gantt.config.grid_width = 260;
  gantt.config.min_column_width = 40;

  gantt.config.columns = [
    { name: "text", label: "Task", tree: true, width: "*", min_width: 150 },
    { name: "start_date", label: "Start", align: "center", width: 80 },
  ];

  gantt.templates.task_class = function (start, end, task) {
    var cls = [];
    if (task.priorityClass) cls.push(task.priorityClass);
    if (task.recurring) cls.push("recurring");
    if (task.noDue) cls.push("no-due");
    if (task.isParent) cls.push("summary-task");
    return cls.join(" ");
  };

  gantt.templates.tooltip_text = function (start, end, task) {
    var src = currentTaskMap.get(String(task.id)) || {};
    var pr = src.priority || 1;
    var labels = (src.labels || []).join(", ") || "\u2014";
    var startStr = (src.due && (src.due.string || src.due.date)) || "No start date";
    var deadlineStr = (src.deadline && src.deadline.date) || null;
    var parts = [
      "<b>" + escapeHtml(task.text) + "</b>",
      "Start: " + escapeHtml(startStr),
    ];
    if (deadlineStr) parts.push("Deadline: " + escapeHtml(deadlineStr));
    parts.push("Priority: P" + (5 - pr), "Labels: " + escapeHtml(labels));
    if (src.description) {
      parts.push(
        '<span style="color:#aaa;font-size:12px">' +
          escapeHtml(src.description.substring(0, 120)) +
          "</span>"
      );
    }
    return parts.join("<br>");
  };

  applyViewMode(els.viewMode.value);

  gantt.attachEvent("onTaskClick", function (id) {
    var raw = currentTaskMap.get(String(id));
    if (raw) openDrawer(raw);
    return true;
  });

  gantt.attachEvent("onTaskDblClick", function () {
    return false;
  });

  gantt.attachEvent("onAfterTaskDrag", function (id) {
    var task = gantt.getTask(id);
    var raw = currentTaskMap.get(String(id));
    if (raw) updateTaskAfterDrag(raw, task);
  });

  gantt.attachEvent("onAfterLinkAdd", function (id, link) {
    writeDependency(String(link.source), String(link.target), id);
  });

  gantt.attachEvent("onAfterLinkDelete", function (id, link) {
    removeDependency(String(link.source), String(link.target));
  });

  try {
    gantt.plugins({ tooltip: true });
  } catch (_) {
    // tooltip plugin may not be available in all editions
  }

  gantt.init("gantt");
  ganttReady = true;
}

function applyViewMode(mode) {
  switch (mode) {
    case "Hour":
      gantt.config.scales = [
        { unit: "day", step: 1, format: "%d %M" },
        { unit: "hour", step: 1, format: "%H:%i" },
      ];
      gantt.config.min_column_width = 40;
      break;
    case "6 Hours":
      gantt.config.scales = [
        { unit: "day", step: 1, format: "%d %M" },
        { unit: "hour", step: 6, format: "%H:%i" },
      ];
      gantt.config.min_column_width = 50;
      break;
    case "12 Hours":
      gantt.config.scales = [
        { unit: "day", step: 1, format: "%d %M" },
        { unit: "hour", step: 12, format: "%H:%i" },
      ];
      gantt.config.min_column_width = 60;
      break;
    case "Day":
      gantt.config.scales = [
        { unit: "month", step: 1, format: "%F %Y" },
        { unit: "day", step: 1, format: "%d" },
      ];
      gantt.config.min_column_width = 30;
      break;
    case "Week":
      gantt.config.scales = [
        { unit: "month", step: 1, format: "%F %Y" },
        { unit: "week", step: 1, format: "W%W" },
      ];
      gantt.config.min_column_width = 60;
      break;
    case "Month":
      gantt.config.scales = [
        { unit: "year", step: 1, format: "%Y" },
        { unit: "month", step: 1, format: "%M" },
      ];
      gantt.config.min_column_width = 50;
      break;
    default:
      gantt.config.scales = [
        { unit: "month", step: 1, format: "%F %Y" },
        { unit: "day", step: 1, format: "%d" },
      ];
      break;
  }
  if (ganttReady) gantt.render();
}

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
    console.info(
      "[Ganttist] no proxy detected, calling api.todoist.com directly"
    );
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
        ? " This is often a CORS or network issue \u2014 try running the included Docker image (which proxies through nginx)."
        : "";
    throw new Error(`Could not reach Todoist (${err.message}).${hint}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Todoist rejected the API token (HTTP " +
        res.status +
        "). Double-check you copied it from Settings \u2192 Integrations \u2192 Developer."
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Todoist API error ${res.status}: ${text || res.statusText}`
    );
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
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDatetime(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${formatDate(d)}T${hh}:${mi}:00`;
}

// ---------- Projects ----------

async function loadProjects() {
  try {
    setStatus("Loading projects\u2026");
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
      '<option value="">\u2014 Add a project \u2014</option>' +
      sorted
        .map(
          (p) =>
            `<option value="${p.id}">${"\u00a0\u00a0".repeat(
              p.depth
            )}${escapeHtml(p.name)}</option>`
        )
        .join("");

    localStorage.setItem(TOKEN_KEY, els.token.value.trim());
    setStatus(`Loaded ${projects.length} projects.`, "success");

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
    addChipDOM(id, nameById ? nameById.get(id) || name : name);
  }
}

function addChipDOM(id, name) {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.dataset.id = id;
  chip.innerHTML =
    `${escapeHtml(name)}` +
    `<button class="chip-remove" aria-label="Remove ${escapeHtml(
      name
    )}" data-id="${escapeHtml(id)}">&times;</button>`;
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
  const chip = els.projectChips.querySelector(
    `.chip[data-id="${CSS.escape(id)}"]`
  );
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
    setStatus("Loading tasks\u2026");
    const batches = await Promise.all(
      activeProjects.map(({ id }) =>
        api(`/tasks?project_id=${encodeURIComponent(id)}`).then(normalizeList)
      )
    );
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
    const word = activeProjects.length === 1 ? "project" : "projects";
    setStatus(
      `Loaded ${merged.length} tasks from ${activeProjects.length} ${word}.`,
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

function taskDurationMs(task) {
  if (task.duration) {
    const mins =
      task.duration.unit === "day"
        ? task.duration.amount * 24 * 60
        : task.duration.amount;
    return mins * 60 * 1000;
  }
  return getDefaultDurationMs();
}

function taskBounds(task, descMeta) {
  const due = task.due;
  const defaultMs = getDefaultDurationMs();

  // Parse due date as bar START (when work begins).
  let startFromDue = null;
  if (due && due.datetime) {
    startFromDue = parseIsoDate(due.datetime);
  } else if (due && due.date) {
    startFromDue = parseIsoDate(`${due.date}T00:00:00`);
  }

  // Parse deadline as bar END (hard deadline).
  let endFromDeadline = null;
  if (task.deadline) {
    if (task.deadline.datetime) {
      endFromDeadline = parseIsoDate(task.deadline.datetime);
    } else if (task.deadline.date) {
      endFromDeadline = parseIsoDate(`${task.deadline.date}T23:59:59`);
    }
  }

  // start: description convention overrides the due-date start.
  let start = null;
  if (descMeta && descMeta.start) {
    start = parseIsoDate(`${descMeta.start}T00:00:00`);
  }
  if (!start) start = startFromDue;

  const end = endFromDeadline;

  // Both start and deadline present.
  if (start && end) {
    if (start >= end) return { start, end: new Date(start.getTime() + defaultMs) };
    return { start, end };
  }

  // Due date only → end = start + (task.duration || default).
  if (start && !end) {
    return { start, end: new Date(start.getTime() + taskDurationMs(task)) };
  }

  // Deadline only → start = end − (task.duration || default).
  if (!start && end) {
    return { start: new Date(end.getTime() - taskDurationMs(task)), end };
  }

  // No date info at all.
  return null;
}

function convertToGanttData(tasks) {
  const data = [];
  const links = [];
  let linkId = 1;

  const parentIds = new Set(
    tasks.map((t) => t.parent_id).filter(Boolean).map(String)
  );

  for (const task of tasks) {
    const descMeta = parseDescription(task.description);
    let bounds = taskBounds(task, descMeta);
    if (!bounds) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      bounds = { start: today, end: new Date(today.getTime() + getDefaultDurationMs()) };
    }

    data.push({
      id: String(task.id),
      text: task.content,
      start_date: bounds.start,
      end_date: bounds.end,
      progress: 0,
      open: true,
      parent:
        task.parent_id && currentTaskMap.has(String(task.parent_id))
          ? String(task.parent_id)
          : 0,
      priorityClass: "priority-p" + (5 - (task.priority || 1)),
      recurring: !!(task.due && task.due.is_recurring),
      noDue: !task.due,
      isParent: parentIds.has(String(task.id)),
    });

    // Dependency arrows from description deps: line.
    for (const depId of descMeta.deps) {
      if (
        currentTaskMap.has(String(depId)) &&
        String(depId) !== String(task.parent_id)
      ) {
        links.push({
          id: String(linkId++),
          source: String(depId),
          target: String(task.id),
          type: "0",
        });
      }
    }
  }

  return { data, links };
}

function clearGantt() {
  els.empty.hidden = false;
  els.gantt.style.display = "none";
  gantt.clearAll();
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
        : "No tasks in the selected projects.",
      "info"
    );
    return;
  }

  els.empty.hidden = true;
  els.gantt.style.display = "block";

  currentTaskMap = new Map(filtered.map((t) => [String(t.id), t]));

  const sorted = [...filtered].sort((a, b) => {
    const ap = a.parent_id ? 1 : 0;
    const bp = b.parent_id ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const ad = (a.due && a.due.date) || "9999-12-31";
    const bd = (b.due && b.due.date) || "9999-12-31";
    return ad.localeCompare(bd);
  });

  const { data, links } = convertToGanttData(sorted);

  gantt.clearAll();
  gantt.parse({ data: data, links: links });
  gantt.showDate(new Date());
}

async function updateTaskAfterDrag(raw, ganttTask) {
  try {
    const dueDatetime = formatDatetime(ganttTask.start_date);
    const deadlineDate = formatDate(ganttTask.end_date);
    setStatus(`Updating "${raw.content}"\u2026`);
    const updated = await api(`/tasks/${raw.id}`, {
      method: "POST",
      body: JSON.stringify({ due_datetime: dueDatetime, deadline_date: deadlineDate }),
    });
    if (updated) {
      const idx = currentTasks.findIndex((t) => String(t.id) === String(raw.id));
      if (idx >= 0) currentTasks[idx] = updated;
      currentTaskMap.set(String(raw.id), updated);
    }
    setStatus(
      `Rescheduled "${raw.content}": start ${dueDatetime}, deadline ${deadlineDate}.`,
      "success"
    );
  } catch (err) {
    setStatus(`Failed to reschedule: ${err.message}`, "error");
    if (activeProjects.length) loadAllTasks();
  }
}

// ---------- Dependency write-back ----------

async function writeDependency(sourceId, targetId, ephemeralLinkId) {
  const target = currentTaskMap.get(targetId);
  if (!target) return;

  const desc = target.description || "";
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
      // Remove the duplicate link dhtmlxGantt just drew.
      gantt.deleteLink(ephemeralLinkId);
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
    setStatus("Adding dependency\u2026");
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
    gantt.deleteLink(ephemeralLinkId);
  }
}

async function removeDependency(sourceId, targetId) {
  const target = currentTaskMap.get(targetId);
  if (!target) return;

  const desc = target.description || "";
  const depsMatch = desc.match(
    /((?:^|\n)\s*(?:deps|depends|depends_on)\s*:\s*)([^\n]+)/i
  );
  if (!depsMatch) return;

  const existing = depsMatch[2]
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const filtered = existing.filter((id) => id !== sourceId);

  let newDesc;
  if (filtered.length) {
    newDesc = desc.replace(
      depsMatch[0],
      `${depsMatch[1]}${filtered.join(", ")}`
    );
  } else {
    // Remove the entire deps: line.
    newDesc = desc.replace(/(?:^|\n)\s*(?:deps|depends|depends_on)\s*:[^\n]*/i, "").trim();
  }

  try {
    setStatus("Removing dependency\u2026");
    const updated = await api(`/tasks/${targetId}`, {
      method: "POST",
      body: JSON.stringify({ description: newDesc }),
    });
    if (updated) {
      const idx = currentTasks.findIndex((t) => String(t.id) === targetId);
      if (idx >= 0) currentTasks[idx] = updated;
    }
    setStatus("Dependency removed.", "success");
  } catch (err) {
    setStatus(`Failed to remove dependency: ${err.message}`, "error");
    renderGantt(currentTasks);
  }
}

// ---------- Task drawer ----------

let drawerTask = null;

function openDrawer(task) {
  drawerTask = task;
  const f = els.drawerForm.elements;
  els.drawerTitle.textContent = task.content;
  f.content.value = task.content;
  f.description.value = task.description || "";
  if (task.due && task.due.datetime) {
    const dt = new Date(task.due.datetime);
    f.due_date.value = formatDate(dt);
    f.due_time.value = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  } else {
    f.due_date.value = (task.due && task.due.date) || "";
    f.due_time.value = "";
  }
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
  return parts.join(" \u2022 ");
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
    if (f.due_time.value) {
      body.due_datetime = `${f.due_date.value}T${f.due_time.value}:00`;
    } else {
      body.due_date = f.due_date.value;
    }
  } else if (drawerTask.due) {
    body.due_string = "no date";
  }
  try {
    setStatus(`Saving "${body.content}"\u2026`);
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
    setStatus("Marking complete\u2026");
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
