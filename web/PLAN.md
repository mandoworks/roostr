# crewboard.mando.works: plan

A one page site for crew-board, the Herdr plugin. It goes live on launch day, when the GitHub repo turns public, so every GitHub link on it resolves.

## Job of the page

- **Who lands here:** developers who run several AI coding agents at once (Claude Code, opencode, kilo, Antigravity, Codex) in terminal panes, most of them from a launch post, a GitHub link, or a search.
- **What they must get in ten seconds:** this is a live board in the terminal that shows every agent pane at once: who is working, who is stuck waiting for you, what each one is doing, and what it costs.
- **What they do next:** copy `herdr plugin install mandoworks/crew-board`, or go to the GitHub repo.

## The one memorable thing: the real board, live, on a whiteboard

The hero is the board itself, not a screenshot and not a mockup: real frames rendered by crew-board's own code, played back in the browser. A pane flips from working to blocked, the red banner appears, its timer counts up, the detail box opens, the today view's bars fill in. Everything else on the page stays quiet so this carries the page.

The visual idea around it comes from the name: a crew board is the whiteboard on a workshop or kitchen wall that says who is on what. The page is that whiteboard. The board sits on it like a screen, and the page's annotations are marker notes and hand drawn arrows pointing at real parts of the board. The coloured squares crew-board gives each pane (🟦 🟩 🟨 🟪 🟧) are the whiteboard's magnets.

## Tokens

Colour (cool whiteboard, not cream, not black):

| name | hex | use |
| --- | --- | --- |
| board white | `#F6F8FA` | page background |
| frame grey | `#C9D1DB` | whiteboard frame, rules |
| marker black | `#1C2230` | body text, headings |
| marker blue | `#2557C7` | links, annotations, the install button |
| marker red | `#C9302C` | anything about blocked or over budget, used rarely |
| terminal | `#1B1F27` | the board's screen only |

The board's own terminal colours come from its renderer (see Build), unchanged.

Type:
- **Familjen Grotesk** (Google Fonts) for everything outside the terminal: headings at weight 600 to 700, body at 400. One family, sized on a clear scale (16, 20, 28, 44, 64 px on desktop; the 64 only in the hero headline).
- **JetBrains Mono** (Google Fonts) only inside the rendered board and code blocks, because that is terminal content. Never for labels.
- Sentence case everywhere. No all caps labels, no eyebrow labels above headings, no single accented word in a headline.

Shape: the whiteboard has one frame (2 px `frame grey`, 12 px radius, subtle inner shadow so it reads as a surface). Inside it nothing gets cards; content sits directly on the board. Buttons and the install field are the only rounded controls (6 px).

## Layout

Left aligned text, a 72 character measure for prose. Desktop wireframe:

```
┌ whiteboard frame ─────────────────────────────────────────────────┐
│ crew-board                                   GitHub   Install      │
│                                                                    │
│ See every coding agent                                             │
│ at a glance.                       ┌ terminal ─────────────────┐   │
│                                    │ live board replay          │   │
│ A live board for Herdr: who is     │ (working ▸ blocked,       │   │
│ working, who waits for you, what   │  banner, detail box,      │   │
│ each one does, what it costs.      │  today view)              │   │
│                                    └───────────────────────────┘   │
│ [ herdr plugin install mandoworks/crew-board ][copy]               │
│                                                                    │
│ ── what you are looking at ─────────────────────────────────────── │
│   one large static frame of the board with marker arrows and       │
│   short notes on: status and time in status, the blocked banner,   │
│   context / tokens / cost, the task line, the usage bars with      │
│   ⚡ pace and ⚠ forecast                                            │
│                                                                    │
│ the detail box (frame + 2 sentences)   the today view (frame + 2)  │
│                                                                    │
│ Works with: Claude Code · opencode · kilo · Antigravity · Codex    │
│ (plain text names, no logos), tokscale credit                      │
│                                                                    │
│ Set up in three steps (a real sequence, so numbered is right)      │
│ 1 install  2 open the board  3 optional: statusline for exact data │
│                                                                    │
│ Safe by default: the crew file asks before it runs anything; one   │
│ network request a day (the update check); MIT; no telemetry        │
│                                                                    │
│ footer: GitHub · README · MIT · made by Mando Works · Herdr        │
└────────────────────────────────────────────────────────────────────┘
```

Mobile: one column; the replay comes right after the headline and before the paragraph; the terminal scrolls sideways inside its own box (never the page), with the board rendered at 100 columns.

## Content (draft, edit for clarity, keep the meaning)

- Headline: "See every coding agent at a glance."
- Sub: "crew-board is a live board for Herdr. One row per agent pane: who is working, who is waiting for you, what each one is doing, and what it costs."
- Install: `herdr plugin install mandoworks/crew-board`, a copy button that says "Copy" then "Copied".
- Annotations on the big frame, one line each:
  - "Blocked panes jump to the top in red, with how long they have waited."
  - "Context, tokens and cost per agent, exact from a statusline or read from the screen. Unknown stays ?, never guessed."
  - "The task line: what each agent is on, from its label, a report, or its title."
  - "Your plan's 5 hour and weekly limits, with the burn rate and when you will run out."
- Detail box: "Click a row for its goal, next steps, and today's in, out and cache."
- Today view: "Press d for the day: spend per agent, each hour stacked by agent, and the busiest sessions. Data from tokscale by Junho Yeo." Link tokscale.
- Works with: Claude Code, opencode, kilo, Antigravity (agy), Codex usage limits. Names only.
- Steps: (1) Install the plugin. (2) Run "crew-board: toggle board" from Herdr's actions, or bind it to a key. (3) Optional: add the statusline snippet from the README for exact numbers.
- Safety: "A crew file runs commands, so the board asks before it runs a new or changed one. The only network request is a daily check for a new release. MIT licensed."

Every claim must be true of the code in this repo; check against the README when unsure.

## Build

- Static: `index.html`, `style.css`, `board.js` (the replay), `frames.json`, `og.png`, `favicon.svg`, `robots.txt`, `sitemap.xml`. No framework, no bundler, no npm dependencies, no build step for the site itself.
- Real frames: `tools/render-frames.js` (plain Node, run by hand) requires `../../src/board` and `../../src/ui`, builds a neutral model (copy the shape of `sample()` in `test/board.test.js`: workspaces `example-app` and `site`, panes `docs`, `api`, `tests`, `helper`, `copy`), renders it with colour on at width 100 through `board.render(model, { … })` for each step of the story (rows, a pane going blocked, the detail box open, the today view with a made up tokscale and hourly model), and converts the ANSI output (SGR only: bold, 38;5;N, 48;5;N, 7 reverse, resets) to HTML spans with a 256 colour table. It writes `frames.json`. The page never runs crew-board code; it plays the JSON.
- The replay: a `<pre>` per frame inside the terminal box; JS swaps frames on a timer (about 2.5 s per step, the blocked timer ticking each second). Pause on hover and on focus. `prefers-reduced-motion`: show one rich static frame (the blocked banner and the detail box) and no timer.
- `og.png` 1200 x 630: the whiteboard with the board frame, rendered once by hand with the system Chrome (`--headless --screenshot`) from a small `tools/og.html`. Commit the PNG.
- Fonts from Google Fonts with `display=swap`, preconnect, only the weights used.
- Budget: HTML + CSS + JS + frames.json under 150 KB before fonts. Lighthouse 95+ on all four scores.

## SEO

- `<title>crew-board: a live board for every AI coding agent in Herdr</title>`
- Meta description (about 150 characters): "See every Claude Code, opencode, kilo and Antigravity pane at once: status, blocked alerts, context, tokens, cost and usage limits. A free Herdr plugin."
- Canonical `https://crewboard.mando.works/`; Open Graph (title, description, `og.png`, url, type website) and Twitter `summary_large_image`.
- JSON-LD `SoftwareApplication`: name, description, `applicationCategory` DeveloperApplication, `operatingSystem` "macOS, Linux", `offers` price 0, `license` MIT URL, `codeRepository` and `url`, `author` Organization "Mando Works".
- One `h1` (the headline), `h2` per section, descriptive link text, `alt` text on images, `lang="en"`.
- The words people search with appear naturally in headings and copy: Claude Code, opencode, multiple AI coding agents, terminal dashboard, Herdr plugin, token usage, usage limits. No keyword stuffing.
- `robots.txt` allowing all with the sitemap URL; `sitemap.xml` with the one page.

## Quality floor

Responsive to 360 px wide with no page side scroll; visible keyboard focus; every colour pair passes WCAG AA (check marker blue on board white, and the terminal colours); reduced motion respected; works with JS off (a static frame is in the HTML, the replay enhances it); no console errors.

## Hosting (the lead does this, not the builder)

Static on Vercel with `web/` as the project root, `crewboard.mando.works` as its domain, a Cloudflare DNS record pointing at Vercel (DNS only, not proxied). Live on launch day, after the repo is public.
