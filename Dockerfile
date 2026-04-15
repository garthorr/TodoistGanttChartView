# Ganttist — static Gantt viewer for Todoist, served by nginx.
# There's no build step (no bundler, no package.json), so a single-stage
# image is enough. Image size is ~25 MB.

FROM nginx:1.27-alpine

# Replace the default site config with ours (gzip + sane cache headers).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the static assets.
COPY index.html /usr/share/nginx/html/index.html
COPY css/    /usr/share/nginx/html/css/
COPY js/     /usr/share/nginx/html/js/
COPY images/ /usr/share/nginx/html/images/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
