# Conexus Council Themes

A navigation wrapper around the Power BI dashboard, plus a Council Themes tab and a
Survey Benchmarking tab, both built from each meeting's post-meeting survey.

- **Dashboard** — `public/index.html`. Buttons across the top switch Power BI pages
  without the native page tabs. Public; no login.
- **Control panel** — `public/admin.html`. Log in with Box, upload the two raw survey
  exports, and update the dashboards.
- **Analysis** — GitHub Actions, triggered from the panel. Update Dashboard reads the
  Council Meeting Helper and Post-Meeting Survey exports out of Box, auto-detects which
  meetings aren't published yet (by comparing against `data/feedback_log.json`, the
  running history of every extracted feedback item), and for each new one: Claude
  extracts "areas to improve" items from the survey's free-response answers, they're
  appended to the Feedback Log, and Claude synthesizes that quarter's top issues plus
  what's recurred quarter-over-quarter and year-over-year. Writes
  `public/council-themes.json` and `public/quant-dashboard.json`, commits.

Year / Quarter / Region are never entered by hand: each meeting's Post-Meeting Survey
responses are resolved to a meeting by their Meeting Date, and Year/Quarter/Region come
from the matching row in the Council Meeting Helper export. Both exports are cumulative
(each fresh export already contains every meeting/response ever collected), so
uploading either one replaces the previous version in Box wholesale.

Setup is in [SETUP.md](SETUP.md). Everything is done in a browser.
