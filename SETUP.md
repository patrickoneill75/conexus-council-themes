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
| `public/admin.html` | Worker static assets | The control panel. Password, Box login, folder picker, Refresh button. |
| `src/worker.js` | Cloudflare Worker | `/api/*`. Holds the password, the GitHub token and the Box credentials. |
| `scripts/run_refresh.py` | GitHub Actions | Reads the Box folder, writes `public/themes.json`, commits. |

---

## 1 · The repository

1. Create a repository — say `conexus-council-themes` — and upload every file from this
   project, keeping the folder structure.
2. `Settings → Actions → General → Workflow permissions` → **Read and write permissions**.
   Without this the refresh run cannot commit.
3. Open `wrangler.jsonc` and set `GITHUB_REPO` to your repository in `owner/name` form.

---

## 2 · Cloudflare

1. In the Cloudflare dashboard, **Workers & Pages → Create → Import a repository**, and
   point it at this repo. It reads `wrangler.jsonc` and deploys on every push.
2. **Storage & Databases → KV → Create a namespace**, name it `THEMES_BOX`. Copy its ID
   into `wrangler.jsonc` under `kv_namespaces`, replacing
   `PASTE_YOUR_KV_NAMESPACE_ID_HERE`, and commit.

   This is where the Box connection lives: the token pair (the refresh token rotates on
   every use, so it cannot be a static secret) and the folder you pick in the panel.
3. Note the Worker's address — `https://conexus-council-themes.<subdomain>.workers.dev`.

---

## 3 · The Box app

1. `app.box.com/developers/console` → your app → **Configuration**.
2. Authentication method: **User Authentication (OAuth 2.0)**. This is the "Log in with
   Box" flow — the app acts as *you*, so it sees exactly what you see and nothing more.
3. **Application Scopes**: tick only **Read all files and folders stored in Box**. This
   tool never writes to Box.
4. **OAuth 2.0 Redirect URI** — add exactly:

   ```
   https://<your-worker-address>/api/box/callback
   ```

   Box rejects the login if this does not match character for character.
5. Copy the **Client ID** and **Client Secret**.

---

## 4 · Secrets

Add these under `Settings → Secrets and variables → Actions` in your repository:

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages → Account details |
| `CONTROL_PASSWORD` | A password you choose for the control panel |
| `PANEL_GITHUB_TOKEN` | A fine-grained GitHub token, this repo only, **Actions: read and write** |
| `BOX_CLIENT_ID` | Box app Configuration tab |
| `BOX_CLIENT_SECRET` | Box app Configuration tab |
| `BOX_RELAY_SECRET` | A long random string you make up |
| `BOX_RELAY_URL` | `https://<your-worker-address>/api/box/pipeline-token` |

Then run **Actions → Set Cloudflare secrets → Run workflow**. That hands the Worker-side
values to Cloudflare for you, which is the step that would otherwise need a terminal.

`BOX_RELAY_SECRET` is deliberately in both places: the Worker checks it, and the refresh
run sends it. They must be the same value.

Check it worked by opening `https://<your-worker-address>/api/config-check`. You are
looking for `"configured": true`.

---

## 5 · Connect Box

1. Open `https://<your-worker-address>/admin.html` and sign in with `CONTROL_PASSWORD`.
2. **Log in with Box**. Box asks you to authorise the app; it comes back to the panel.
3. The folder picker opens by itself the first time. Browse to the folder holding the
   meeting documents — it tells you how many Word documents are in each folder as you go,
   so you can confirm you are in the right one — then **Use this folder**.
4. **Refresh and publish**. The button shows the run progressing and links to its log.

---

## 6 · Naming the documents

```
2026-Q2-Central.docx   ->   Q2 2026 Central Council meeting
```

Year, hyphen, quarter, hyphen, council. The council name is whatever comes after the
second hyphen, so adding a council needs no code change. Anything that does not match is
listed as **Skipped** in the panel with the reason, so drafts can live in the same folder.

Documents are read from the chosen folder only — subfolders are not walked, which keeps
"why did that not appear" a question with one answer.

**Use Word's real Heading styles** for theme titles. That is what groups the bullets into
sections. Bold text that merely looks like a heading gives the parser nothing, and the
panel will flag the document as **No headings**.

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

- **Box access is read-only**, one scope, and user-delegated: the app acts as you, so it
  can reach exactly what your own account can reach and nothing else. There is no service
  account with enterprise-wide reach.
- **No AI.** The refresh extracts text from Word files. No model is called at any point.
- **Credentials never reach a browser.** The Box client secret and the GitHub token live
  in Cloudflare Worker secrets; the Box token pair lives in Workers KV. The control panel
  only ever holds a short-lived session token.
- **Revocable in one click.** *Disconnect* in the panel deletes the stored token pair, and
  you can revoke the app's access from your own Box account settings at any time.
- **Auditable.** Every refresh is a logged GitHub Actions run showing when it ran, who
  triggered it, and which documents it read or skipped.

---

## When something looks wrong

| Symptom | Cause |
| --- | --- |
| Login says "not configured" | The Set Cloudflare secrets workflow has not run, or ran against a different Worker. The error message names the Worker serving the page. |
| Box login returns an error | The redirect URI in the Box app does not exactly match `https://<worker>/api/box/callback`. |
| "Login link expired or was already used" | The one-time state value is spent. Click **Log in with Box** again. |
| Refresh fails with 401 from the relay | `BOX_RELAY_SECRET` differs between the repository secret and the Worker secret. |
| Refresh fails with "Box is not connected" | Nobody has logged in with Box yet, or no folder is chosen. Open the panel. |
| Run succeeds, page unchanged | Nothing in Box changed, or Cloudflare is still redeploying. Give it a minute. |
| Everything skipped, nothing published | No filename matched. The run deliberately leaves the last good `themes.json` in place rather than publishing an empty page. |
| A tab says "isn't wired up yet" | Its `pageId` is still a placeholder. See step 7. |
