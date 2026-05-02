<p align="center">
  <img src="images/logo.svg" alt="Ganttist" width="96" height="96" />
</p>

<h1 align="center">Ganttist</h1>

<p align="center">
  A lightweight, self-hostable Gantt viewer for your
  <a href="https://todoist.com/">Todoist</a> projects. Powered by the current
  Todoist REST API v1 and
  <a href="https://dhtmlx.com/docs/products/dhtmlxGantt/">dhtmlxGantt</a>.
</p>

No backend, no build step, no tracking. Open `index.html` (or run the Docker image) and go.

![Screenshot](images/screenshot.png)

## Features

- Current **Todoist REST API v1** (Bearer token auth)
- Reads native **due dates, datetimes, durations, and recurrence** (no more stuffing `(YYYY-MM-DD)` into task names)
- **Drag a bar** to reschedule a task — writes back to Todoist
- **Click a bar** to open an **in-app side drawer** that edits the task inline (title, description, due date, priority, labels)
- **Mark complete** from the drawer (`POST /tasks/{id}/close`)
- **Open popup window** button — pops out the real Todoist task page in a sized floating window (Todoist forbids iframe embedding, so a popup is the closest "embedded" experience)
- **Drag between bars** to draw a **dependency arrow** — writes back to Todoist via a `deps:` convention in the task description (see below). Delete a link by double-clicking its arrow.
- Bars colored by **priority** (P1–P4); recurring tasks are striped
- **Start dates & dependencies via task description** — Todoist has no native start-date or depends-on field, so Ganttist parses simple conventions (see below)
- **Auto-scrolls to today** so upcoming work dominates the view
- **Multi-project chart** — add multiple projects to see all their tasks on one Gantt chart
- Task list grid with collapsible **parent/subtask hierarchy**
- View modes: **Hour** / 6 Hours / 12 Hours / Day / Week / Month
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
- dhtmlxGantt (GPL v2 Standard Edition) is bundled locally via the Dockerfile

## How bars map to Todoist fields

| Todoist field | Gantt bar edge | Notes |
| --- | --- | --- |
| **Due date / datetime** | **Left edge** (start) | When work begins. In hourly views, the specific time is used. |
| **Deadline** | **Right edge** (end) | Hard deadline. Only used when set in Todoist. |
| **Duration** | **Bar width** | Todoist's native `duration` field (minutes or days). |
| **Default task length** | **Fallback width** | UI control (15 min – 3 days). Used when no duration or deadline is set. Persisted in localStorage. |

Priority chain for the bar's left edge: `start:` in description → `due.datetime` → `due.date` at local midnight.

Priority chain for the bar's right edge: `deadline` → `start + duration` → `start + default task length`.

Parent tasks with subtasks render as darker **summary bars** (bold text, thicker border) so they're visually distinct from leaf tasks.

## Dependencies & description conventions

Todoist has no native dependency field. Ganttist reads simple conventions from the task description:

```
start: 2026-04-10
deps: 7123456789, 7123456790
```

- `start: YYYY-MM-DD` — overrides the due-date start. Pins the bar's left edge to a specific date.
- `deps:` (also accepts `depends:` or `depends_on:`) — comma-or-space-separated list of Todoist task IDs that must finish first. Drawn as arrows between bars. You can grab a task's ID from the drawer's meta line, or from the end of its Todoist URL.

Lines are matched case-insensitively and can appear anywhere in the description. Everything else in the description is left alone.

Parent/subtask relationships are picked up automatically — a subtask always depends on its parent, even without a `deps:` line.

## Known limitations

- Cyclic dependencies will confuse the layout. Don't create `deps:` cycles.
- There's no true zoom-to-fit yet — the view mode selector is the zoom control.
- Todoist's API may return `null` for the `duration` field even when a time range is displayed in the Todoist UI. In that case, the default task length is used.

## Todoist API notes

- Projects: `GET https://api.todoist.com/api/v1/projects`
- Tasks: `GET https://api.todoist.com/api/v1/tasks?project_id=…`
- Update: `POST https://api.todoist.com/api/v1/tasks/{id}` with e.g. `{ "due_datetime": "YYYY-MM-DDTHH:MM:SS" }`
- Complete: `POST https://api.todoist.com/api/v1/tasks/{id}/close`

All calls send `Authorization: Bearer <your-token>`.

The API returns `due.date` as either `"YYYY-MM-DD"` (date-only) or `"YYYY-MM-DDTHH:MM:SS"` (with local time, no timezone suffix). Ganttist detects the format automatically.

### Direct vs. proxied calls

Ganttist works in two modes:

| Mode | When | How requests flow |
| --- | --- | --- |
| **Proxied** (recommended) | Serving via the included Docker image / `nginx.conf` | Browser → `/api/v1/...` → nginx → `api.todoist.com` (no CORS) |
| **Direct** (fallback) | Opening `index.html` via `file://` or a static server without the proxy | Browser → `api.todoist.com` (requires Todoist's CORS to cooperate with your browser) |

The app auto-detects which mode is available when you first click **Load projects**. Check the DevTools console — it logs which base it chose.

## Troubleshooting

**"Could not reach Todoist" / "Failed to fetch"** — almost always CORS or a network/DNS issue, not your token. Fixes, in order:

1. **Use the Docker image.** nginx proxies the API calls, so the browser never has to talk to `api.todoist.com` cross-origin. This eliminates CORS entirely.
2. **Check the DevTools Network tab.** Look for the failed request. If it shows `(failed) CORS error` or `net::ERR_FAILED`, CORS is the issue. If it shows no response at all, check DNS/firewall/VPN.
3. **Disable browser extensions** that block third-party requests (uBlock Origin, Privacy Badger, DuckDuckGo Privacy, etc.) for this page.
4. **Don't use `file://`.** Some browsers (Safari especially) block CORS for file origins. Serve the folder via any static server or run the Docker image.

**"Todoist rejected the API token (HTTP 401/403)"** — the token itself is bad or expired. Copy it fresh from **Settings → Integrations → Developer** in Todoist. The field is a password field, so paste carefully (no trailing whitespace).

**Dragging a bar doesn't reschedule / changes snap back** — usually a permissions issue on a shared project, or the API rejected the payload. Check the console for the actual error message.

## Branding

**Ganttist** is an unaffiliated third-party Todoist client. The wordmark is set in a system serif (Apple's *New York* on macOS/iOS, Georgia elsewhere) paired with a sans-serif UI. The logo and favicon are original marks inspired by the Todoist aesthetic (rounded red square) but redrawn with Gantt-style staggered bars and a subtle vertical gradient so they read as a distinct mark. "Todoist" is a trademark of Doist Ltd.

## License

MIT — see [LICENSE](LICENSE).
