'use strict';
// Classify a visible pane screen for the guarded recover action.
//
// Herdr has no approve API. The only way to get past a permission prompt is to
// read the pane and send the key the prompt expects. That is useful and
// dangerous, so the board and the secretary share one rule set:
//   - a screen must show an allow, approve, continue, proceed or yes prompt;
//   - a screen that mentions a destructive or privileged action is refused;
//   - anything unclear is refused and escalated.

const PROMPT = /\b(allow|approve|approved|permission|continue|proceed|yes)\b/i;
const UNSAFE = /\b(push|force[- ]?push|reset --hard|delete|remove|rm\b|rmdir|chmod|chown|drop\s+table|truncate|kill|install|deploy|commit|secret|credential|\.env|token|password|ssh|scp|rsync)\b/i;
const CONTINUE = /\b(continue|resume|proceed)\b/i;

function classifyScreen(text) {
  const clean = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return { action: null, safe: false, reason: 'pane is empty' };
  if (!PROMPT.test(clean)) return { action: null, safe: false, reason: 'no allow or continue prompt' };
  if (UNSAFE.test(clean)) return { action: 'allow', safe: false, reason: 'prompt mentions a destructive or privileged action' };
  return {
    action: CONTINUE.test(clean) && !/\ballow|approve|permission\b/i.test(clean) ? 'continue' : 'allow',
    safe: true,
    reason: 'prompt looks safe',
  };
}

module.exports = { classifyScreen, PROMPT, UNSAFE, CONTINUE };
