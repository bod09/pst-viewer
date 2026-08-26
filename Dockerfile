# Build the static app
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve it with the unprivileged nginx image: runs as a non-root user (101),
# listens on 8080, and only ever writes to /tmp - so the container works with
# a read-only root filesystem and every capability dropped (see DEPLOY.md).
FROM docker.io/nginxinc/nginx-unprivileged:alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
