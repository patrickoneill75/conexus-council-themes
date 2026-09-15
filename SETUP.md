# Setup

Same architecture as `conexus-mcm`: a Cloudflare Worker serves `public/` and handles
`/api/*`, the control panel logs in with Box and picks a folder, and a GitHub Actions run
does the reading and publishing. Nothing secret ever reaches the browser.

Everything below is done in a browser. There are no terminal steps.

---

## What you end up with

| Piece | Where it lives | What it does |
| --- | --- | --- |
| `public/index.html` | Worker static assets | The public dashboard. Power BI pages plus the Council Themes tab. No login. |
| `public/admin.html` | Worker static assets | The control panel. Survey upload and Update Dashboard on the main page; Box login, folder/file pickers, and Run full re-analysis under Developer. |
| `src/worker.js` | Cloudflare Worker | `/api/*`. Holds the password, the GitHub token and the Box credentials. |
| `scripts/update_dashboard.py` | GitHub Actions | Extracts feedback items from the uploaded survey with Claude, appends them to the tracker spreadsheet in Box, publishes that quarter's themes, then rebuilds the quant dashboard from every survey file in the New Survey Directory. |
| `scripts/setup_analysis.py` | GitHub Actions | Re-synthesizes every quarter already in the tracker, no new survey involved — the one-time bootstrap (or a full redo). |

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
3. Note the Worker's address — `https://conexus-council-themes.<subdomain>.workers.dev`.

---

## 3 · The Box app

This project's Box app is **shared with conexus-mcm** — same Client ID/Secret, same
Box Developer Console app. Reuse that app rather than creating a new one:

1. `app.box.com/developers/console` → the shared app → **Configuration**.
2. Authentication method: **User Authentication (OAuth 2.0)**. This is the "Log in with
   Box" flow — the app acts as *you*, so it sees exactly what you see and nothing more.
3. **Application Scopes** should already have **Read and write all files and folders
   stored in Box** checked (conexus-mcm needs write access, so this app already has it —
   this project needs it too, to upload survey files and update the tracker spreadsheet).
   If it only has read checked, add write now and **Save Changes**.
4. **OAuth 2.0 Redirect URI** — this field takes one URI per line. Make sure **both**
   projects' callback URLs are listed:

   ```
   https://<conexus-mcm-worker-address>/api/box/callback
   https://<conexus-council-themes-worker-address>/api/box/callback
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
| `CONTROL_PASSWORD` | A password you choose for the control panel |
| `PANEL_GITHUB_TOKEN` | A fine-grained GitHub token, this repo only, **Actions: read and write** |
| `BOX_CLIENT_ID` | Box app Configuration tab (the shared app — see step 3) |
| `BOX_CLIENT_SECRET` | Box app Configuration tab (the shared app — see step 3) |
| `BOX_RELAY_SECRET` | A long random string you make up |
| `BOX_RELAY_URL` | `https://<your-worker-address>/api/box/pipeline-token` |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → Settings → API Keys |

`ANTHROPIC_API_KEY` is the one exception to "everything is done in a browser, no
terminal" being about secrets specifically living in *this* repository's GitHub
settings — it's only ever read by the Python scripts running in GitHub Actions, so
unlike the others it does **not** need to go to Cloudflare at all.

Everything else, run **Actions → Set Cloudflare secrets → Run workflow**. That hands the
Worker-side values to Cloudflare for you, which is the step that would otherwise need a
terminal.

`BOX_RELAY_SECRET` is deliberately in both places: the Worker checks it, and an analysis
run sends it. They must be the same value.

Check it worked by opening `https://<your-worker-address>/api/config-check`. You are
looking for `"configured": true`.

---

## 5 · Connect Box and set up the panel

1. Open `https://<your-worker-address>/admin.html` and sign in with `CONTROL_PASSWORD`.
2. **Log in with Box**. Box asks you to authorise the app; it comes back to the panel.
3. **Synthesis Data File** → **Choose file…** and pick the tracker spreadsheet in Box
   (upload `Council_Survey_Feedback_Tracker_Template.xlsx`, or your own, into Box first
   if it isn't there yet). This is the running history every analysis reads and appends to.
4. **New Survey Directory** → **Choose folder…** and pick (or create) a Box folder for
   raw survey exports to land in. This is the one shared source both the natural-language
   analysis and the quant dashboard read from. Set this once — there's no need to revisit
   it quarterly.
5. Under **Developer → Full re-analysis**, click **Run full re-analysis**. This is the
   one-time bootstrap: it synthesizes current/QoQ/YoY themes for every quarter already
   sitting in the Synthesis Data File and publishes them, with no new survey involved.
   Re-run it any time you want every quarter redone from scratch (e.g. after a taxonomy
   change).

From here on, each new quarter: **New Survey Upload** (the raw export, plus Year/Quarter/
Region), then **Update Dashboard**.

---

## 6 · The taxonomy

The tracker's `Lists` tab holds the fixed Category → Subcategory vocabulary (its own
`How to Use` tab explains it). Claude is given this list on every extraction run and
told to reuse an existing pair whenever one reasonably fits, only writing a new
Subcategory when nothing listed fits at all — the tracker's value comes from the same
label being reused across quarters, so resist adding new ones often. Add one the same
way a human would per the tracker's own instructions: column B of `Lists`, then extend
the `SubcategoryList` named range.

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

## Notes for a security review

- **Box access is user-delegated, one shared app**: the app acts as you, so it can reach
  exactly what your own account can reach and nothing else. There is no service account
  with enterprise-wide reach. It has both read and write scope (shared with conexus-mcm,
  which needs write) — this project uses write only to upload survey files into the
  configured upload folder and to push new versions of the tracker spreadsheet; it never
  touches anything else in your Box account.
- **Claude sees survey responses and tracker rows, nothing else.** Each analysis run
  sends the uploaded survey's free-text answers (organization name and rating numbers
  included, but never the respondent's name — those columns are stripped before the
  request) and the tracker's existing feedback items to the Claude API, and nothing
  else in your Box account. Both calls are logged in the Actions run's own output.
- **Credentials never reach a browser.** The Box client secret, the GitHub token, and the
  Anthropic API key live in Cloudflare Worker / GitHub Actions secrets respectively; the
  Box token pair lives in Workers KV. The control panel only ever holds a short-lived
  session token, and survey uploads are proxied through the Worker so a Box token never
  reaches the browser either.
- **Revocable in one click.** *Disconnect* in the panel deletes the stored token pair, and
  you can revoke the app's access from your own Box account settings at any time.
- **Auditable.** Every analysis run is a logged GitHub Actions run showing when it ran,
  who triggered it, and exactly what it extracted, appended, and published.

---

## When something looks wrong

| Symptom | Cause |
| --- | --- |
| Login says "not configured" | The Set Cloudflare secrets workflow has not run, or ran against a different Worker. The error message names the Worker serving the page. |
| Box login returns an error | The redirect URI in the Box app does not exactly match `https://<worker>/api/box/callback` — check the shared app has *both* projects' callback URLs listed (step 3). |
| "Login link expired or was already used" | The one-time state value is spent. Click **Log in with Box** again. |
| "Could not start: GitHub refused the trigger (404)" | The workflow file (`update_dashboard.yml` / `setup_analysis.yml`) isn't on the branch the Worker dispatches to (`GITHUB_BRANCH`, default `main`) — check it's merged. |
| An Actions run fails with a 401 from the relay | `BOX_RELAY_SECRET` differs between the repository secret and the Worker secret. |
| An Actions run fails with "Box is not connected" | Nobody has logged in with Box yet. Open the panel. |
| An Actions run fails with "Set up the upload folder and tracker file first" | The Synthesis Data File and/or New Survey Directory haven't been chosen yet. Open the panel. |
| Update Dashboard fails with "already has rows in the tracker" | That Year/Quarter/Region combination was already analyzed once — this is a safeguard against double-appending, not a bug. Pick the next quarter, or edit the tracker by hand in Box if you genuinely need to redo one. |
| Run succeeds, page unchanged | Nothing changed, or Cloudflare is still redeploying. Give it a minute. |
| A tab says "isn't wired up yet" | Its `pageId` is still a placeholder. See step 7. |
