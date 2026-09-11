# Conexus Council Themes

A navigation wrapper around the Power BI dashboard, plus a Council Themes tab built from
Word documents in Box.

- **Dashboard** — `public/index.html`. Buttons across the top switch Power BI pages
  without the native page tabs. Public; no login.
- **Control panel** — `public/admin.html`. Log in with Box, choose the folder holding the
  meeting documents, click Refresh and publish.
- **Refresh** — `scripts/run_refresh.py`, run by GitHub Actions. Reads the folder, pulls
  headings and bullets out of each `.docx`, writes `public/themes.json`, commits.

Documents are named `2026-Q2-Central.docx` — the Q2 2026 Central Council meeting. The
filename is what drives the Year / Quarter / Council filters.

Setup is in [SETUP.md](SETUP.md). Everything is done in a browser.
