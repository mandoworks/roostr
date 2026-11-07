#!/bin/sh
# An Antigravity (agy) statusline that also reports to crew-board.
#
#   ~/.gemini/antigravity-cli/settings.json:
#   "statusLine": { "type": "command", "command": "sh /path/to/agy-statusline.sh" }
#
# crew-board must be on PATH. It only reports inside a Herdr pane
# (HERDR_PANE_ID is set there), runs in the background, and prints nothing.
input=$(cat)

# ---- crew-board: paste this block into your own statusline script ----
if [ -n "${HERDR_PANE_ID:-}" ] && command -v crew-board >/dev/null 2>&1; then
  printf '%s' "$input" | crew-board report --pane "$HERDR_PANE_ID" --from agy >/dev/null 2>&1 &
fi
# ---- end of crew-board block ----

# The statusline text itself. To keep a statusline you already have, pass
# the input on to it instead, for example:
#   printf '%s' "$input" | node /path/to/your-statusline.js
printf 'agy'
