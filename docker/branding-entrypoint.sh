#!/bin/sh
# Runs from /docker-entrypoint.d before nginx starts. The container filesystem
# is immutable, so branding is regenerated from the BRAND_* environment
# variables on every start (into /tmp, the only writable path under the
# hardened setup); with no variables set, the baked-in or bind-mounted files
# are used as-is. nginx serves /branding.json and /manifest.webmanifest from
# these copies.
set -eu

html=/usr/share/nginx/html

esc() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ -n "${BRAND_NAME:-}${BRAND_TAGLINE:-}${BRAND_LOGO:-}${BRAND_ACCENT:-}${BRAND_THEME:-}" ]; then
  cat > /tmp/branding.json <<JSON
{
  "name": "$(esc "${BRAND_NAME:-PST Viewer}")",
  "tagline": "$(esc "${BRAND_TAGLINE:-Local · Offline · Private}")",
  "logo": "$(esc "${BRAND_LOGO:-}")",
  "accent": "$(esc "${BRAND_ACCENT:-}")",
  "theme": "$(esc "${BRAND_THEME:-}")"
}
JSON
else
  cp "$html/branding.json" /tmp/branding.json
fi

# Rename the installable app (manifest name/short_name) to match BRAND_NAME.
# Installed copies pick the new name up on a later launch.
if [ -n "${BRAND_NAME:-}" ]; then
  n=$(esc "$BRAND_NAME")
  sed "s/\"name\":\"PST Viewer\"/\"name\":\"$n\"/; s/\"short_name\":\"PST Viewer\"/\"short_name\":\"$n\"/" \
    "$html/manifest.webmanifest" > /tmp/manifest.webmanifest
else
  cp "$html/manifest.webmanifest" /tmp/manifest.webmanifest
fi
