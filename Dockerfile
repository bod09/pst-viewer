# Build the static app
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve it. The unprivileged base runs as non-root on 8080 and writes only to
# /tmp, so the container supports --read-only and --cap-drop ALL (see DEPLOY.md).
FROM docker.io/nginxinc/nginx-unprivileged:alpine
# Fixed worker count instead of one per CPU core: plenty for static files, and
# keeps the process count independent of host size (the compose file caps pids).
RUN sed -i 's/worker_processes  auto;/worker_processes  8;/' /etc/nginx/nginx.conf \
    && grep -q 'worker_processes  8;' /etc/nginx/nginx.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
