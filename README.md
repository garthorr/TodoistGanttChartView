<p align="center">
  <img src="images/logo.svg" alt="Ganttist" width="96" height="96" />
</p>

<h1 align="center">Ganttist</h1>

<p align="center">
  A lightweight, self-hostable Gantt viewer for your
  <a href="https://todoist.com/">Todoist</a> projects. Powered by the current
  Todoist REST API v2 and
  <a href="https://frappe.io/gantt">Frappe Gantt</a>.
</p>

No backend, no build step, no tracking. Open `index.html` (or run the Docker image) and go.

![Screenshot](images/screenshot.png)

## Features

- Current **Todoist REST API v2** (Bearer token auth) — no more dead v1 endpoints
- Reads native **due dates, datetimes, durations, and recurrence** (no more stuffing `(YYYY-MM-DD)` into task names)
- **Drag a bar** to reschedule a task — writes back to Todoist
- **Click a bar** to open an **in-app side drawer** that edits the task inline (title, description, due date, priority, labels)
- **Mark complete** from the drawer (`POST /tasks/{id}/close`)
- **Open popup window** button — pops out the real Todoist task page in a sized floating window (Todoist forbids iframe embedding, so a popup is the closest "embedded" experience)
- Bars colored by **priority** (P1–P4); recurring tasks are striped
- Project picker with hierarchy and an **"All projects"** view
- View modes: Quarter Day / Half Day / Day / Week / Month
- Optionally include tasks **without a due date**
- Token is stored only in your browser's `localStorage`
- **Dark-mode aware** (respects `prefers-color-scheme`)
- Custom logo + SVG favicon

## Usage

1. Open [`index.html`](index.html) in a browser (or serve the folder with any static server).
2. Grab a personal API token from Todoist: **Settings → Integrations → Developer**.
3. Paste it, click **Load projects**, pick a project.
4. Drag bars to reschedule, click a bar to edit in the drawer, or pop it out into a Todoist window.

### Running locally

Because all calls happen in the browser, opening the file via `file://` works in most browsers. If your browser blocks CORS for local files, serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

### Running with Docker (self-hosted)

A `Dockerfile` and `docker-compose.yml` are included. The image is a ~25 MB `nginx:alpine` serving the static files with gzip, cache headers, and a locked-down Content Security Policy.

```bash
# build + run
docker compose up -d --build

# then visit http://localhost:8080
```

Or without compose:

```bash
docker build -t ganttist .
docker run -d --name ganttist -p 8080:80 --restart unless-stopped ganttist
```

Put it behind your own reverse proxy (Caddy, Traefik, nginx) by pointing the proxy at the container on port 80. No environment variables are needed — the app runs entirely in the user's browser and never sees the Todoist token.

## Files

- `index.html` — markup
- `js/todoist.js` — the whole app (vanilla ES, ~450 lines)
- `css/style.css` — styling, dark-mode aware
- `images/logo.svg`, `images/favicon.svg` — custom mark (Gantt-bars in a rounded red square, derivative rather than a copy of the Todoist logo)
- `Dockerfile`, `nginx.conf`, `docker-compose.yml` — self-hosting
- Frappe Gantt is loaded from jsDelivr

## Todoist API notes

- Projects: `GET https://api.todoist.com/rest/v2/projects`
- Tasks: `GET https://api.todoist.com/rest/v2/tasks?project_id=…`
- Update: `POST https://api.todoist.com/rest/v2/tasks/{id}` with e.g. `{ "due_date": "YYYY-MM-DD" }`
- Complete: `POST https://api.todoist.com/rest/v2/tasks/{id}/close`

All calls send `Authorization: Bearer <your-token>`.

## Branding

**Ganttist** is an unaffiliated third-party Todoist client. The wordmark is set in a system serif (Apple's *New York* on macOS/iOS, Georgia elsewhere) paired with a sans-serif UI. The logo and favicon are original marks inspired by the Todoist aesthetic (rounded red square) but redrawn with Gantt-style staggered bars and a subtle vertical gradient so they read as a distinct mark. "Todoist" is a trademark of Doist Ltd.

## License

MIT — see [LICENSE](LICENSE).
