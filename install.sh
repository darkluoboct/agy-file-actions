#!/usr/bin/env sh
set -eu

SRC="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DST="${HOME}/.gemini/config/plugins/agy-file-actions"

echo "Installing agy-file-actions to ${DST} ..."
rm -rf "${DST}"
mkdir -p "${DST}"

cp "${SRC}/plugin.json" "${SRC}/mcp_config.json" "${SRC}/README.md" "${SRC}/LICENSE" "${DST}/"
cp -R "${SRC}/assets" "${SRC}/mcp" "${SRC}/sidecars" "${DST}/"

echo "Done. Settings in ${HOME}/.gemini/config/agy-file-actions/settings.json are preserved."
