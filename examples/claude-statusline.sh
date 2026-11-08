#!/bin/sh
# A Claude Code statusline that also reports exact usage to roostr.
#
#   ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "sh /path/to/claude-statusline.sh" }
#
# roostr must be on PATH (crew-board remains supported as a legacy alias). Node is only used by the example text below, so
# no jq is needed. It only reports inside a Herdr pane (HERDR_PANE_ID is set
# there), runs in the background, and prints nothing, so it never slows or
# changes your statusline.
input=$(cat)

# ---- roostr: paste this block into your own statusline script ----
if [ -n "${HERDR_PANE_ID:-}" ]; then
  if command -v roostr >/dev/null 2>&1; then
    printf '%s' "$input" | roostr report --pane "$HERDR_PANE_ID" --from claude >/dev/null 2>&1 &
  elif command -v crew-board >/dev/null 2>&1; then
    printf '%s' "$input" | crew-board report --pane "$HERDR_PANE_ID" --from claude >/dev/null 2>&1 &
  fi
fi
# ---- end of roostr block ----

# The statusline text itself. Replace with your own.
printf '%s' "$input" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");const m=j.model&&(j.model.display_name||j.model.id);const c=j.context_window&&j.context_window.used_percentage;const t=j.cost&&j.cost.total_cost_usd;console.log(`${m==null?"?":m} | ctx:${c==null?"?":c}% | $${t==null?"?":t}`);});'
