#!/bin/sh
# An Antigravity (agy) statusline that also reports to roostr.
#
#   ~/.gemini/antigravity-cli/settings.json:
#   "statusLine": { "type": "command", "command": "sh /path/to/agy-statusline.sh" }
#
# roostr must be on PATH (crew-board remains supported as a legacy alias). It only
# reports inside a Herdr pane (HERDR_PANE_ID is set there), runs in the
# background, and prints nothing.
input=$(cat)

# ---- roostr: paste this block into your own statusline script ----
if [ -n "${HERDR_PANE_ID:-}" ]; then
  if command -v roostr >/dev/null 2>&1; then
    printf '%s' "$input" | roostr report --pane "$HERDR_PANE_ID" --from agy >/dev/null 2>&1 &
  elif command -v crew-board >/dev/null 2>&1; then
    printf '%s' "$input" | crew-board report --pane "$HERDR_PANE_ID" --from agy >/dev/null 2>&1 &
  fi
fi
# ---- end of roostr block ----

# The statusline text itself. To keep a statusline you already have, pass
# the input on to it instead, for example:
#   printf '%s' "$input" | node /path/to/your-statusline.js
printf 'agy'
