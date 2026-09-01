#!/bin/sh
# Runs from /docker-entrypoint.d before nginx starts. Serves /branding.json
# from /tmp (the only writable path under the hardened setup): generated from
# BRAND_* environment variables when any are set, otherwise a copy of the
# baked-in or bind-mounted file.
set -eu

html=/usr/share/nginx/html
out=/tmp/branding.json

esc() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ -n "${BRAND_NAME:-}${BRAND_TAGLINE:-}${BRAND_LOGO:-}${BRAND_ACCENT:-}" ]; then
  cat > "$out" <<JSON
{
  "name": "$(esc "${BRAND_NAME:-PST Viewer}")",
  "tagline": "$(esc "${BRAND_TAGLINE:-Local · Offline · Private}")",
  "logo": "$(esc "${BRAND_LOGO:-}")",
  "accent": "$(esc "${BRAND_ACCENT:-}")"
}
JSON
else
  cp "$html/branding.json" "$out"
fi
