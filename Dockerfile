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
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
