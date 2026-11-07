# web/: rules for the agent building crewboard.mando.works

Read `PLAN.md` in this folder first and build exactly that. It holds the design, the content, the SEO, and the quality floor. Do not re-decide what it settles; if something in it is wrong or impossible, write it in your report and keep going with the closest thing that works.

## Scope

- Work only inside `web/`. Read anything in the repo (the README and `src/board.js` are your sources of truth for what crew-board does), but do not edit files outside `web/`.
- `web/tools/render-frames.js` may require `../../src/board` and `../../src/ui` to render real frames. It must not change them.
- No npm dependencies, no `package.json`, no bundler, no framework. Plain HTML, CSS, and JS. Google Fonts are the only external resource.

## Writing

- Prose and copy: no em dashes, and no hyphen used to divide clauses. Use commas, colons, periods, parentheses. `../verify.sh` checks the repo for em dashes and machine paths.
- No machine specific paths (your home folder, user names), private names, or secrets anywhere. Neutral example names only (the ones in PLAN.md).
- Sentence case. Every claim on the page must be true of the code in this repo.

## Checking your work

- Open `index.html` directly and over a local server (`python3 -m http.server -d web 8080`) and check: no console errors, the replay plays and pauses, reduced motion shows the static frame, 360 px wide has no page side scroll, keyboard focus is visible.
- Run Lighthouse (Chrome DevTools or `npx lighthouse` if you have it; do not add it to the repo) and note the four scores in your report.
- Run `../verify.sh` from the repo root before you finish; it must end with ALL CHECKS PASSED.

## Git and deploy

- Do not commit, push, or deploy. Do not create a Vercel project or touch DNS. The lead reviews, commits, and deploys.
- When done, write `web/.scratch-report.md` (gitignored by the repo's `.scratch-*` rule): what you built, deviations from PLAN.md and why, Lighthouse scores, anything left open. End it with a line `DONE`.
