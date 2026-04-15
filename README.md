# Todoist Gantt Chart View

A lightweight, static web app that renders your [Todoist](https://todoist.com/) projects as a Gantt chart — powered by the current Todoist REST API v2 and [Frappe Gantt](https://frappe.io/gantt).

No backend, no build step, no tracking. Open `index.html` and go.

![Screenshot](images/screenshot.png)

## Features

- Works with the **current Todoist REST API v2** (Bearer token auth)
- Reads native **due dates, datetimes, durations, and recurrence** — no more `(YYYY-MM-DD)` hack in task names
- **Drag a bar** to reschedule a task (writes back to Todoist)
- **Click a bar** to open the task in Todoist
- Bars colored by **priority** (P1–P4), recurring tasks are striped
- Project picker with hierarchy and an **"All projects"** view
- View modes: Quarter Day / Half Day / Day / Week / Month
- Optionally include tasks **without a due date**
- Token is stored only in your browser's `localStorage`
- Dark-mode aware (respects `prefers-color-scheme`)

## Usage

1. Open [`index.html`](index.html) in a browser (or serve the folder with any static server).
2. Grab a personal API token from Todoist: **Settings → Integrations → Developer**.
3. Paste it, click **Load projects**, pick a project.
4. Drag bars to reschedule, click to open the task in Todoist.

### Running locally

Because we hit the Todoist API from the browser, just opening the file via `file://` works in most browsers. If your browser blocks CORS for local files, serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Files

- `index.html` — markup
- `js/todoist.js` — the whole app (vanilla ES, ~250 lines)
- `css/style.css` — styling

Frappe Gantt is loaded from jsDelivr.

## Todoist API notes

- Projects: `GET https://api.todoist.com/rest/v2/projects`
- Tasks: `GET https://api.todoist.com/rest/v2/tasks?project_id=…`
- Reschedule: `POST https://api.todoist.com/rest/v2/tasks/{id}` with `{ "due_date": "YYYY-MM-DD" }`

All calls send `Authorization: Bearer <your-token>`.

## License

MIT — see [LICENSE](LICENSE).
