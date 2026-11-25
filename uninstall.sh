#!/usr/bin/env sh
set -eu

DST="${HOME}/.gemini/config/plugins/agy-file-actions"
if [ -d "${DST}" ]; then
  echo "Removing ${DST} ..."
  rm -rf "${DST}"
  echo "Uninstalled agy-file-actions."
else
  echo "agy-file-actions is not installed at ${DST}."
fi
echo "Note: User settings in ${HOME}/.gemini/config/agy-file-actions/settings.json were kept."
