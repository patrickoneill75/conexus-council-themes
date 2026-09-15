# Conexus Council Themes

A navigation wrapper around the Power BI dashboard, plus a Council Themes tab built from
each quarter's post-meeting survey.

- **Dashboard** — `public/index.html`. Buttons across the top switch Power BI pages
  without the native page tabs. Public; no login.
- **Control panel** — `public/admin.html`. Log in with Box, upload a quarter's raw survey
  export, and analyze it.
- **Analysis** — GitHub Actions, triggered from the panel. Claude extracts "areas to
  improve" items from the survey's free-response answers, appends them to a running
  tracker spreadsheet in Box, then reads that tracker's history to synthesize the
  quarter's top issues plus what's recurred quarter-over-quarter and year-over-year.
  Writes `public/council-themes.json`, commits.

Year / Quarter / Region are set explicitly in the panel when a survey is uploaded —
nothing is parsed from a filename.

Setup is in [SETUP.md](SETUP.md). Everything is done in a browser.
