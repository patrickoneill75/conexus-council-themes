# Setup

"Connector": a Cloudflare Worker serves `public/` and handles `/api/*`, every mini
app's control panel logs in with Box and picks a folder, and a GitHub Actions run does
the reading and publishing for each one. Nothing secret ever reaches the browser, and
every mini app signs in through the same admin-account system -- there is no
per-app password anywhere any more.

Everything below is done in a browser. There are no terminal steps.

---

## What you end up with

Every mini app follows the same convention: its public-ready page lives at its own
base path (`/<id>`), and its control panel always lives at `/<id>/control-panel` --
gated by the shared admin accounts, never a password of its own.

| Piece | Where it lives | What it does |
| --- | --- | --- |
| `public/index.html` | Worker static assets | The **public grid** -- Connector's own front door. Reads `public/apps.js` and each app's current visibility tier and shows a tile only for the ones set to "Public". No login, no control-panel links. |
| `public/apps.js` | Worker static assets | The one shared registry of every mini app (id, name, description, base URL, control panel URL) -- read by both the public grid and the admin hub. Add a new mini app here once. |
| `public/admin/` | Worker static assets | The admin hub: sign-in (`login.html`), the grid of *every* mini app regardless of visibility (`index.html`), and Settings (`settings.html`) -- admin accounts plus each app's visibility tier. See **8 · The admin hub** below. |
| `src/beta_auth.js` | Cloudflare Worker | `/api/beta/*`. Multi-user admin accounts (signup, sign-in, password reset, the admin list) and the per-app visibility tiers every mini app's own page reads via `public/tier-gate.js`. |
| `public/tier-gate.js` | Worker static assets | Included by every mini app's public base page. Redirects to sign-in when that app's tier is "Admin-only" and there's no session; otherwise reveals the page immediately. |
| `public/council-data/` | Worker static assets | Council Themes/Quant: the public dashboard (`index.html`, Power BI pages plus the Council Themes tab) and its control panel (`control-panel/index.html` -- Helper/Survey upload, Update Dashboard, the Meetings table, Box login and the Data Folder picker under Developer). See **5 · Connect Box and set up the panel** below. |
| `src/council_data.js` | Cloudflare Worker | `/api/council-data/*`. Everything the Council Themes/Quant control panel does, gated by the shared admin accounts via `requireBetaAuth` -- no password of its own. |
| `src/worker.js` | Cloudflare Worker | `/api/*` routing to every mini app, plus the one shared Box OAuth login flow (`box/authorize-url`, `box/callback`) every mini app's own Box connection reuses. |
| `scripts/update_dashboard.py` | GitHub Actions | Auto-detects every meeting in the Data Folder's Post-Meeting Survey export that isn't in `data/feedback_log.json` yet (resolving Year/Quarter/Region per meeting from the Council Meeting Helper export), extracts and publishes each one's themes with Claude, then rebuilds the quant dashboard. |
| `scripts/setup_analysis.py` | GitHub Actions | Re-synthesizes every quarter already in `data/feedback_log.json`, no new survey involved — the one-time bootstrap (or a full redo). |
| `scripts/remove_meetings.py` | GitHub Actions | Deletes one or more meetings' data from the Feedback Log and both published dashboards, then re-synthesizes every quarter still left. Also strips the matching rows out of the Data Folder's own Helper and Survey exports in Box, best-effort, so the meeting doesn't come back on the next Update Dashboard. Triggered from the Meetings table's "Remove & refresh" button. |
| `public/consensus/` | Worker static assets | Consensus: the public respondent chat (`respond.html`, no login, per-survey link) and its control panel (`control-panel/{index,results}.html`, admin-gated). See **9 · Consensus** below. |
| `src/consensus.js` | Cloudflare Worker | `/api/consensus/*`. Survey CRUD, the live follow-up-question chat, response storage in Box, and triggering the batch analysis -- gates its admin routes with the same admin accounts via `requireBetaAuth`. |
| `scripts/consensus_analyze.py` | GitHub Actions | Synthesizes a survey's collected responses (out of Box) into prioritized themes per question with Claude, and publishes `public/consensus-results/<id>.json`. Triggered from the Consensus control panel's "Analyze" button. |
| `public/inm/` | Worker static assets | Issue Network Mapper: its public page (`index.html` -- Network/Change-over-time tabs, a project picker, admin-gated) and its control panel (`control-panel/index.html`). `public/pcn/` still exists as redirect stubs to here, for old bookmarks. See **10 · Issue Network Mapper** below. |
| `src/pcn.js` | Cloudflare Worker | `/api/pcn/*`. Admin-gated like Consensus, and shares the same Box connection every other tool here uses -- picks its own one data folder the same way Consensus picks a responses folder per survey. |
| `public/mcm/` | Worker static assets | Manufacturing Conditions Monitor: the public dashboard (`index.html`) and its control panel (`control-panel/index.html`, admin-gated). See **11 · Manufacturing Conditions Monitor** below. |
| `src/mcm.js` | Cloudflare Worker | `/api/mcm/*`. Same shared Box connection and admin accounts as every other mini app; its own data folder. |
| `public/stars/` | Worker static assets | STARs Talent Transfer Explorer: the public matching tool (`index.html`, no login) and its control panel (`control-panel/index.html`, admin-gated). See **12 · STARs Talent Transfer Explorer** below. |
| `src/stars.js` | Cloudflare Worker | `/api/stars/*`. The occupation-matching/skill-gap routes are public and unauthenticated (no Claude call anywhere); Box folder/upload routes are admin-gated like every other mini app. |
| `public/artifacts/` | Worker static assets | Artifact Catalogue: the public gallery (`index.html`, cards link straight out to claude.ai) and its control panel (`control-panel/index.html`, admin-gated). See **13 · Artifact Catalogue** below. |
| `src/artifacts.js` | Cloudflare Worker | `/api/artifacts/*`. `list` is public (public-tier entries only); `catalogue`/`add`/`visibility`/`delete` are admin-gated. No Box involved -- entries are just {title, url, description, visibility} in KV. |
| `public/job-description/` | Worker static assets | Job Description Updater: the employer's own upload/chat flow (`index.html`, no login), the supervisor/incumbent shareable-link page (`respond.html`, no login), and its control panel (`control-panel/index.html`, admin-gated). See **14 · Job Description Updater** below. |
| `src/job_description.js` | Cloudflare Worker | `/api/job-description/*`. The upload/chat/invite routes are public and unauthenticated, same as Consensus's respondent chat; Box folder picker and the sessions list are admin-gated. Its own Claude key, `job_description_claude_api`, is called live from the Worker (see step 14). |
| `src/credentials.js` + `src/data/credentials.json` | Cloudflare Worker | The credential reference behind the Job Description Updater's Part 3, and the deterministic scorer that narrows its 30 entries to a shortlist of 8 before any Claude call. The JSON is generated by `scripts/build_credentials.py` from the credential/competency workbook — see **14 · Job Description Updater**. |
| `src/docx.js` | Cloudflare Worker | Minimal `.docx` writer with real Word tracked changes, no npm dependency. Builds the Job Description Updater's three downloads. |
| `public/apprenticeship/` | Worker static assets | Apprenticeship Readiness Toolbox: the respondent chat (`respond.html`, no login), their combined readiness dashboard (`dashboard.html`, no login), and the control panel (`control-panel/index.html` and `control-panel/responses.html`, both admin-gated). See **15 · Apprenticeship Readiness Toolbox** below. |
| `src/apprenticeship.js` | Cloudflare Worker | `/api/apprenticeship/*`. The respondent chat, results and dashboard routes are public and unauthenticated; projects, the assessment editor, responses, the issue log and the CSV are admin-gated. Its own Claude key, `apprenticeship_claude_api`, is called live from the Worker (see step 15). |

---

## 1 · The repository

1. Create a repository — say `conexus-council-themes` — and upload every file from this
   project, keeping the folder structure.
2. `Settings → Actions → General → Workflow permissions` → **Read and write permissions**.
   Without this an analysis run cannot commit.
3. Open `wrangler.jsonc` and set `GITHUB_REPO` to your repository in `owner/name` form.

---

## 2 · Cloudflare

1. In the Cloudflare dashboard, **Workers & Pages → Create → Import a repository**, and
   point it at this repo. It reads `wrangler.jsonc` and deploys on every push.
2. **Storage & Databases → KV → Create a namespace**, name it `BOX_KV` to match the
   binding in `wrangler.jsonc`. Copy its ID into `wrangler.jsonc` under `kv_namespaces`,
   replacing `PASTE_YOUR_KV_NAMESPACE_ID_HERE`, and commit.

   This is where the Box connection lives: the token pair (the refresh token rotates on
   every use, so it cannot be a static secret) and the folder you pick in the panel.
3. Note the Worker's address — `https://<worker-name>.<subdomain>.workers.dev`, where
   `<worker-name>` is whatever you named it in this step, **not** necessarily the repo
   name. Open `wrangler.jsonc` and set `"name"` (and `vars.WORKER_NAME`, for the
   `/api/config-check` diagnostic) to match it exactly — every `wrangler` command that
   targets a Worker by name, including the **Set Cloudflare secrets** workflow, reads
   this field, and a mismatch here means secrets silently land on a different, unused
   Worker instead of failing loudly. This repo's own deployed Worker is named
   `connector`.

---

## 3 · The Box app

This project's Box app is **shared with conexus-mcm** — same Client ID/Secret, same
Box Developer Console app. Reuse that app rather than creating a new one:

1. `app.box.com/developers/console` → the shared app → **Configuration**.
2. Authentication method: **User Authentication (OAuth 2.0)**. This is the "Log in with
   Box" flow — the app acts as *you*, so it sees exactly what you see and nothing more.
3. **Application Scopes** should already have **Read and write all files and folders
   stored in Box** checked (conexus-mcm needs write access, so this app already has it —
   this project needs it too, to replace the Data Folder's exports on upload). If it
   only has read checked, add write now and **Save Changes**.
4. **OAuth 2.0 Redirect URI** — this field takes one URI per line. Make sure **both**
   projects' callback URLs are listed:

   ```
   https://<conexus-mcm-worker-address>/api/box/callback
   https://<this-worker-address>/api/box/callback
   ```

   Box rejects a login whose redirect URI isn't listed here, character for character.
   If council-themes' own line is missing, add it now.
5. Copy the **Client ID** and **Client Secret** — same values as conexus-mcm's.

If your Box connection here was set up before this app had write scope, **Disconnect**
and **Log in with Box** again in the control panel — the stored token was issued under
the old (read-only) consent and needs to be reissued to pick up write access.

---

## 4 · Secrets

Add these under `Settings → Secrets and variables → Actions` in your repository:

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages → Account details |
| `PANEL_GITHUB_TOKEN` | A fine-grained GitHub token, this repo only, **Actions: read and write** |
| `poneill_password` | A password you choose — bootstraps the *first* admin account (see step 8). Every admin after that sets their own password through the sign-in page itself, not a secret. |
| `BOX_CLIENT_ID` | Box app Configuration tab (the shared app — see step 3) |
| `BOX_CLIENT_SECRET` | Box app Configuration tab (the shared app — see step 3) |
| `BOX_RELAY_SECRET` | A long random string you make up |
| `BOX_RELAY_URL` | `https://<your-worker-address>/api/box/pipeline-token` |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → Settings → API Keys |
| `SEC_CONTACT_EMAIL` | Your email — only needed for Manufacturing Conditions Monitor (see step 11); SEC EDGAR's fair-access policy requires a contact email in the request header |

`ANTHROPIC_API_KEY` and `SEC_CONTACT_EMAIL` are the exceptions to "everything is done
in a browser, no terminal" being about secrets specifically living in *this*
repository's GitHub settings — they're only ever read by the Python scripts running in
GitHub Actions, so unlike the others they do **not** need to go to Cloudflare at all.

Everything else, run **Actions → Set Cloudflare secrets → Run workflow**. That hands the
Worker-side values to Cloudflare for you, which is the step that would otherwise need a
terminal.

`BOX_RELAY_SECRET` is deliberately in both places: the Worker checks it, and an analysis
run sends it. They must be the same value.

Check it worked by opening `https://<your-worker-address>/api/config-check`. You are
looking for `"buttons_configured": true` and `"box_kv_bound": true`.

---

## 5 · Connect Box and set up the panel

1. Open `https://<your-worker-address>/admin/login.html` and sign in with your admin
   account (see step 8 if you haven't set one up yet), then open
   **Council Themes/Quant** → **Control panel** from the hub.
2. **Log in with Box**. Box asks you to authorise the app; it comes back to the panel.
3. **Data Folder** → **Choose folder…** and pick (or create) a Box folder to hold the
   three source files: `Council Meeting Helper.csv`, `Post-Meeting Survey.csv` (both
   kept current from the two upload cards on the main page), and `Content
   Categories.xlsx` (maintained directly in Box). Set this once — there's no need to
   revisit it quarterly.
4. Still under **Developer**, click **Refresh Themes**. This synthesizes current/QoQ/YoY
   themes for every quarter already sitting in `data/feedback_log.json` and publishes
   them, with no new survey involved. Re-run it any time you want every quarter redone
   from scratch (e.g. after a taxonomy change) — or **Refresh All** to also rebuild the
   quant dashboard in the same run.

From here on, each new meeting: upload the latest exports via **Council Meeting Helper
Upload** and **Post-Meeting Survey Upload** (each replaces the previous export
wholesale — both are cumulative, so the new file already contains everything the old
one did), then **Update Dashboard**. It auto-detects which meeting(s) are new by
Survey ID, so it's safe to click any time, even with nothing new uploaded.

---

## 6 · The taxonomy

`data/taxonomy.json` holds the fixed Category → Subcategory vocabulary. Claude is
given this list on every extraction run and told to reuse an existing pair whenever
one reasonably fits, only writing a new Subcategory when nothing listed fits at all —
the taxonomy's value comes from the same label being reused across quarters, so it
resists adding new ones often, but does extend the file in place on its own when it
legitimately needs to. Edit it by hand in the repo if you want to add or rename one
yourself.

---

## 7 · The Power BI pages

The report has three pages — **Benchmarking**, **Attendance**, **Attendance 2026+** — and
each needs its `ReportSection` id filling in once.

1. Open the report in `app.powerbi.com` — the real report, not the Publish-to-web link.
2. Click a page. The address bar reads:

   ```
   .../reports/2bce9c2f-05e5-4ec4-8dce-2414bd9f9e41/ReportSection8f2a1c4d?experience=power-bi
   ```

   Copy the `ReportSection…` piece — everything after the last slash, before the `?`.
3. Edit `public/index.html` in GitHub's web editor and replace `PASTE_PAGE_ID_1`,
   `_2` and `_3` on the matching lines. Until you do, each tab shows a note naming which
   placeholder it is waiting on, so a right id in the wrong slot is easy to spot.
4. Add or remove entries freely — the buttons come from that list.

**Use the `?r=…` Publish-to-web link as `reportUrl`.** The
`reportEmbed?reportId=…&autoAuth=true` link is "Embed for your organization": it makes
every viewer sign in with a Conexus account, so anyone outside Conexus hits a login wall —
which is the problem this wrapper exists to avoid.

---

## 8 · The admin hub

**Connector** is the name of the whole platform: one public grid at the site root
(`public/index.html`, no login) listing whichever mini apps are currently set to
"Public", and one admin hub at `/admin/` (sign-in, the grid of *every* mini app, and
Settings) that every mini app's control panel signs into via the same admin accounts.
There is no per-app password anywhere — Council Themes/Quant's control panel signs in
exactly the same way Issue Network Mapper/Consensus/MCM's always have.

### Signing in

1. Add `poneill_password` as a repository secret (a password of your choosing), then run
   **Actions → Set Cloudflare secrets → Run workflow** — same mechanism as every other
   secret in this project (step 4 above). This seeds one admin account: email
   `poneill@conexusindiana.com`, username `poneill`, that password. It's read exactly
   once, the first time anyone hits `/admin`; after that the account is stored the same
   way every other admin's is, and the secret is never read again.
2. Open `/admin/login.html` and sign in with that username/email and password.

### Adding another admin

From **Settings** (`/admin/settings.html`, linked from the hub) → **Add an admin** →
enter their email → **Add**. That's it — they're now allowed to set up their own
account, but nothing is created for them yet.

They go to `/admin/login.html` → **Set up new account / Forgot password** → enter their
email → if it's on the list and doesn't have a password yet, they're prompted to pick a
username and password right there. The same button handles "I forgot my password": once
another admin clears it for you (**Settings** → **Reset**), your account is back in
that same "allowed, no password yet" state, and you use the same button to set a new one.

**Worth knowing:** there's no email-sending step anywhere in that flow — setting a
password only checks that the email is on the admin list, not that whoever's typing
actually owns that inbox. For a small, trusted team that's a reasonable trade for staying
free and simple, but it does mean anyone who knows an admin's email (and that it doesn't
have a password set yet, e.g. right after a reset) could claim the account first. If that
ever stops being an acceptable trade, the fix is a real "magic link" flow — a one-time
link emailed to the address, using something like Resend or Postmark — which would need
one more secret (an email-provider API key, pushed the same way as everything else) and a
couple more routes in `src/beta_auth.js`, not a different storage model. Ask for it if you
want it; it wasn't built now because it adds a moving part (an email provider) this
project doesn't otherwise need.

### App visibility

Also on **Settings**, per app: **Public** (listed on the public grid at the site root),
**Hidden** (not listed there, but the page still works for anyone with the direct
link), or **Admin-only** (not listed, and the page itself redirects to sign-in unless
you're already signed in — the same check every admin page here already does, just
driven by this setting instead of being hardcoded). Council Themes/Quant and
Manufacturing Conditions Monitor default to Public; Issue Network Mapper and Consensus
default to Admin-only, since neither has a public-facing page built yet.

One thing this does **not** do: for a page whose content is plain static JSON
(Council Themes/Quant, MCM's dashboard), "Admin-only" gates the *page*, not the
underlying JSON files themselves (`council-themes.json`, `/mcm/data.json`, etc.) —
those stay fetchable directly by anyone who already knows or guesses the exact
filename, same as today. Airtight gating of the data itself would mean serving it
through an authenticated `/api/*` route instead of a static file; ask if you need that.

### Adding a mini app

1. Build it wherever makes sense in the repo — its own `public/<id>/` pages (base page
   at `public/<id>/index.html`, control panel at `public/<id>/control-panel/index.html`),
   its own `/api/<id>/*` routes if it needs a backend (gated by `requireBetaAuth`, never
   a password of its own), its own GitHub Actions workflow if it needs one.
   `src/beta_auth.js` and the rest of the platform don't need to know anything about how
   it works internally.
2. Add one entry to the `APPS` array in `public/apps.js` — id, name, description; its
   `baseUrl`/`controlPanelUrl` are just `/<id>` and `/<id>/control-panel`. That's the
   only step that makes it show up in the admin hub's grid and in Settings' visibility
   list. If its base page should ever be gated by the "Admin-only" tier, also add
   `<script src="/tier-gate.js" data-app="<id>"></script>` (and
   `<style>html{visibility:hidden}</style>`) to that page, same as
   `public/council-data/index.html`/`public/mcm/index.html` do.
3. If it needs its own secrets (an API key, a webhook secret, whatever), they follow the
   same pattern every secret in this project already follows: store it as a GitHub
   repository secret, and either send it to Cloudflare via
   **Actions → Set Cloudflare secrets** (add a step there, same shape as `poneill_password`'s)
   if a Worker route needs to read it, or leave it as a plain repository secret if only a
   GitHub Actions script needs it (like `ANTHROPIC_API_KEY` already does — see step 4).
   Each mini app's secrets are namespaced by whatever name you give them.

---

## 9 · Consensus

The first mini app built on the platform: chatbot-style surveys, where each question can
ask Claude to generate a set number of follow-up questions on the fly, based on context
you give it. Once responses are in, one click synthesizes each question into prioritized
themes plus areas of consensus and areas needing more information.

Reachable from the admin hub (`/admin/`) → **Consensus** → **Control panel**, or
directly at `/consensus/control-panel/index.html`. Uses the same admin accounts as
every other mini app — nothing extra to sign in to — and the same Box connection as
Council Themes/Quant.

### Setup

1. Add `consensus_claude_api` as a repository secret — an Anthropic API key, separate
   from the Council Survey Dashboard's `ANTHROPIC_API_KEY` so the two mini apps' Claude
   spend is easy to tell apart. Run **Actions → Set Cloudflare secrets** afterward — this
   one secret is needed in *two* places and that workflow sends the Worker its copy:
   - The Worker itself needs it, because the live chat's follow-up questions are
     generated while a respondent is sitting there waiting — that can't be deferred to a
     GitHub Actions run the way the batch analysis is.
   - `consensus_analyze.yml` (the batch analysis) reads the same value as a plain
     repository secret, the same way `ANTHROPIC_API_KEY` already does for the Council
     app.
2. That's it — no separate Box setup. Each survey you create picks its own responses
   folder from the same Box connection already set up in step 5.

### Building a survey

From **Consensus** → **New survey**:

- **Survey context** — objective, audience, and general guidance. All three are given to
  Claude alongside every question, so follow-ups (and later, the analysis) stay grounded
  in what the survey is actually for. General guidance is the one that applies across
  every question, including ones with 0 follow-ups of their own — use it for instructions
  like "take the respondent's earlier answer about their industry into account for later
  questions." A question's own context box (below) only ever shapes that one question's
  own follow-ups.
- **Questions** — each one has its own follow-up count (0-5) and its own context box for
  guiding what those follow-ups should probe for. That count is a ceiling, not a target:
  Claude sees the whole survey so far (every earlier question's answers, plus this
  question's own thread) and uses its own judgement on whether another follow-up would
  actually add value, stopping early rather than padding out to the maximum. No
  per-question flag to configure this — it's inferred from context every time.
  - **Claude Analyze** — Yes/No, required on every question, defaults to Yes. For a
    simple field like name or company, set it to No: the batch analysis skips that
    question entirely (no Claude call, no tokens spent on it) and its raw answers show
    up instead as a plain table on the results page — see below.
  - **Personalize this question** — optional, and only offered on the second question
    onward. Check any number of earlier questions, and this question's wording gets
    lightly rewritten using everything the respondent said on all of them (including
    any follow-ups) before it's shown — e.g. "Do you know others leading the way?"
    becomes "...leading the way in reverse logistics?" once an earlier answer
    established that as the challenge. Falls back to the question's own static text if
    none of the checked questions were reached yet, Claude is unavailable, or the
    rewrite call fails — this is wording polish, never something that can block a
    respondent's progress through the survey. Reordering or removing a checked source
    question automatically drops it from the selection if it's no longer valid.
- **Responses folder** — the Box folder responses are saved to, as one CSV per survey.

Saving gives you a respondent link (`/consensus/respond.html?survey=<id>`) — share that
however you'd share any survey link. It's public, no sign-in, by design. Every question
(personalized or not) has a brief, consistent pause before it appears — an instantly
displayed question felt jarring next to a follow-up, which always has some natural delay.
A progress bar above the chat shows "Question X of Y", advancing one step per base
question completed — follow-ups don't move it, since the model decides on the fly how
many (if any) a question gets, so there's no fixed number of sub-steps to show partial
credit for.

Once responses have come in, **Analyze** (back on the survey list) kicks off
`consensus_analyze.yml`, which publishes `public/consensus-results/<id>.json` — open
**Results** next to that survey once it's done. Re-running **Analyze** re-publishes the
same file from whatever's in the responses CSV at that point, so it's safe to run again
after more responses come in. While it runs, the survey row shows a live progress bar
(which question of how many it's currently synthesizing), not just the GitHub Actions
run's start time. That progress count only reflects Claude Analyze: Yes questions --
the No ones aren't part of the run's synthesis work. The bar appears the instant you
click Analyze, animating in an indeterminate "Starting analysis on GitHub Actions…"
state before switching to real per-question progress -- GitHub Actions needs its own
15-30s to spin up a runner (checkout, Python setup, pip install) before the script
even starts, and the bar shouldn't sit hidden and look broken for that whole stretch.

If any questions are set to Claude Analyze: No, the results page opens with a
**Respondent summary** table above the themed sections -- one row per respondent, one
column per such question, exactly as answered. It's cropped to 3 rows with a fade and a
"Show all" button once there's more than that to show.

### Cost

Two different models, deliberately: the live follow-up-question generator uses
**Claude Haiku 4.5** (cheapest current model — writing one short question from a little
context is exactly the high-volume, low-complexity workload it's for), and the batch
analysis uses **Claude Sonnet 5** (real synthesis across many respondents' answers earns
a stronger model, at a fraction of Opus's per-token cost). See the comments above
`FOLLOWUP_MODEL` in `src/consensus.js` and above `MODEL` in `consensus/analyze.py` if you
want to change either.

---

## 10 · Issue Network Mapper

Turns meeting notes/transcripts into an accumulating, evidence-traceable map of how
members believe their problems connect (Axelrod-style causal mapping / fuzzy cognitive
maps — see the design doc for the full method and reasoning). Implements the design
doc's complete 8-step build order.

Its Box access is the **same shared, user-delegated connection** every other tool here
uses — nothing new to set up. If the control panel says "Not connected," log in with
Box from Council Themes/Quant's control panel Developer section
(`/council-data/control-panel/index.html`), same as you would for anything else.

**Projects.** This isn't just a single meeting series: the control panel's **Project**
dropdown holds any number of fully walled-off projects, each with its own Box data
folder, ledger, issues, network, timeline, and GitHub Actions runs — none of a
project's data or pipeline runs ever touches another's, even transiently. The default
project seeded automatically has id `pcn` (a holdover from before this app supported
more than one meeting series); pick **+ Add new project…** to wall off a different
meeting series entirely, give it a name, and you're dropped onto that project's own
empty control panel to configure its own Box folder from scratch. Every URL in the app
(control panel, network view, timeline view) carries `?project=<id>` so a bookmark or
link always returns to the right one.

**Using it on real meetings**, from a project's control panel (admin hub → Issue
Network Mapper → **Control panel**, or `?project=<id>` for another one):
1. **Choose folder…** picks this project's one Box data folder —
   `ledger.json`/`issues.json`/`resolutions.json` at its root, plus a `raw/`
   subfolder holding every uploaded meeting file verbatim for audit. **Test Box
   round-trip** confirms the connection works.
2. **Upload a meeting**: pick Transcript or Notes, the meeting date, **Year**,
   **Quarter**, an optional **Cohort** label, a notetaker (notes only), and the file
   (`.vtt`/`.srt`/`.txt`/`.docx` for transcripts; `.md`/`.txt`/`.docx` for either).
   Year/Quarter/Cohort are reporting metadata carried through onto every assertion
   extracted from this meeting (for future filtering/export) — they do **not**
   change how the change-over-time view buckets its quarters, which still derives
   that purely from the meeting date; the two are independent on purpose, since a
   meeting's reporting period and its calendar quarter aren't always the same thing.
   This only saves the file to Box and queues it ("pending" in the **Meetings**
   table below) — nothing is extracted yet.
3. **Run pipeline** dispatches a GitHub Actions run (`pcn_run.yml` with this
   project's id as input, `pcn/pipeline/run.py`) that processes every pending
   meeting *for this project only*: ingest → normalize → extract → match → derive →
   timeline, then publishes the updated network and timeline. A meeting that fails
   (bad file, extraction error) is marked "Failed" with the error shown in the
   table, rather than retried forever or silently dropped; every other pending
   meeting in the batch still gets processed.
4. Check the results on the **View network** and **Change over time** pages (linked
   from the control panel, carrying the same project).

This Worker is the only thing that ever talks to Box directly for any project's
state — `pcn/pipeline/run.py` (and the CLI's per-stage subcommands) reach it only
through `relay/projects/<id>/state` and `relay/projects/<id>/meetings/*`
(shared-secret auth, plain JSON), the same way Consensus's Python pipeline gets a
survey's data as JSON rather than a Box token. See `src/pcn.js`'s module docstring
for the full route list.

**Pipeline** (`pcn/pipeline/`, Python): `pcn/pipeline/ingest` reads a source file
(`.vtt`/`.srt`/`.txt` for transcripts, `.md`/`.txt`/`.docx` for either) into a
`RawDocument`; `pcn/pipeline/normalize` turns that into a `NormalizedDocument` of
`Segment`s — speaker turns for a transcript, heading/bullet units (with inherited
parent heading context) for notes; `pcn/pipeline/extract` calls Claude (Haiku by
default, escalating a specific segment to Sonnet only when two independent extraction
passes disagree on it) to turn those Segments into `Assertion`s appended to the
assertion ledger (`pcn/pipeline/ledger.py`) — see `pcn/CODING_PROTOCOL.md` for the
five coding rules the extraction prompt follows; `pcn/pipeline/match` resolves each
Assertion's raw `from_issue_label`/`to_issue_label` text onto a canonical `Issue` via
a four-stage cascade (exact alias match → rapidfuzz fuzzy match → embedding
nearest-neighbor → residual Haiku adjudication over just the 5 nearest candidates),
recording the result separately in a resolutions file rather than editing the ledger;
`pcn/pipeline/review` orders unreviewed assertions (cross-run disagreement → escalated
→ new-issue-creating → everything else) and lets a human confirm/reject one — the
`--from-definition`/`--to-definition` flags on `review confirm` are how an issue's
one-line definition gets written the first time it's confirmed, which is what the
adjudication stage shows a model for its candidates from then on. Only `extract` and
match's adjudication stage make model calls; everything else is plain Python/rapidfuzz/
local embeddings. All of it reuses this project's own `ANTHROPIC_API_KEY` repository
secret rather than a dedicated key — volume here is cents per meeting.

`pcn/pipeline/derive` recomputes the connection network fresh from the ledger +
resolutions every run (a pure function, via networkx) — non-rejected assertions
sharing a resolved (from, to) issue pair become one edge, carrying a mean signed
weight, a **dispersion** (population stdev of that edge's weights, so a contested
connection — some members say positive, some negative — is visibly different from
an uncontested one, rather than both washing out to the same near-zero mean), a
per-modality breakdown, and its supporting assertion ids for evidence traceability.
Nodes get out-/in-degree, centrality, and a role (`driver`: affects things, nothing
affects it; `outcome`: something cared about, not itself influenceable; `ordinary`: a
candidate program — both). Graph-level: density, a hierarchy index (MacDonald's, as
used by Özesmi & Özesmi 2004 for FCM structural analysis — **not independently
verified against the primary source**, same caveat the design doc's own reference
implementation carried), and feedback loops via `networkx.simple_cycles` (capped at
6 nodes). `input_type_breadth` reports assertion/speaker/meeting/notetaker counts
**separately per transcript vs. notes** rather than pooling them — raw assertion
counts aren't comparable across input types (a transcript yields far more assertions
than notes of identical substance), so nothing here sums them together.

The `derive` stage's `--publish --project <id>` flags push the network to this
Worker via `POST relay/projects/<id>/network` (shared-secret `x-pipeline-key:
BOX_RELAY_SECRET` auth, same mechanism as `GET /api/box/pipeline-token` and
Consensus's own relay routes — see `pcn/relay.py`), stored in `BOX_KV` and served
back by `GET projects/<id>/network` (beta-account gated) for that project's **View
network** page to render: an interactive force-directed graph (D3, loaded from a
CDN — the one external script this app uses) with node size by centrality, node
color by role, edge color by sign (green positive / red negative / gray contested),
and a dashed edge where dispersion swamps the mean (members disagree). Click a node
or connection for its detail — definition, degree, supporting-assertion counts.

`pcn/pipeline/timeline` answers "what changed since last time": it buckets the
ledger's assertions by quarter using each one's `meeting_date` (set via `ingest
--meeting-date YYYY-MM-DD` — an assertion with none is excluded from every period,
never guessed at) and derives the network as of each quarter's cumulative cutoff.
Since the map only ever accumulates evidence, "change" mostly means which
connections are newly evidenced in a quarter, and which existing connections just
became **contested** — a connection that used to look settled getting a
contradicting assertion from a later meeting. It does not mean connections
disappearing (only rejecting an assertion in review does that). Published the same
way as the network (`--publish --project <id>` → `POST relay/projects/<id>/timeline`
→ `GET projects/<id>/timeline`), rendered by that project's **Change over time**
page as a simple trend chart (issue/connection counts by quarter) plus a per-quarter
table of what's new or newly contested.

The **fixture pipeline test** workflow (Actions tab) is separate from the real
`pcn_run.yml` above: it runs every stage's CLI subcommand against the committed
synthetic fixtures (`pcn/fixtures/`, no real meeting data exists in this repo —
they're made up, matching the design doc's own worked example of a staffing →
overtime → turnover loop) and uploads each stage's JSON output as a downloadable
artifact, useful for debugging one stage at a time or verifying the pipeline still
works without spending a real meeting's worth of Box state. It publishes its network/
timeline under an ad-hoc `fixtures` project id, never registered through the admin
UI (see this file's project section above) — deliberately kept separate from every
real project's own data.

---

## 11 · Manufacturing Conditions Monitor

A quarterly headwinds/tailwinds dashboard for U.S. manufacturing, built entirely from
SEC EDGAR filings (10-K/10-Q) — no council survey data involved. This mini app was
ported in from what used to be a fully standalone repo/Worker/Box app; it now reuses
everything this repo already has (the shared Box connection, `BOX_KV`, the admin
accounts, GitHub Actions dispatch), so the **only step below you actually have to do
by hand is adding one secret**.

**Add the one new secret.** `SEC_CONTACT_EMAIL` in step 4's table above — nothing
else. Every other secret it needs (`ANTHROPIC_API_KEY`, `BOX_RELAY_URL`,
`BOX_RELAY_SECRET`, the Box app credentials, the GitHub token) already exists in this
repository, shared with Council Themes/Quant/Issue Network Mapper/Consensus.

**Open it.** From the admin hub (`/admin/`), open **Manufacturing Conditions
Monitor** → **Control panel** (`/mcm/control-panel/index.html`). Needs a signed-in
admin account — same accounts as every other mini app here, no password of its own.

**Pick a Box folder.** Under **Data folder**, click **Choose folder…** and pick (or
create) an empty folder. This is MCM's own folder — separate from Council Themes/
Quant's Data Folder and from any Issue Network Mapper project's folder — and holds its six data files
(`filings.csv`, `paragraphs.csv`, `signals.csv`, `companies.csv`, `narratives.json`,
`status.json`), synced by `mcm/box_store.py` through `GET /api/mcm/relay/pipeline-
token` (shared-secret auth, same mechanism as every other mini app's relay route).

**Download new data → Analyze → Publish site.** Same three-button flow the original
standalone tool had (`mcm_download.yml` → `mcm_analyze.yml` → `mcm_publish.yml`,
dispatched from `POST /api/mcm/run`). Only the latest complete quarter and its QoQ/
YoY comparisons are ever downloaded or analyzed (`mcm/periods.py:required_quarters`) —
see the original tool's own design notes, unchanged by the port. The published
dashboard (`public/mcm/index.html`, MCM's public base page, generated by
`mcm/site.py`) fetches only static JSON (`data.json`, `narratives.json`,
`status.json`, `evidence/*.json`) straight off the asset layer — whether it's
currently public depends on its visibility tier in Settings (step 8), same as every
other mini app's base page.

---

## 12 · STARs Talent Transfer Explorer

Ranks occupations by how closely their 35 O*NET skill-importance scores match a
target job, layered with Indiana wage data — one tool for employers screening
transferable talent pools, another for workers exploring higher-wage career
pathways. Ported in from what used to be two standalone repos (a private Cloudflare
Worker holding the O*NET/wage data, and a public GitHub Pages frontend calling it
over CORS); both halves are now one mini app here, reusing the shared Box connection
and admin accounts like every other one. **No step below involves Claude or any
other API call** — the ranking is pure Euclidean distance, and the per-skill
"development focus" text is a static, hand-written table already checked into
`src/stars_logic.js` (see that file's own docstring). Nothing needs to be "rerun."

**Nothing to add — it works immediately after deploy.** `src/data/stars-occupations.json`
(the same 873-occupation dataset the original repo shipped, ~250KB) is bundled with
the Worker as a default, so `/stars` and its control panel both work out of the box
with no setup. The steps below are only for updating that data later.

**Open it.** From the admin hub (`/admin/`), open **STARs Talent Transfer Explorer**
→ **Control panel** (`/stars/control-panel/index.html`).

**Pick a Box folder** (optional, but recommended). Under **Data folder**, click
**Choose folder…** and pick (or create) an empty folder — STARS's own, separate from
every other mini app's. This is where a freshly regenerated `occupations.json` gets
uploaded and durably stored, independent of a code deploy; the **Data status** card
shows whether the live tool is currently serving the bundled default or something
uploaded here.

**Updating the data**, when Indiana wage figures or the underlying O*NET skill model
changes: run `generate_data.py` locally with Python (see `stars/README.md` in this
repo for the exact command — it needs the source workbook and, optionally, a wage
CSV), then upload the resulting `occupations.json` through the control panel's
**Upload data** card. The source workbook and wage CSV can be uploaded alongside it,
purely for provenance/future regeneration — the live tool never reads them at
request time, only `occupations.json`. If the file in Box is ever edited or replaced
directly (outside this upload form), **Refresh from Box** re-syncs the live tool to
match.

---

## 13 · Artifact Catalogue

A simple, curated list of Claude artifact links, kept in one nice-looking place —
for artifacts made outside this repo (e.g. in a claude.ai conversation) that are
worth keeping track of. This is deliberately **not** a rehosting tool: there's
nothing to export, convert, or upload. An entry is just a title, the artifact's own
`claude.ai/artifact/...` link, an optional description, and a public/private tier.
Opening a card always takes you straight to the real artifact on claude.ai.

**Adding one**: open the control panel (`/artifacts/control-panel`) and use **Add an
artifact** — paste the link, give it a title and (optionally) a description, and
choose **Public** (listed on `/artifacts`, the public gallery) or **Private** (shown
only here, to a signed-in admin). New artifacts default to Private — flip the pill in
the catalogue table once you're ready to make one public.

**What the visibility toggle does and doesn't do**: it only controls whether a card
appears on the public gallery. It has no effect on the underlying claude.ai link
itself — whoever has that URL and whatever sharing claude.ai has it set to determines
who can actually open it, same as any link.

---

## 14 · Job Description Updater

An employer uploads a job description (PDF or Word), and Claude walks them through
updating it with the Conexus Job Description Toolkit — the toolkit's own ~60–90 minute
manual exercise, compressed to about ten minutes by having Claude read the whole
document up front and the employer only confirm, correct, or supply what the document
can't know (how the work has actually changed, which requirements are truly necessary).
No step asks an open-ended question where a tap-to-choose answer with Claude's own guess
prefilled will do.

**Four screens, then the outputs.** All five toolkit parts are covered, but the employer
answers on four screens rather than nine:

| Screen | Covers | Roughly |
|---|---|---|
| Start | The file, plus who's answering, whether the role is hard to fill, and when the description was last updated. Claude reads the document while these are filled in. | 1 min |
| What Claude found | The Part 2 audit of all ten categories. Only the ones Claude flagged Minor Drift or Significant Gap open by default; the aligned ones stay collapsed but are still editable. | 2 min |
| Reality check on duties | Part 1: every duty tapped Still accurate / Changed / No longer done, plus the four drivers of role evolution, each prefilled with Claude's guess. | 4 min |
| Requirements test | Part 3's core question asked of every requirement, with the credentials in play for this role shown alongside. | 3 min |
| Gaps and the decision | Pay range, physical-demand frequency and pathway, plus the two Part 4 questions Claude can't compute. The New Role Decision Matrix score updates live as they answer. | 2 min |

**What the employer gets.** A plain-English summary of the biggest changes, shown on
screen, plus three Word files:

1. **Redlined description** — real Word tracked changes, so the reviewer can Accept or
   Reject each edit in their own copy.
2. **Final description** — the same document with those changes accepted. It is derived
   from the redline rather than generated separately, so the two cannot disagree.
3. **Career fair one-pager** — plain-language handout for job seekers and counselors.

`.docx` rather than PDF for all three: Word has native revision markup (a PDF could only
show a picture of a strikethrough), and a `.docx` is a ZIP of XML, so the Worker builds
it with no new dependency. See `src/docx.js`.

**Credential recommendations.** Part 3 asks that a genuinely necessary requirement be
tied to a named, portable credential rather than "technical background preferred". The
reference matrix behind this holds 30 recommendable credentials and pathways: MSSC CPT,
fourteen NIMS machining cards, NIMS Metrology and ITM, four OSHA cards, six Ivy Tech
program areas, and the three toolkit pathways with no workbook rows of their own
(Polymechanic/AMT, Registered Apprenticeship, Indiana CTE completion).

Thirty is too many to put in front of an employer, and too many to hand a model and
expect a disciplined answer. So the shortlist is scored **deterministically, with no API
call**: `src/credentials.js` ranks all 30 against the role's own duties (TF-IDF over each
credential's key activities and performance indicators) and only the closest eight reach
Claude, which picks the 1–5 that genuinely fit. Fewer is the goal — a merely plausible
credential is worse than none, because a training provider builds curriculum against
whatever gets named.

To refresh the reference after the workbook changes:

```
python3 scripts/build_credentials.py path/to/credential_competency_matrix.xlsx
```

That rewrites `src/data/credentials.json`, which is committed. Don't hand-edit the JSON.

**This app needs its own Anthropic API key, separate from every other mini app's.**
Unlike the batch, GitHub-Actions-driven Claude calls everywhere else in this repo
(Update Dashboard, Analyze, etc.), both of this app's Claude calls — the pre-read on
upload, and the final outputs at the end — have to respond live, synchronously, while
the employer is sitting in the chat waiting, the same way Consensus's follow-up-question
chat already does (see `src/consensus.js`'s own module docstring). That means this key
has to reach the **Worker itself**, not just a GitHub Actions secret:

1. Create the key in your Anthropic account, named however you like (the control panel
   just checks whether it's set, not its name).
2. Add it as a repository secret named exactly **`job_description_claude_api`**
   (Settings → Secrets and variables → Actions → New repository secret).
3. Run **Set Cloudflare secrets** from the Actions tab (same workflow every other
   Worker secret in this repo goes through) — it reads that repository secret and
   pushes it to the Worker. Unlike `consensus_claude_api`, nothing else needs a copy of
   this one; there's no separate batch script for this app.
4. Confirm it took: open the control panel (`/job-description/control-panel`) → **Data
   source** tab → **Claude key** card should say Configured.

**Pick a Box folder** (optional, but recommended, same as every other mini app's data
folder): open the control panel and, under **Data source**, **Choose folder…**. Every
upload gets its own subfolder there (named after the session), holding the original file
plus every generated output — the three Word files and the summary. If no folder is
chosen yet, the tool still works end to end and the downloads still work; it just
doesn't save anything durably outside the session record in KV.

**Document parsing**: a PDF is handed to Claude directly (it reads PDFs natively — no
separate parsing). A `.docx` has no equivalent native support, so this app extracts its
text itself with a small ZIP/DEFLATE reader built into `src/job_description.js` — no
new dependency, matching this repo's zero-runtime-dependency Worker code. It handles a
standard Word-written `.docx`; an unusual writer or a ZIP64 archive returns a clear
error rather than a silent wrong extraction.

**Supervisor/incumbent comparison** (optional): the toolkit asks for an incumbent and a
supervisor to read the description separately, because where the two disagree is where
the real work is. On the "What Claude found" screen, the respondent can generate a
shareable link
(`/job-description/respond.html?token=...`) covering just the duty reality-check. If
both people respond, only the duties where their answers differ are surfaced back to
the primary respondent to resolve — nothing else about the session is required from a
second respondent.

---

## 15 · Apprenticeship Readiness Toolbox

A set of chat-style self-assessments that tell an employer how ready they actually are
to run a registered apprenticeship — and, where they are not, what to do about it.

**Projects hold assessments.** A *project* is one programme. Inside it an admin builds
one or more *assessments*, each made of *sections*, each section made of *questions*.
Everything a given person finishes inside a project rolls up into one readiness
dashboard for them.

**The respondent's experience.** Every assessment opens with name, company and email,
then runs as a chat. Each section leads with its own context, each question leads with
its own, and the person answers in their own words — nothing is multiple choice, because
the point is to find out what an employer actually has in place rather than what they can
recognise from a list.

**When an answer isn't an answer.** Claude reads each answer as it arrives and decides
two separate things: whether the person engaged with the question at all, and how far
what they said meets the scoring criteria the admin wrote. Those never get confused. An
honest *"nobody owns it yet"* is fully responsive and simply scores low — that is the
most useful answer this tool can collect, and it is never flagged.

A genuinely non-responsive answer (off-topic, empty, a refusal, an attempt to instruct
the chat) gets **one** redirect: a sentence of extra context, then the question again.
If the second attempt is non-responsive too, the question is flagged, scored zero, and
written to the issue log, and the assessment moves on rather than badgering. At the end,
the respondent is told that the flagged questions aren't reflected in their score and
that they should talk to Conexus staff.

**The safety shut-off.** Three consecutive questions finalised as non-responsive stops
the assessment with an apology and a note to contact Conexus staff. Only non-responsive
answers count toward that streak — an honest low score can never trigger it.

**What they get at the end.** A readiness breakdown per section (`4/5` for
*Organizational Commitment*, and so on), an overall percentage with a band, and
Claude-written improvement areas for each section grounded in what they actually said:

| Overall | Band |
|---|---|
| 85% and above | Strong Readiness |
| 60% to 84.9% | Moderate Readiness |
| Below 60% | Build Readiness First |

**What the admin sees** (`/apprenticeship/control-panel`): projects and the assessment
editor; per-assessment cohort readiness (band counts and the section averages across
every completed response, so the weakest section for the whole cohort is obvious); every
individual response with its scores and the reason behind each; a CSV of the lot; and
the **issue log** — every question that needed a redirect, showing the original question,
the original response, the follow-up question and the follow-up response together.

**Scoring criteria is a required field on every question.** It is what the per-answer
model scores against. Without it a model sets its own bar and moves it between
respondents, which would make two identical answers score differently and quietly
destroy the only number this tool produces. Section *objectives* are likewise private:
they steer the scoring and the end-of-survey advice, and respondents never see them.
Nothing in the public API returns criteria, objectives or point values.

**This app needs its own Anthropic API key**, for the same reason the Job Description
Updater does: both of its Claude calls run live in the Worker while someone waits. One
reads each answer as it arrives (on the cheapest model, since the judgement is narrow and
the admin's criteria is explicit); one writes the improvement areas at the end, on the
repo's default model, because it is the only thing the respondent takes away.

1. Create the key in your Anthropic account.
2. Add it as a repository secret named exactly **`apprenticeship_claude_api`**
   (Settings → Secrets and variables → Actions → New repository secret).
3. Run **Set Cloudflare secrets** from the Actions tab. Nothing else needs a copy of this
   one — there is no batch script for this app.

**Where the data lives.** Workers KV, under an `apprenticeship:` prefix — projects,
assessments and responses. Unlike Consensus, the run state (the cursor, the scores, the
non-responsive streak, the issue log) is written and read only by the Worker, never
trusted from the browser, because that same state decides a score, a flag and a shut-off.
No Box folder is involved; the admin CSV is the export path.

---

## Notes for a security review

- **Box access is user-delegated, one shared app**: the app acts as you, so it can reach
  exactly what your own account can reach and nothing else. There is no service account
  with enterprise-wide reach. It has both read and write scope, used by every mini app
  in this repo — Council Themes/Quant write only to the configured Data Folder;
  Issue Network Mapper to whichever data folder each of its projects has been pointed at;
  Manufacturing Conditions Monitor to its own single folder (step 11); STARs Talent
  Transfer Explorer to its own single folder (step 12), and only when one has been
  chosen — none of it touches anything else in your Box account. (Artifact Catalogue,
  step 13, doesn't use Box at all — its entries are just small metadata in KV.) Job
  Description Updater (step 14) writes to its own single folder the same way, one
  subfolder per session.
- **Claude sees survey responses and Feedback Log rows, nothing else.** Each analysis
  run sends a new meeting's free-text answers (organization name and rating numbers
  included, but never the respondent's name — those columns are stripped before the
  request) and the existing Feedback Log's items to the Claude API, and nothing else in
  your Box account. Both calls are logged in the Actions run's own output. Job
  Description Updater sends Claude the uploaded job description itself plus the
  employer's own answers as they're given (step 14) — never anything else from Box, and
  nothing from any other mini app's data. The credential shortlist it chooses from is
  scored on the Worker with no API call, so the credential reference itself is never
  sent anywhere.
- **Credentials never reach a browser.** The Box client secret, the GitHub token, and the
  Anthropic API key live in Cloudflare Worker / GitHub Actions secrets respectively; the
  Box token pair lives in Workers KV. Every control panel only ever holds a short-lived
  session token, and file uploads are proxied through the Worker so a Box token never
  reaches the browser either.
- **Revocable in one click.** *Disconnect* (Council Themes/Quant's control panel,
  Developer section) deletes the stored token pair, and you can revoke the app's access
  from your own Box account settings at any time. Every other mini app's own Box
  connection is the same underlying token, so this disconnects all of them at once.
- **Auditable.** Every analysis run is a logged GitHub Actions run showing when it ran,
  who triggered it, and exactly what it extracted, appended, and published.
- **The admin accounts (`/api/beta/*`) are a separate, lighter-weight system** from
  Box/GitHub credentials, and now the *only* sign-in system in this app — there is no
  per-app password anywhere any more. Passwords are hashed (PBKDF2-SHA256, a random
  salt per account) — never stored or logged in plain text — and session tokens are
  HMAC-signed, not cookies, so there's nothing for a CSRF attack to ride on. The
  iteration count is intentionally lower than a typical server-side recommendation,
  because it has to fit inside a Cloudflare Worker's per-request CPU budget (not
  wall-clock time) rather than a normal server's — see the comment above
  `PBKDF2_ITERATIONS` in `src/beta_auth.js` for the actual numbers. What it does *not* do
  is verify email ownership before letting someone set a password (see step 8 above) — a
  deliberate simplicity trade for a small, trusted admin list, not an oversight.
- **Per-app visibility (Settings, step 8) is a curation/UI control, not a hard access
  boundary for static-JSON pages.** "Admin-only" gates the *page* the same way every
  admin page here already gates itself (a client-side session check redirecting to
  sign-in), but does not additionally lock the underlying static JSON files
  (`council-themes.json`, `quant-dashboard.json`, `/mcm/data.json`, etc.) — those stay
  fetchable directly by anyone who already knows or guesses the exact filename. Nothing
  in any of them is more sensitive than what "Public" already shows by design (see
  step 8's note on this), so this is a deliberate, documented tradeoff, not a gap
  discovered later.
- **Consensus's respondent-facing routes are intentionally public and unauthenticated**
  (`GET /api/consensus/public/*`, `POST /api/consensus/followup`, `POST
  /api/consensus/submit`) — that's the whole point of a survey link. None of them trust
  the client for anything that matters: which follow-up to generate (and how many to
  allow) is read from the stored survey, never from the request, and `submit` only
  writes to the one Box folder that survey's admin already configured. The control
  panel routes (create/edit a survey, trigger analysis) require a signed-in admin
  account, same as the rest of the platform.
- **Issue Network Mapper's network view is the one page in this repo that loads an external
  script** (D3, from a CDN) — needed for the force-directed graph layout; every other
  page here is hand-rolled with no third-party JS. It's a static, widely-used
  visualization library with no data collection of its own; nothing it renders is
  fetched from anywhere but this Worker's own `GET /api/pcn/network`.
- **Manufacturing Conditions Monitor's published dashboard** (`public/mcm/index.html`)
  only ever reads static SEC-filing facts and Claude-written narrative text, nothing
  about council members or survey respondents — whether it's currently public is set in
  Settings (step 8), same as Council Themes/Quant's own dashboard. Only its control
  panel (`public/mcm/control-panel/index.html`), which *runs* the download/analyze/
  publish jobs, always requires a signed-in admin account. `SEC_CONTACT_EMAIL` is not
  sensitive — it's sent in plain text as part of SEC EDGAR's required fair-access
  request header, the same way any browser's user agent is — it's a repository secret
  only because there's no other per-repo config file for it.

---

## When something looks wrong

| Symptom | Cause |
| --- | --- |
| Any control panel says "Not signed in" right after signing in | Your session expired (8 hours) or a page cached an old token — sign out and back in at `/admin/login.html`. |
| Box login returns an error | The redirect URI in the Box app does not exactly match `https://<worker>/api/box/callback` — check the shared app has *both* projects' callback URLs listed (step 3). |
| "Login link expired or was already used" | The one-time state value is spent. Click **Log in with Box** again. |
| "Could not start: GitHub refused the trigger (404)" | The workflow file (`update_dashboard.yml` / `setup_analysis.yml`) isn't on the branch the Worker dispatches to (`GITHUB_BRANCH`, default `main`) — check it's merged. |
| An Actions run fails with a 401 from the relay | `BOX_RELAY_SECRET` differs between the repository secret and the Worker secret. |
| An Actions run fails with "Box is not connected" | Nobody has logged in with Box yet. Open the panel. |
| An Actions run fails with "Set up the Data Folder first" | The Data Folder hasn't been chosen yet. Open the panel. |
| Update Dashboard says "No new meetings found" | Every meeting in the current Post-Meeting Survey export is already in `data/feedback_log.json` — this is expected if nothing new was uploaded, not a bug. |
| Run succeeds, page unchanged | Nothing changed, or Cloudflare is still redeploying. Give it a minute. |
| A tab says "isn't wired up yet" | Its `pageId` is still a placeholder. See step 7. |
| `/admin/login.html` says "That email isn't on the admin list" for poneill | `poneill_password` hasn't been set as a repository secret and pushed via **Set Cloudflare secrets** yet, or `BOX_KV` isn't bound. See step 8. |
| "Set up new account" says the account already has a password, but you've never signed in | Someone else already claimed that email (see the "worth knowing" note in step 8) — ask an existing admin to **Reset** it under Manage admins, then try again. |
| Consensus chat says it can't generate a follow-up question | `consensus_claude_api` hasn't been set as a repository secret and pushed to the Worker via **Set Cloudflare secrets** yet. See step 9. |
| **Set Cloudflare secrets** reports success but a key/secret still shows as missing on the live site, for every secret at once, not just one | `wrangler.jsonc`'s `"name"` doesn't match the Worker's actual name in the Cloudflare dashboard (Workers & Pages → the one "Workers Builds" deploys to). `wrangler secret put` creates a Worker under whatever name it's given if none exists yet, so a mismatch here silently sends every secret to a separate, never-deployed Worker instead of erroring — this happened once already (see `wrangler.jsonc`'s comment on `"name"`). Fix the name in `wrangler.jsonc` to match the dashboard, commit, then re-run **Set Cloudflare secrets**. |
| Consensus "Analyze" fails with "No responses have been collected yet" | Nobody has completed the respondent chat for that survey yet -- `responseCount` is still 0. |
| Consensus "Analyze" fails with "the responses file doesn't exist in Box" | Same as above, or the survey's responses folder was changed after respondents already answered — check the survey's Box folder still matches where they were saved. |
| Issue Network Mapper's Box status says "Not connected" | Nobody has logged in with Box yet on this Worker — same fix as Council Themes/Quant's own "Box is not connected": open `/council-data/control-panel/index.html`'s Developer section and log in. |
| Issue Network Mapper's "Test Box round-trip" fails | No data folder has been chosen yet (**Choose folder…** in its control panel), or the Box connection expired — try logging in with Box again. |
| Issue Network Mapper's "Run pipeline" button stays disabled | There are no "Pending" meetings in the table — upload one first. |
| Issue Network Mapper's "Run pipeline" fails immediately | `PANEL_GITHUB_TOKEN`/`GITHUB_REPO` aren't set up on this Worker — same secrets the Council app's own **Update Dashboard** button needs (see section 4 above). |
| Issue Network Mapper's network/timeline pages look empty after switching projects | Each project has its own network/timeline, only populated once that specific project has run its pipeline at least once — check the URL's `?project=` matches the one you just ran. |
| A new Issue Network Mapper project's name collides with an existing one | Its id gets a numeric suffix automatically (`-2`, `-3`, ...) rather than failing — check the **Project** dropdown for the exact name if you're not sure which is which. |
| A meeting shows "Failed" in the Meetings table | Its error is shown right in the table — often an unreadable/corrupt file for its declared type; fix the file and re-upload it as a new meeting (the failed one is left as-is, not retried automatically). |
