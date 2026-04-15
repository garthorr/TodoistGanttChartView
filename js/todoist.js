/**
 * Todoist Gantt Chart — modernized.
 *
 * Uses the Todoist REST API v2 (Bearer token, JSON) and Frappe Gantt.
 * No jQuery, no build step, no server needed.
 */

const API_BASE = "https://api.todoist.com/rest/v2";
const TOKEN_KEY = "todoist_gantt_token";
const DAY_MS = 24 * 60 * 60 * 1000;

const els = {
  token: document.getElementById("auth_token"),
  loadProjects: document.getElementById("load_projects"),
  projects: document.getElementById("projects"),
  viewMode: document.getElementById("view_mode"),
  includeNoDue: document.getElementById("include_nodue"),
  status: document.getElementById("status"),
  empty: document.getElementById("empty-state"),
  gantt: document.getElementById("gantt"),
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

async function api(path, options = {}) {
  const token = els.token.value.trim();
  if (!token) throw new Error("Please paste your Todoist API token first.");

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

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Invalid API token. Double-check it and try again.");
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
    const projects = await api("/projects");

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
    const tasks = await api(path);
    currentTasks = tasks;
    renderGantt(tasks);
    setStatus(`Loaded ${tasks.length} tasks.`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

function taskBounds(task) {
  const due = task.due;
  let end;
  if (due && due.datetime) {
    end = new Date(due.datetime);
  } else if (due && due.date) {
    end = new Date(`${due.date}T23:59:59`);
  } else {
    return null; // no due date
  }

  let start;
  if (task.duration) {
    const minutes =
      task.duration.unit === "day"
        ? task.duration.amount * 24 * 60
        : task.duration.amount;
    start = new Date(end.getTime() - minutes * 60 * 1000);
  } else if (task.created_at) {
    start = new Date(task.created_at);
  } else {
    start = new Date(end.getTime() - DAY_MS);
  }

  if (start >= end) start = new Date(end.getTime() - DAY_MS);
  // Frappe Gantt needs at least 1 day visible.
  if (end - start < DAY_MS) start = new Date(end.getTime() - DAY_MS);
  return { start, end };
}

function toGanttTask(task, taskMap) {
  let bounds = taskBounds(task);
  if (!bounds) {
    // For tasks with no due date: park them on today.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    bounds = { start: today, end: new Date(today.getTime() + DAY_MS) };
  }

  const priorityClass = `priority-p${5 - (task.priority || 1)}`;
  const recurringClass = task.due && task.due.is_recurring ? " recurring" : "";
  const noDueClass = !task.due ? " no-due" : "";

  const dependencies =
    task.parent_id && taskMap.has(task.parent_id) ? String(task.parent_id) : "";

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

  const taskMap = new Map(filtered.map((t) => [t.id, t]));

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
    on_click: (task) => {
      const src = task._task;
      if (src && src.url) window.open(src.url, "_blank", "noreferrer");
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
          ${src.url ? `<div><a href="${src.url}" target="_blank" rel="noreferrer">Open in Todoist</a></div>` : ""}
        </div>`;
    },
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
    task.due = { ...(task.due || {}), date: due_date, is_recurring: false };
    setStatus(`Rescheduled "${task.content}" to ${due_date}.`, "success");
  } catch (err) {
    setStatus(`Failed to reschedule: ${err.message}`, "error");
    // Re-render to snap bar back to real date.
    if (currentProjectId) loadTasks(currentProjectId);
  }
}
