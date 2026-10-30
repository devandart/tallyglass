# Tallyglass

A private dashboard for your Claude Code usage: a tally of your tokens and an hourglass for your 5-hour window. Point it at the transcripts Claude Code keeps on your
computer (`~/.claude/projects`) and it shows:

- **Sessions**: how many, per project, active time, prompts, API calls, ranked by size
- **This session vs. others**: rank, percentile, multiple of the median, context growth per turn
- **Usage limits**: the current 5-hour window (reset time, burn rate, estimate of what's left) and this week
- **Daily usage** by model, **when you work** (weekday × hour), **projects**, **models**, **top tools**
- **API-equivalent cost** at list prices, token mix (input / output / cache write / cache read), caching savings
- **Insights** and a sortable, searchable session table with CSV export

Everything runs in the browser. Files are read locally with the File System Access API (or a folder
`<input>` / drag and drop); nothing is uploaded and there is no backend. Parsed results are cached in
IndexedDB so later rescans only re-read transcripts that changed.

## Use it

1. Open the site (or run it locally, below).
2. Click **Scan my Claude Code history** (it copies the default path for your OS) and pick:
   - Windows: `%USERPROFILE%\.claude\projects`
   - macOS / Linux: `~/.claude/projects` (hidden folder: <kbd>⌘⇧.</kbd> on macOS, <kbd>Ctrl+H</kbd> on Linux)
3. Chrome and Edge remember the folder: next visits open instantly from cache and refresh in the background.
   Firefox and Safari need the folder picked again for a rescan.

`?demo` loads synthetic data, e.g. `https://<host>/?demo`.

## Run locally

Any static file server works (module workers don't load from `file://`):

```bash
python -m http.server 5173
```

Then open http://localhost:5173.

## Deploy

It's a static site with no build step: upload `index.html`, `.htaccess`, `css/` and `js/` to
any static host, e.g. GitHub Pages, Cloudflare Pages, Netlify or a regular web host. Chart.js is loaded
from cdnjs.

Script and style URLs carry a `?v=N` version; `.htaccess` makes browsers revalidate JS/CSS, so updates show without a hard reload.

## How the numbers are computed

- **Tokens** come from the `usage` object of every assistant message in the transcripts:
  input, output, cache writes (5-minute and 1-hour) and cache reads. Claude Code writes one line per
  content block with the same message id, so messages are de-duplicated by message id + request id,
  also across files (resumed and forked sessions copy earlier messages).
- **Subagents** (`<session>/subagents/*.jsonl`) count toward their parent session.
- Totals run a few percent below Claude Code's own `/cost`: background calls such as title generation
  aren't written to transcripts.
- **API-equivalent cost** uses Anthropic's API list prices per model (`js/pricing.js`), including fast
  mode (2×) and web searches. Subscription plans aren't billed per token, so treat it as the value of
  the usage, not a bill.
- **5-hour windows** start at the hour of the first message after the previous window ended and last five
  hours. **Weekly** usage is a rolling 7 days, or since a weekly reset day/hour you set.
- **Budgets / "left"**: Anthropic doesn't publish plan limits as token counts, so the default budget is
  your own busiest 5-hour window and week so far. Set your own values under *Set your own budgets*.
  `/usage` in Claude Code shows the official numbers.
- **Active time** sums the gaps between API calls that are shorter than 10 minutes.
- **Projects** are grouped by working directory; git worktrees under `.claude/worktrees` count toward
  their main project.

## Files

| Path | What it does |
|---|---|
| `js/parse.js` | Streaming parser for one transcript; pre-filters lines before `JSON.parse` |
| `js/scan.worker.js` | Runs the parser in a pool of Web Workers |
| `js/sources.js` | Folder picker, drag & drop, IndexedDB cache, worker pool |
| `js/pricing.js` | Model prices and cost per usage record |
| `js/model.js` | Builds the dataset and computes everything the dashboard shows |
| `js/app.js` | Rendering (Chart.js + HTML) |
| `js/demo.js` | Synthetic demo data |

## License

[GPL-3.0-or-later](LICENSE). Not affiliated with or endorsed by Anthropic; Claude and Claude Code are
trademarks of Anthropic.
