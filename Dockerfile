# Ganttist — static Gantt viewer for Todoist, served by nginx.
# Two-stage build:
#   stage 1  downloads dhtmlxGantt (GPL v2) from the official CDN
#   stage 2  is the final nginx:alpine image with everything bundled locally
# Bundling eliminates all runtime CDN dependencies and CDN-blocking issues.

FROM alpine:3.20 AS vendor
RUN apk add --no-cache curl ca-certificates
RUN curl -fsSL -o /dhtmlxgantt.js  "https://cdn.dhtmlx.com/gantt/edge/dhtmlxgantt.js" && \
    curl -fsSL -o /dhtmlxgantt.css "https://cdn.dhtmlx.com/gantt/edge/dhtmlxgantt.css"

FROM nginx:1.27-alpine

# Replace the default site config with ours (gzip + sane cache headers).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the static assets.
COPY index.html /usr/share/nginx/html/index.html
COPY css/    /usr/share/nginx/html/css/
COPY js/     /usr/share/nginx/html/js/
COPY images/ /usr/share/nginx/html/images/

# Install dhtmlxGantt vendor files downloaded in the first stage.
COPY --from=vendor /dhtmlxgantt.js  /usr/share/nginx/html/js/dhtmlxgantt.js
COPY --from=vendor /dhtmlxgantt.css /usr/share/nginx/html/css/dhtmlxgantt.css

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
