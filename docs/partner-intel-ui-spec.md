# Partner Intelligence: UI and UX rebuild spec

This spec describes the Partner Intelligence staff app exactly as it is built today, so it can be rebuilt to look and behave the same. It covers every page, what each shows, how lists and tables are ordered and sorted, every animation, and the admin control panel.

**How to use it.** Build from Part 0 first: it holds the facts that change everything else. Exact values (px, ms, hex colours, easing curves, strings) come from the code. References such as `I:719` or `CSS:288` point to lines in the source files at commit `e18d87d` of `patrickoneill75/conexus-council-themes`:

| Short name | File |
| --- | --- |
| I, IH, IX | `public/partner-intel/index.html` (the staff app: every page) |
| C, CSS | `public/partner-intel/pi.css` (all styles) |
| J, PJ | `public/partner-intel/pi.js` (shared helpers, statement cards) |
| A, AB | `public/partner-intel/askbox.js` (the floating Ask box and answer renderers) |
| CP | `public/partner-intel/control-panel/index.html` (admin control panel) |
| S, SRV | `src/partner_intel.js` (the server: sort orders and response shapes) |

The three parts were written from separate reads of the code, so a few facts appear in more than one place. They agree; where one part goes deeper, it says so.

## Part 0: Read this first

### Facts that change everything else

1. **Desktop zoom.** At 761px and wider, the page content (`.pi-app .wrap`) has `zoom:.8`, `max-width:1400px` and 40px side padding (CSS:288). Every px value inside the content renders at 80% on desktop. The top bar and the floating Ask box sit outside `.wrap` and render at full size.
2. **"Accent" is navy in the app.** Inside `body.pi-app`, `--accent` is `#07214e` (navy), not brand blue `#325eae` (CSS:252). Anything described as accent renders navy. The control panel has no `pi-app` class, so there `--accent` stays `#325eae`.
3. **Font:** `Aptos, "Segoe UI", Arial, sans-serif`, with no web font loaded. **No dark mode.**
4. **Page background:** a fixed 165deg gradient (white to `#f2f2f4` to `#d9dfea`) with three blurred, slowly drifting "clouds" behind the content. Details in Part 1, section 0.2.
5. **Routing** is hash based (`#/home`, `#/companies`, `#/company/<id>/<tab>`, `#/programs`, `#/program/<name>`, `#/meeting/<program>/<id>`, `#/ask`). Every route change scrolls to the top, except switching tabs within the same company page.

### How lists move: the short version

The current app has **no list entry animations**:

1. Lists and tables render instantly by replacing their HTML. Nothing fades or slides in row by row. There is no stagger, no per-item delay and no FLIP reordering. Sorting the Companies table and "Show more" / "View all" reveals are also instant.
2. The motion is concentrated in a few places, each detailed later:
   - **Numbered topic lists** (Home, program pages, company tabs, Ask matches). The number circle pops with a spring, the connecting line grows to the open topic's full height, a yellow highlight wipes across the first word or two of the topic name, and the chevron under topic 1 dips twice after 1.2s as a cue. Only one topic is open at a time. Part 1, section 1, and Part 2A, section 1.9.
   - **Segmented controls with a sliding lens.** The 30/60/90-day window on Home and program pages uses a frosted glass lens. The company tabs use a navy pill. Both slide over 0.6s with `cubic-bezier(.22,1,.36,1)` and squash-stretch for 220ms. The company pill uses the CSS `translate` and `scale` properties so it stretches about its own centre. Part 1, section 2, and Part 2A, section 1.6.
   - **Content swaps.** Switching a company tab fades the panel out over 0.14s, swaps it, and fades it back over 0.18s, with the panel height held so the page does not jump. Changing the time window waits 160ms in a fade.
   - **Small touches:** the meeting row chevron rotates 90deg (0.25s), arrows nudge on hover, program cards gain a ring, the Ask box grows open, the Ask page pill moves with a FLIP, citations flash, and a spinner shows while loading.
3. All of it respects `prefers-reduced-motion`, except the spinner and a few hover colour changes. Part 2B, section 2.8.

If the rebuild should animate lists as they appear, that is a new design decision. The current tool does not do it.

### Default order of every list

| List | Default order | Initial count | Can the user sort? |
| --- | --- | --- | --- |
| Home: Trending topics | Companies raising it, desc; then meetings, desc; then meetings with a high-urgency issue, desc; then name. Issues only, "other" excluded, max 15 | 5, then "Show N more topics" adds 5 at a time | No; 30/60/90-day window, default 90 |
| Programs | Newest note desc, then name; programs with no dated notes last | All | No |
| A program's meetings | Date desc, then label; server max 300 | 12, then "Show more" adds 12 | No |
| A program's trending topics | As Home, within the program | As Home | No; window default all time |
| Companies | Name A to Z | All, up to 500 | Yes, every column. First click: text columns A to Z, Notes and Last mentioned high to low. Click again to reverse. Ties by name. Never-mentioned companies always last on Last mentioned. Sort kept until reload. |
| Company: topics (Overview, Issues, Solutions, Wins) | "Other" last; then a recency-weighted count of live mentions, desc (each mention counts 1/(1 + age in days/180)); then last raised, desc; then name | 3, then "Show N more" reveals the rest | No; "By topic" or "Latest source" view |
| Company: statements within a topic | Live before resolved; then date desc; then issues, solutions, wins; then urgency; then id | Overview: 3 per column, then "View all" | No |
| Company: Meetings | Date desc, then label | 10, then "Show N more meetings" | No |
| Company: Contacts | Name A to Z | All | No |


---

## Part 1: Shell, shared components and pages

Everything except the company page, the floating Ask box and the control panel.

Files and the short names used in references:
- **I** = `/home/user/conexus-council-themes/public/partner-intel/index.html`
- **C** = `/home/user/conexus-council-themes/public/partner-intel/pi.css`
- **J** = `/home/user/conexus-council-themes/public/partner-intel/pi.js`
- **A** = `/home/user/conexus-council-themes/public/partner-intel/askbox.js` (the floating Ask box, plus the answer, history and source renderers that the Ask page uses)
- **S** = `/home/user/conexus-council-themes/src/partner_intel.js` (server-side sorting and response shapes)
- `/home/user/conexus-council-themes/public/access.js` (the access gate)

**Read this first.** Inside `body.pi-app`, `--accent` is redefined to navy `#07214e` (C:252). Every "accent" colour in this app is therefore navy, not brand blue `#325eae`. Several hover states that change to the accent colour look identical before and after, for example `.asx-go:hover` (C:858) and `button.pm:hover i` (C:486).

---

### 0. Global shell

#### 0.1 Document and boot
1. The title is fixed for every route: `Partner Intelligence — Connector`, with a real em dash (I:6). The title never changes per route.
2. The favicon is an inline SVG (I:8): a navy `#07214e` rounded square with rx 7, white circles at (11,16) r4 and (22,22) r3, and an amber `#fbae40` circle at (22,10) r3.
3. `<html>` starts with `visibility:hidden` (I:10). The page script sets it visible once `window.PI` exists (I:39).
4. `access.js` (I:7, `data-app="partner-intel" data-need="use"`) hides `body` with `html.access-pending` until `GET /api/beta/me` answers.
   - A user without access sees a "You don't have access to this app" card.
   - It also hides the "Control panel" link with an inline `display:none` when the user is not an app admin (access.js:94-103).
5. Auth (J:5-10):
   - The token comes from `sessionStorage["beta-token"]`.
   - With no token, the page calls `location.replace("/admin/login.html?next=" + encodeURIComponent(path+search+hash))`.
   - Every API call sends `authorization: Bearer <token>` and `content-type: application/json` to `/api/partner-intel/<path>` (J:77-88).
   - A 401 response signs the user out with the same redirect (J:82).
   - Any non-OK response throws `Error(body.error || "HTTP <status>")` carrying `.status` and `.body`.
6. "Sign out" (I:25, J:72-75) removes the token and goes to the login page with `next`.
7. `PI.whoami` (J:180-185) fetches `/api/beta/me` and fills `#whoami` with `"Signed in as " + (name || email)`. On failure it signs out. `#whoami` is `display:none` in the app (C:316), so this text never shows.
8. Nothing uses `localStorage`. All remembered state is in-memory module variables and resets on reload (grep confirmed).

#### 0.2 Page background (C:252-281)
1. The body background is `linear-gradient(165deg, #ffffff 0%, #f2f2f4 45%, #d9dfea 100%) fixed`, with body font 15px (C:257). The base body font is `14px/1.55 Aptos,"Segoe UI",Arial,sans-serif` (C:19).
2. Three fixed blurred "clouds" sit at `z-index:-1` with `pointer-events:none`, `filter:blur(90px)`, `will-change:transform` and `animation: ease-in-out infinite alternate` (C:258-259).

| Cloud | Position and size | Fill | Animation |
|---|---|---|---|
| `body::before` | left -180px, top 60px, 860x640 | `rgba(7,33,78,0.03)` | `pi-morph-a`, 42s |
| `body::after` | right -160px, top 260px, 720x620 | `rgba(50,94,174,0.05)` | `pi-morph-b`, 50s |
| `html:has(> body.pi-app)::before` | left 38%, bottom -260px, 560x520 | `rgba(50,94,174,0.10)` | `pi-morph-c`, 38s |

3. Each keyframe set animates `border-radius` and `transform: translate() rotate()` through 0%, 50% and 100% (C:266-274). Copy the exact values from those lines.
4. At ≤760px the blur drops to 56px and the sizes shrink (C:275-280):
   - before: left -120, top 40, 420x360
   - after: right -140, top 360, 380x340
   - html::before: left 20, bottom -120, 320x300
5. Under `prefers-reduced-motion:reduce` the clouds get `animation:none` (C:281).

#### 0.3 Content wrapper
1. `.pi-app .wrap` is `max-width:1120px; padding:44px 32px 96px`, centred (C:285).
2. **At ≥761px the wrapper has `zoom:.8; max-width:1400px; padding-left/right:40px`** (C:288). Every px value inside `.wrap` therefore renders at 80% on desktop. The top bar and the floating Ask box sit outside `.wrap` and are not zoomed.
3. At ≤600px the padding is `28px 16px 64px` (C:623).
4. When the floating Ask box is present (`body.ax-on`, every route except Ask), `.wrap` gets `padding-bottom:150px` (C:652, A:605).
5. On the Ask page in chat mode, the padding-bottom is 0 (C:808).
6. `html { scroll-padding-top:84px }` (C:39).

#### 0.4 Header and nav bar (I:13-28, C:33-50, C:293-316)
**Markup:** `header.appbar > div.in` holds:
- `a.appname[href="#/home"]` with the text "Partner Intelligence"
- `nav#nav.nav[aria-label=Main]` with four links, each wrapping its label in a `<span>`:
  - `#/home` with `data-r=home`, text "Home"
  - `#/companies` with `data-r=companies`, text "Companies"
  - `#/programs` with `data-r=programs`, text "Programs"
  - `#/ask` with `data-r=ask`, text "Ask"
- `div.tools` with `span#whoami`, `a[href="/partner-intel/control-panel/"]` "Control panel" and `button.link#signOut` "Sign out"

**Bar styles:**
1. The bar is `position:sticky; top:0; z-index:100`, background navy `#07214e`, text white (C:36).
2. `.in` is `max-width:1120px; margin:0 auto; padding:0 32px; display:flex; flex-wrap:wrap; align-items:stretch; gap:0 24px; min-height:64px` (C:40, C:295).
3. `.appname` is a flex box, vertically centred, 20px, weight 600, white, `margin-right:12px; padding:12px 0` (C:42, C:296). Hover keeps it white with no underline (C:297).
4. `.nav` is `display:flex; gap:4px; flex-wrap:wrap; flex:1 1 auto` (C:43, C:298).
5. Each nav link is a flex box, vertically centred, `padding:0 12px; border-top:4px solid transparent; border-bottom:4px solid transparent`, colour `--nav-text #c9d3e3`, 17px, weight 400 (C:299-300). Hover turns the text white with no underline (C:301).

**Active link and the yellow underline:**
1. `.pi-app .nav a.on` has white text, weight 500 and `border-bottom-color: var(--hl)`, where `--hl` is `#f9f871` (C:302, C:252).
2. The underline is the 4px bottom border. The transparent 4px top border balances it so the label stays centred.
3. The underline has no transition. It switches instantly.
4. The base amber rule at C:46 is overridden.

**Tools area:**
1. `.tools` is `display:flex; gap:18px; align-items:center; font-size:14px; color:#c9d3e3; padding:10px 0` (C:47, C:304).
2. Its links and the button are #c9d3e3 at weight 400 and turn white on hover (C:305-306).
3. The Sign out button has no border, no padding and no background, because `button.link` rules win (C:52, C:378 and C:305).

**Scroll behaviour (J:12-30):**
1. On `scroll` (passive), `resize` and `DOMContentLoaded`, the script toggles `.raised` when `scrollY > 2`.
2. `.raised` adds `box-shadow:0 2px 10px rgba(7,33,78,.10)` (C:37).
3. The bar's transition is `box-shadow .2s ease, transform .18s cubic-bezier(.25,1,.5,1)` (C:294).

**Phone layout (≤600px, C:307-315, overridden in part by C:624-625):**
1. `.in` becomes `display:grid; grid-template-columns:minmax(0,1fr) auto; padding:0 12px; gap:4px 12px`.
2. Row 1 holds `.appname` (17px) and `.tools` (12.5px, gap 14px). Both are `height:44px; padding:0; opacity:var(--fade)` with `transition:opacity .18s cubic-bezier(.25,1,.5,1)`.
3. Row 2 is the nav (`grid-column:1/-1; grid-row:2; gap:2px`). Each link is 15px with `padding:8px 8px`. The later rule at C:625 beats the `6px 10px 4px` at C:314.
4. The script sets `--lift = min(nav.offsetTop, round(scrollY))` and `--fade = 1 - lift/nav.offsetTop`. The bar has `transform:translateY(calc(-1 * var(--lift)))` (C:294).
5. `.lifted` (lift ≥ row height) hides `.appname` and `.tools` with `visibility:hidden` (C:312).
6. Net effect: the top row scrolls away pixel for pixel and the nav row stays pinned.

**Reduced motion:** `.appbar` gets `animation:none!important; transition:none!important` (C:499).

#### 0.5 Routing (I:1096-1118)
1. The page listens for `hashchange` and runs `route()` once on load. Nothing uses `pushState` or `popstate`. Back and Forward work as ordinary hash history.
2. Parsing:
   - `h = location.hash.replace(/^#\/?/, "") || "home"`
   - `parts = h.split("/")`
   - `name = parts[0]`
   - The router passes parts through `decodeURIComponent`.
3. Route table, in the order the code checks it:

| Hash | Handler |
|---|---|
| `#/programs` | `programs()` |
| `#/program/<name>` | `program(name)` (needs `parts[1]`) |
| `#/meeting/<program>/<id>` | `meeting(program, id)` (needs `parts[2]`) |
| `#/ask` | `ask()` |
| `#/companies` | `companies()` |
| `#/company/<id>[/<tab>]` | company page, out of my scope |
| anything else (`#/home`, empty, unknown, `#/program` with no name, `#/meeting/x` with no id) | `home()` |

4. **There is no not-found page.** Unknown routes render Home.
5. Nav highlight (I:1101-1105):
   - The active key is `"companies"` for `company`, `"programs"` for `program` and `meeting`, and `name` otherwise.
   - The matching link gets `.on` and `aria-current="page"`. The others lose both.
   - **Quirk:** an unknown hash such as `#/foo` renders Home but highlights no nav item. An empty hash highlights Home.
6. Scroll restoration:
   - After every route except a tab change within the same company page, `route()` calls `window.scrollTo(0,0)` (I:1106-1115).
   - The app saves no per-page scroll positions. Back and Forward always land at the top.
   - The code never sets `history.scrollRestoration`.
7. Each navigation re-renders `#view` from scratch and fetches again. A module counter `seq` increments on every page render. Each async callback checks `mine === seq` and drops stale answers (I:95 and every handler).
8. Module state kept across navigations until reload:

| Variable | Default | Meaning | Reference |
|---|---|---|---|
| `state.days` | 90 | Home window | I:46 |
| `state.programDays` | 0 | Program window, shared by all programs | I:46 |
| `state.sourceList` | null | Cached `/facets` result | I:46 |
| `chosen` | `""` | Ask program filter | I:47 |
| `companySort` | `{key:"name",dir:"asc"}` | Companies table sort | I:722 |

#### 0.6 Shared states
1. **Loading** (I:105): `<div class="card"><span class="spinner"></span>Loading…</div>`.
   - Spinner (C:165-167): 14x14, `border:2px solid #e1e2e9; border-top-color: navy; border-radius:50%`, `animation: spin .8s linear infinite`, `vertical-align:-2px; margin-right:6px`.
   - `@keyframes spin { to { transform:rotate(360deg) } }`.
   - Reduced motion does not disable the spinner.
2. **Error or empty data** (`emptyState`, I:97-103):
   - When `err.body.empty` is true (the server returns 409 with `empty:true` and no dataset; S:3975), the page shows: `<div class="card"><div class="empty"><b>There is no data yet.</b><br>Open the <a href="/partner-intel/control-panel/">control panel</a>, choose the Box folder, and run the first scan.</div></div>`.
   - Otherwise it shows `<div class="card"><div class="msg err">{err.message || "Something went wrong."}</div></div>`, with `.msg.err` at 12.5px in `#b3401f` (C:157-158).
   - Server messages include "Program not found." and "Meeting not found." (S:4038, S:4054).
3. **`.empty`** (C:154, C:342): `padding:28px 10px; text-align:center; color:#4a5663`.
4. **`.banner`** (C:155-156, C:343): `border:1px solid rgba(251,174,64,.6); background:rgba(251,174,64,.12); border-radius:16px; padding:12px 16px; margin-bottom:20px; font-size:13.5px`.
5. **Plurals** (I:106): `plural(n, one, many)` returns `n + " " + (n===1 ? one : many)`.
6. **Dates** (J:91-96):
   - `fmtDate(iso)` returns `"No date"` for a falsy value.
   - Otherwise it builds `new Date(iso+"T12:00:00Z")` and formats it with `toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"})`, for example `Mar 5, 2026`.
   - An invalid string comes back unchanged.
7. **Member label** (J:107): `"Council Member"` when status is `"Active"`, otherwise `"Not Council"`.

#### 0.7 Shared typography and components (pi-app overrides)
| Element | Style | Reference |
|---|---|---|
| `h1` | 44px, line-height 1.05, weight 700, letter-spacing -0.022em, navy. 32px at ≤600 (C:626 beats the base 26px at C:31) | C:319 |
| `.lede` | `margin:12px 0 0`, 20px, line-height 1.45, weight 600, navy, max-width 780px. 17px at ≤600 | C:320, C:628 |
| `h2.subh` | `margin:44px 0 0`, 22px, line-height 1.25, weight 700, navy | C:321 |
| `.secsub` | `margin:6px 0 0`, 15px, `#4a5663` | C:330 |
| `.card` | white background, no border, `border-radius:24px; padding:28px 36px; margin:20px 0 0`. `:first-child` keeps padding-top 28px. ≤600 padding `22px 18px` | C:338-339, C:629 |
| `.card > h2` and `.card > h3` | 22px, weight 700 | C:340 |
| Running-text links (`.wrap a:not([class])`, `.wrap button.link`) | underlined, `text-underline-offset:3px; text-decoration-thickness:1px` | C:283 |
| Base links | colour accent (navy), no underline. Hover: navy, underlined | C:21-22 |
| `.back` link (`backLink(href,text)`, I:81) | `inline-flex; align-items:center; gap:8px; margin:0 0 16px; font-size:15px; font-weight:700`. Left-arrow SVG (I:50, stroke-width 2.4) at 15x15 with `transition:transform .2s`. Hover: no underline and the SVG moves `translateX(-3px)` | C:331-333 |
| `.arrowlink` | `inline-flex; gap:6px; weight 700; navy`. Hover: SVG moves `translateX(3px)` with the same .2s transition | C:334-335 |
| `button.more` | `border:2px solid navy; background:#fff; color:navy; font-weight:700; padding:10px 22px; border-radius:999px; font-size:14px`. Hover: navy background, white text. No transition | C:346, C:348-349 |
| Inputs and selects | `height:46px; border:1.5px solid #c9d3e3; border-radius:12px; padding:0 14px; font-size:15px`. Focus: `outline:none; border-color:navy; box-shadow:0 0 0 3px #dce6f5` | C:371, C:374 |
| `label.field` | block, 13.5px, weight 600, `#4a5663`, `margin-bottom:6px` | C:375 |
| `label.chk` | `inline-flex; gap:8px; 14.5px`. Checkbox 17x17 with `accent-color:navy` | C:372, C:377 |
| `.fields` | `display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:16px 18px` | C:81, C:376 |

#### 0.8 Breakpoints used on these pages
1. **≤600px:** phone header, `.wrap` padding, h1 32px, lede 17px, card padding, topic row gap, font steps, `.band` padding, meeting-row grid (C:307-315, C:622-645). The Ask page pill also changes (C:883-893).
2. **≤700px:** floating Ask box (C:786-800).
3. **≤760px:** clouds shrink (C:275). Tables become `display:block; overflow-x:auto`, so the companies table scrolls sideways (C:244).
4. **≥761px:** `.wrap` zoom .8 (C:288).
5. **≤860px:** `.pgrid` goes to one column and `.fields > *` gets `grid-column:auto !important` (C:609-616).
6. **≤1100px and ≥1101px:** Ask history rail behaviour (C:827-831, C:878-882).

---

### 1. Numbered topic list (shared by Home, Program and Ask matches)

#### 1.1 Markup (`topicRow`, I:124-134)
```
<section class="tp[ open]" data-topic="<id>" [hidden]>
  <hN class="thead-h"><button type="button" class="tp-row" aria-expanded="false">
    <span class="circ" aria-hidden="true">{n}</span>
    <span><span class="tname"><span class="hl">{first word(s)}</span>{rest}{after}</span><span class="tmeta">{meta}</span></span>
  </button></hN>
  <i class="tline[ cue]" aria-hidden="true"></i>
  <div class="tbody" data-body hidden>{body}</div>
</section>
```
1. The heading tag `hN` is `h2` on Home and `h3` on a program page (I:336, I:390). The matches list uses the default `h3`.
2. The highlight (`hlWords`, I:114-118) covers the first word. It covers the first two words when the first word has at most 4 alphanumeric characters and more words follow. Trailing `,;:.` characters are stripped.
3. Only item number 1 gets `cue`, and only when it starts closed (I:132).

#### 1.2 Open and close behaviour (I:135-167)
1. Clicking a `.tp-row` toggles that topic open or closed.
2. The click also closes any other open `.tp` among `card.parentNode`'s direct `.tp` children. Only one topic is open per list.
3. The click removes `cue` from every topic in that list.
4. `setTopic` toggles `.open`, sets `aria-expanded`, and sets `[data-body].hidden`.
5. **The body appears or disappears instantly.** Nothing animates its height or opacity. Only the circle, the line and the highlight animate.
6. The `animate()` helper removes the classes, forces a reflow with `void offsetWidth`, then re-adds the class so a repeated animation restarts.
7. A global `animationend` listener removes `c-open c-close grow shrink hint cue a-shrink a-expand` (I:141-143).
8. `STILL` comes from `matchMedia("(prefers-reduced-motion: reduce)")`, read once at load (I:146).

#### 1.3 Styles (C:417-500)
**List and row:**
1. `.tlist` has `margin-top:6px`.
2. `.tp-row` is `display:grid; grid-template-columns:40px minmax(0,1fr); gap:0 34px; align-items:start; width:100%; padding:24px 0 30px`, with no border and no background, left-aligned and `cursor:pointer`.
3. At ≤600 the row gap becomes `0 16px` (C:631).
4. `.tname` is block, 25px, line-height 1.15, weight 700, navy, letter-spacing -0.015em. It is 20px at ≤600.
5. `.tmeta` is block, `margin-top:6px`, 15px, `#4a5663`.

**Circle (`.circ`):**
1. Base: `--s:1`, 40x40, `margin-top:-3px`, `border:3px solid navy`, round, white background, navy text, 15px, weight 700, tabular numbers, `transform:scale(var(--s))`.
2. Transition: `background-color .2s, color .2s, border-color .2s, transform .65s var(--spring)`.
3. Row hover: `--s:1.1`, background `--band #eaf1fb`, navy border and text.
4. Open: `--s:1`, navy background and border, white text, `box-shadow:inset 0 1px 0 rgba(255,255,255,.3), 0 4px 12px rgba(7,33,78,.25)`.
5. Open and hovered: `--s:.9`.
6. Keyboard focus: `.tp-row:focus-visible` has no outline. The circle gets `outline:3px solid var(--amber); outline-offset:3px`.

**Spring easings (C:253-254), copy verbatim:**
- `--spring: linear(0, 0.055, 0.195, 0.383, 0.588, 0.784, 0.953, 1.084, 1.172, 1.221, 1.234, 1.219, 1.185, 1.140, 1.092, 1.047, 1.008, 0.978, 0.958, 0.948, 0.945, 0.949, 0.958, 0.968, 0.979, 0.990, 0.999, 1.006, 1.010, 1.012, 1.013, 1.012, 1.010, 1.007, 1.005, 1.002, 1)`
- `--spring-soft: linear(0, 0.045, 0.153, 0.291, 0.437, 0.575, 0.697, 0.799, 0.880, 0.940, 0.983, 1.011, 1.028, 1.036, 1.038, 1.037, 1.032, 1.027, 1.021, 1.016, 1.011, 1.008, 1.004, 1.002, 1.001, 1.000, 0.999, 0.999, 0.999, 0.999, 1)`

**Circle animations:**
- `.circ.c-open` runs `circ-pop .6s ease-out`: scale `--s` at 0%, ×.84 at 24%, ×1.1 at 52%, ×.97 at 74%, back to `--s` at 100%.
- `.circ.c-close` runs `circ-close .45s ease-in-out`: `--s` at 0%, ×.95 at 35%, ×1.02 at 70%, `--s` at 100%.
(C:433-436)

**Line and chevron (`.tline`, C:440-452, C:461-462):**
1. Closed: `--rest:21px; position:absolute; left:19px; top:61px; width:2.5px; height:var(--rest); background:transparent; border-radius:2px; transition:height .65s var(--spring)`.
2. `::after` draws the chevron: `left:50%; bottom:1px; 8x8; margin-left:-5px; border-right:2px solid navy; border-bottom:2px solid navy; transform:rotate(45deg)`.
3. Hovering a closed topic (`.tp:not(.open):has(.tp-row:hover) .tline`) sets `--rest:27px`, so the chevron drops 6px with the spring.
4. The cue: `.tline.cue::after` runs `chevron-cue 1s ease-in-out 1.2s 2` (1.2s delay, 2 iterations). The keyframes are `0%,60%,100% {translateY(0) rotate(45deg)}` and `25% {translateY(4px) rotate(45deg)}`.
5. Open: `width:3px; left:18.5px; height:calc(100% - 91px); background:navy; transition:none`. The chevron is removed with `content:none`.
6. Opening runs `.tline.grow`, `tline-grow .55s ease-out`: 14px at 0%, `(100% - 91px)*1.07` at 50%, `*.99` at 75%, `100% - 91px` at 100%.
7. Closing runs `.tline.shrink`. Two rules have the same specificity. **The later rule at C:461 wins:** `tline-regrow .5s cubic-bezier(.3,1.3,.5,1)` from `height:0` to `var(--rest)`. The earlier `tline-shrink .6s ease-out` (48px → rest-5 → rest+3 → rest) at C:450/452 is dead code.

**Highlight wipe (C:454-457):**
1. `.hl::before` is a yellow block: `left/right:-.14em; top:.31em; bottom:.02em; background:#f9f871; transform:scaleX(0); transform-origin:0 50%; transition:transform .55s cubic-bezier(.4,0,.2,1)`. Closing therefore wipes back out to the left.
2. `.tp.open .hl::before` uses `transform:scaleX(1); transition:transform 1.25s var(--spring-soft) .08s`.

**Topic body:**
1. `.tbody` has `padding:0` (C:459).
2. `.band` has `margin:-6px 0 30px 20px; background:none; padding:16px 28px 30px 54px` (C:460).
3. At ≤600 the band has `margin-left:20px; padding:12px 8px 26px 36px` (C:641).

**Reduced motion (C:498-500):** `.circ`, `.tline`, `.tline::after`, `.hl::before`, `button.pm`, `button.pm i` and `.seg .lens` all get `animation:none!important; transition:none!important`. The JS also skips adding `c-open` and similar classes only when called with `quiet`. The CSS rule neutralises them anyway.

#### 1.4 Summary points inside a topic (I:169-201, C:463-497)
1. Markup: `div.band > ul.bullets > li.bpt`. Each `li` holds:
   - `button.pm[data-pt][aria-expanded=false][aria-label="Show <label>"]` containing `<i class="h"><i class="v">`
   - `<div><span class="txt">{text}</span> <button class="link see" data-pt data-label="<label>" aria-expanded=false>See <label></button><div class="examples" hidden>{cards}</div></div>`
2. The label is `examples` for trending topics and `note` for Ask matches.
3. Clicking either `+` or "See …" toggles `.examples`. The `+` gets `aria-expanded` and `aria-label` "Show/Hide <label>". The text button reads "See <label>" or "Hide <label>".
4. The `+` gets class `a-shrink` when opening and `a-expand` when closing, restarted with a reflow.

**Styles:**
1. `ul.bullets`: `list-style:none; display:flex; flex-direction:column; gap:16px`.
2. `.bpt`: grid `28px minmax(0,1fr)`, gap 14px.
3. `.txt`: 20px, line-height 1.5. 17px at ≤600.
4. `button.see`: 14px, weight 700, navy, nowrap, `margin-left:4px`, underlined with `text-underline-offset:3px`. Focus-visible: `outline:3px solid amber; offset 2px; radius 2px`.

**The `+` button (`button.pm`):**
1. Base: 28x28, no border, `radius:4px`, no background, `font-size:0`. Focus-visible: 3px amber outline, offset 2px.
2. The bars are `i` elements, absolutely centred, navy, `radius:2px`, `transition:background-color .15s`. Hover turns them `var(--accent)`, which is also navy, so nothing visible changes.
3. `.h` is 16×2.25 with `margin:-1.125px 0 0 -8px`.
4. `.v` is 2.25×16 with `margin:-8px 0 0 -1.125px` and `transition:transform .14s ease-out .1s, background-color .15s`.
5. While open, `.v` has `transform:scaleY(0)` with `transition:transform .14s ease-in`. The plus becomes a minus.
6. `.a-shrink` and `.a-expand` both run a 0.5s ease-out pop: `pm-pop` / `pm-pop-b` scale 1 → .74 at 24% → 1.08 at 52% → .97 at 72% → 1.
7. Their `.h` bar runs `pm-bar` / `pm-bar-b`: scaleX 1 at 0-40% → 1.12 at 58% → .97 at 78% → 1. Each animation has two names so it restarts in either direction.

**Examples container:**
1. `.examples` has `margin-top:4px; padding:0`.
2. Child `.item` has `border-top:1px solid #edf0f5; padding:16px 0`. The first item has no border and `padding-top:10px`.
3. Inside examples, the note text steps down: kindl 12.5px, title 18px, by-line 15px, detail 16.5px, source and why 14.5px (C:475-479).
4. At ≤600: title 16px, detail 15px, by-line 14px, source 13.5px (C:637-640).

#### 1.5 Note card (`PI.insightCard(i, opts)`, J:126-162, styles C:381-413)
Used on meeting sections, in topic examples, in Ask match notes and in the peers card.

**Top to bottom:**
1. `.kindl`: only for kinds `problem`, `solution` and `win`, and only when `opts.kind !== false`. Text is "Issue", "Solution" or "Win". Block, 14px, weight 700, letter-spacing .06em, uppercase. Colours are `--issue #a82b50`, `--solution #937000` and `--win #136c50` (C:385-391).
2. `.title`: 21px, weight 700, navy, `margin-top:2px`. 18px at ≤600.
3. `.by`: shown unless `opts.company === false`. It is a flex-wrap line at 17px in `#4a5663`. Parts, in order:
   - the company as `a.co[href="/partner-intel/#/company/<id>"]`, or a `span.co` when the company has no id (17px, weight 400, navy)
   - the industry, unless it is "Unknown"
   - the member label, only when the company has an id
   - `span.pill.medium` "Check company" when `i.checkCompany`, with the title tooltip "Which company said this is uncertain. Staff can settle it on the control panel, under Statements to check." (colour `#8a5200`, weight 600)
   - "Resolved" when `status === "resolved"`
   - Each part except the last gets an `::after` "·" with `margin:0 8px` in muted `#7c8794` (C:398).
4. `.detail`: 19px, max-width 900px, `margin-top:8px`, line-height 1.55. 16px at ≤600.
5. `.why`: "**Addresses:** {solves}" at 16px, shown when present.
6. `details.src`: `margin-top:10px`, 16px. Its `<summary>` reads "Source" (weight 700, navy, pointer; hover navy). Inside, `.srcm` is a flex-wrap row with `gap:4px 16px; margin-top:8px`, `#4a5663`, holding:
   - the date
   - `span.pill.est` "estimated date" when estimated (italic, `#8a5200`; it also gets the generic `* + .pill::before` middot with `margin:0 8px 0 4px`, C:112)
   - the event type
   - the speaker
   - `span.files` with comma-separated file links (`target=_blank rel=noopener`), max-width 340px, ellipsis, title tooltip listing all file names

   After `.srcm` comes a `<blockquote>“{quote}”</blockquote>` with `margin:8px 0 0; padding:2px 0 2px 14px; border-left:2px solid #c9cdd8; color:#4a5663; 13px` (C:134).
7. `.acts` (`margin-top:8px`) holds `opts.action`, which is the Find solution button.

**Card spacing:**
- `.item`: `border-top:1px solid #dce3ef; padding:20px 0`. The first item has no border and `padding-top:6px`.

**Find solution** (`findButton`, I:804-812, C:410-413):
1. Markup: `<button class="find" data-find="<question>" data-co="<companyId>" data-co-name="<name>">Find solution<svg class="go">`.
2. Style: no border, no background, navy, 16px, weight 700, `inline-flex; gap:6px`. The SVG is 14×14 with `transition:transform .2s`. Hover moves it `translateX(3px)`.
3. The question is `"Who can help with this: " + title + (detail ? ". " + detail : "")`, truncated to 597 characters plus "..." when it exceeds 600.
4. Click (I:1089-1094) sets `PI.askPrefill = {question, mode:"match", exclude: companyId, name}` and sets the hash to `#/ask`.

---

### 2. Home (`#/home`, also the fallback) (I:326-341)

**Fetch:** `GET home?days=<state.days>`. The default is 90. The server clamps the value to 1 to 365 and treats a falsy value as 90 (S:3982).

**Response fields the UI uses:** `trending[]`, each with `topic`, `label`, `companyCount`, `meetingCount`, `summary` (`{bullets:[{text, examples:[note]}]}` or null) and `examples` (up to 3 notes, present when summary is null) (S:1163-1168). The response also carries `days, since, generatedAt, dashboard, uncategorized, counts`, which the UI does not use.

**Server ranking** (S:1063-1083):
1. Only issue kinds count. Topic "other" is excluded.
2. Sort order: `companyCount` descending, then `meetingCount` descending, then `highUrgency` (meetings with a high-urgency row) descending, then `label` ascending.
3. The server returns at most 15 topics (S:1158).

**Layout:**
1. Loading card "Loading…".
2. `<h1>Trending topics</h1>`.
3. `<div style="margin-top:28px">` holding the time window `#win` with buttons `[30,"30 days"]`, `[60,"60 days"]`, `[90,"90 days"]` (I:335).
4. `<div id="trend" class="fades">` holding the topic list, with `hl="h2"`.
5. On error, `#view` shows `emptyState`.

**Topic list (`renderTrending`, I:256-271):**
1. Empty list: `<div class="card"><div class="empty">No topics in this selection.</div></div>`.
2. Otherwise: `<div class="card" style="padding-top:10px"><div class="tlist" data-list></div><div data-more></div></div>`.
3. `PAGE = 5`. The list shows 5 topics first.
4. "Show more" control: `<div class="tmore"><button class="more" data-moretopics>Show N more topic(s)</button></div>`, where N is `min(5, remaining)`. The label uses `plural(left,"more topic","more topics")`, so it reads "Show 1 more topic" or "Show 5 more topics". `.tmore` has `border-top:1px solid #9db3da; padding-top:22px` (C:501).
5. Each click appends the next 5 into the same `.tlist`, so the one-open rule spans all pages. The new items appear with no animation and no stagger.
6. All topics start closed. Number 1 gets the chevron cue.
7. Meta line (I:209-212): `"{N company|companies} across {M meeting|meetings}."`. When `companyCount` is 0 it reads only `"{M meeting(s)}."`.

**Topic body:**
- With a summary: `bulletsHtml` renders the points. Each example card uses `PI.insightCard(i)` with default options, so the kind label and company show.
- Without a summary: `<div class="band"><div class="pending"><span class="spinner"></span>Writing the summary…</div></div>`. `.pending` is 15px and muted, with `margin-top:12px` (C:205, C:480).

**Deferred summaries (I:226-254):**
1. For topics in the newly shown chunk with no summary, the page waits `SUMMARY_DELAY_MS = 700`.
2. If `seq` has not changed, it sends `POST summarize` with `{days: state.days, source: [], status: [], topics: [ids]}`.
3. The response is `{summaries: {topicId: {bullets}}, unavailable?}` (S:1271-1330, at most 8 topics per call).
4. Each matching `[data-body]` gets `bulletsHtml(summary)`.
5. When a topic gets no summary, the body gets `fallbackHtml`: a band with `<p class="small muted" style="margin:0">{r.unavailable || "No summary could be written for this topic."}</p>` and, if the topic has examples, `<details class="src"><summary>Examples</summary>{cards}</details>`.
6. On a network error the note reads `"The summary could not be written: " + err.message`.
7. Bodies swap with no animation. If the topic is open, the line height simply follows the content.

**Time window (`.seg.glass`, I:273-324, C:350-369):**
1. Markup: `<div class="seg glass" id role="group" aria-label="Time window"><span class="lens" aria-hidden="true"></span><button data-d="90" class="on" aria-pressed="true">90 days</button>…`.
2. Track: `position:relative; display:inline-flex; gap:2px; padding:4px; border-radius:999px; background:rgba(7,33,78,.07); backdrop-filter:blur(24px) saturate(180%)` (with `-webkit-` prefix); `border:1px solid rgba(7,33,78,.12); box-shadow:inset 0 1px 2px rgba(7,33,78,.06), 0 1px 0 rgba(255,255,255,.8)`.
3. Buttons: `position:relative; z-index:3; height:38px; padding:0 22px; border:0; border-radius:999px; background:transparent; color:navy; 15px; weight 600; transition:color .3s`.
   - The chosen button is weight 700 and its text stays navy (no fill).
   - Hover has a transparent background.
   - Focus-visible: `outline:3px solid #fbae40; outline-offset:2px`.
4. Lens: `position:absolute; z-index:2; top:4px; left:4px` (JS then sets left and width); `height:38px; border-radius:999px; pointer-events:none; background:rgba(255,255,255,.4); backdrop-filter:saturate(170%) brightness(1.06); border:1px solid rgba(255,255,255,.85)`.
   - Shadow: `inset 0 1px 1px #fff, inset 0 -1px 1px rgba(7,33,78,.12), inset 1px 0 1px rgba(255,255,255,.6), inset -1px 0 1px rgba(255,255,255,.6)`.
   - Transition: `left .6s cubic-bezier(.22,1,.36,1), width .6s cubic-bezier(.22,1,.36,1), transform .45s cubic-bezier(.22,1,.36,1)`.
   - `.lens.moving` sets `transform:scaleX(1.18) scaleY(.88)`.
5. In Chromium only (`navigator.userAgentData` exists, which adds `html.lg-refract`, J:35), the lens backdrop-filter becomes `url(#pi-lens-glass) saturate(170%) brightness(1.06)`.
   - `PI.glassFilter` (J:38-66) builds the SVG filter in a hidden `<svg id="pi-glass-defs">`: `feTurbulence fractalNoise` → `feDisplacementMap` (R/G channels) masked to the rim by a blurred inner flood.
   - Lens parameters: `{freq:"0.04 0.09", octaves:1, seed:4, scale:12, rim:12, rimY:8, soft:5}`.
6. `placeLens(seg, instant)` sets the lens left and width to the `.on` button's `offsetLeft` and `offsetWidth`. On first render it places the lens instantly with the transition disabled.
7. Clicking a different window (`pickWindow` and `wireWindow`):
   - A click on the current button does nothing.
   - The click increments `seq`, starts the fetch, moves `.on` and `aria-pressed`, animates the lens, and adds `.moving` for 220ms.
   - It adds `.fading` to the dependent nodes (`#trend` on Home).
   - It waits for both the data and a 160ms timer (0 under reduced motion), then redraws and removes `.fading`.
   - The page does not scroll.
   - On error, the first node gets `emptyState(err)`.
8. Fade (C:555-557): `.fades { transition:opacity .18s ease }` and `.fades.fading { opacity:0; transition-duration:.14s }`. Reduced motion sets `transition:none`.
9. Clicking a window updates `state.days` before the fetch.

---

### 3. Programs list (`#/programs`) (I:343-363)

**Fetch:** `GET programs`, which returns `{programs:[{name, notes, meetings, companies, last, first, internal}], needsUpdate}`.
- Server order (S:1679-1696): `last` descending, then `name` ascending. Programs with no dated notes (`last === ""`) sort last.
- `internal` is true when every note in the program is internal.

**Layout:**
1. Loading card.
2. If `needsUpdate`, a banner: "Meetings are grouped approximately until the one-time update is applied. Open the [control panel](/partner-intel/control-panel/) and use the button at the top. It takes about a minute and uses no Claude." (I:346-348).
3. `<h1>Programs</h1>`.
4. `.pgrid`: `display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin-top:32px` (C:504). One column at ≤860px (C:610).
5. **The page has no empty state.** Zero programs render an empty grid.

**Program card (`a.pcard[href="#/program/<encodeURIComponent(name)>"]`):**
1. `.pn` is the name: 24px, line-height 1.2, weight 700, navy, letter-spacing -0.01em.
2. `.pint` reads "Conexus internal" when `internal`: `margin-top:6px`, 13px, weight 700, navy.
3. `.pl` reads `"Latest notes " + fmtDate(last)` or `"No dated notes yet"`: `margin-top:auto; padding-top:22px`, 15px, colour `#16202b`.
4. `.go-arrow` is an SVG (I:51) at 22×22, navy, positioned `right:26px; bottom:24px`.
5. Card style: `position:relative; display:flex; flex-direction:column; min-height:132px; padding:26px 28px 24px; border:0; border-radius:24px; background:#fff; transition:box-shadow .2s` (C:505-512).
6. Hover: `box-shadow:inset 0 0 0 2px navy`, and the arrow moves `translateX(5px)` with `transition:transform .25s cubic-bezier(.3,1.6,.5,1)` (C:507, C:511, C:513).
7. The whole card is a link, so it is keyboard-focusable. It has no custom focus style.

---

### 4. A program (`#/program/<name>`) (I:365-410)

**Fetch:** `GET program?name=<enc>&days=<state.programDays>`. The default is 0 (all time). The server allows 0 to 365, and 0 means no window (S:4035-4049).

**Response fields used:**
- `program{name, first, last, internal}`
- `trending[]`, the same shape as Home, at most 15
- `meetings[]`, each `{id, label, kind, date, estimated, companies[], companyCount, topics[], files[], fileCount}`
- `needsUpdate`

**Important:** the server builds `meetings` with no day filter (S:4044-4045). Only `trending` responds to the window. The page still fades and redraws the meetings block on a window change. The server caps meetings at 300 and sorts them by `date` descending, then `label` ascending (S:1698-1721). Each meeting's `topics` holds its top 3 topic labels by row count. `companies` is sorted alphabetically and capped at 8. `files` is capped at 5.

**Layout, top to bottom:**
1. Update banner, if needed.
2. `backLink("#/programs","All programs")`.
3. `<h1>{program.name}</h1>`.
4. `<p class="lede" id="plede">` reading either `"Notes from {fmtDate(first)} to {fmtDate(last)}."` or `"No dated notes yet."`, plus `" Conexus internal."` when internal.
5. `<div style="margin-top:28px">` holding window `#pwin`: `[90,"Last 90 days"]`, `[365,"Last year"]`, `[0,"All time"]`.
6. `<h2 class="subh">Trending topics</h2>` then `#trend.fades`. This is the same component as Home with `hl="h3"`. The summarize scope is `{days: state.programDays, source:[name]}`.
7. `<h2 class="subh">Recent data</h2>` then `#precent.fades`, which contains `<div class="card" style="padding:8px 36px"><div id="meetings"></div></div><div id="moreM"></div>`.

**Window change:** the page fades `#trend` and `#precent` together and redraws the lede, the trending list and the meetings list.

**Meetings list:**
1. The list shows 12 rows first. Each "Show more" click appends 12 more. Rows appear with no animation.
2. The button is `<p style="margin:22px 0 0"><button class="more" id="moreMeet">Show more</button></p>`. The label carries no count. The button disappears when all rows show.
3. Empty: `<div class="empty">No data in this program yet.</div>` inside the card.

**Meeting row (`meetingRow`, I:366-373):**
1. Link: `a.mrow[href="#/meeting/<enc program>/<enc id>"]`.
2. Date block `.md`: the code formats the date, removes the first comma and splits on spaces. For example "Mar 5, 2026" gives `<b>Mar 5</b><span>2026</span>`. A missing date gives `<b>No date</b><span></span>`.
3. Text block:
   - `.mt` is the label.
   - `.mk` is the kind label: "Cohort", "Company" or "Meeting" (fallback "Meeting"), plus `" · estimated date"` when estimated.
   - `.mtop` reads `"Topics: a, b, c"` when topics exist.
4. Then `.go-arrow`.

**Meeting row styles (C:514-523):**
1. `.mrow`: `display:grid; grid-template-columns:96px minmax(0,1fr) 30px; gap:24px; align-items:start; padding:24px 0; border-top:1px solid #dce3ef`. The first row has no border. Text colour `#16202b`.
2. `.md b`: block, 24px, line-height 1.1, weight 700, navy.
3. `.md span`: block, `margin-top:2px`, 14px, `#4a5663`.
4. `.mt`: block, 20px, line-height 1.3, weight 700, navy.
5. `.mk`: block, `margin-top:4px`, 13px, weight 700, navy.
6. `.mtop`: block, `margin-top:8px`, 15px.
7. `.go-arrow`: `margin-top:4px`.
8. Hover: no underline, and the arrow moves `translateX(5px)`.
9. At ≤600: grid `64px minmax(0,1fr)`, gap 14px, arrow hidden (C:643-644).

---

### 5. A meeting (`#/meeting/<program>/<id>`) (I:412-444)

**Fetch:** `GET meeting?program=<enc>&id=<enc>`, which returns `{program, meeting, issues[], solutions[], wins[], other[]}`.
- `meeting` has the same shape as a program's meeting row.
- Each list holds note objects shaped by `shapeInsight` (S:918-928): `id, kind, title, detail, quote, topic, topicLabel, status, solves, date, estimated, eventType, speaker, sources[{name,url}], checkCompany, company{id,name,industry,status}`.
- Within each section the server sorts notes by urgency (high, medium, low, none), then `id` (S:4056).
- A meeting not found returns 404 "Meeting not found.".

**Layout:**
1. `backLink("#/program/<enc name>", name)`. The link text is the program name.
2. `<h1>{m.label}</h1>`.
3. `<p class="lede">`: `"{fmtDate(date)}{ (estimated date)}. {Kind}{ with N company|companies}."`. Example: "Mar 5, 2026 (estimated date). Cohort with 5 companies." The code does not suppress odd combinations such as "Company with 1 company."
4. `<p class="secsub" style="margin-top:10px;max-width:860px">`:
   - If `companyCount` is non-zero: the company names joined with ", " (trailing dots stripped), then `", and K more"` when `companyCount > companies.length`, then `". "`.
   - Then `"From " + fileLinks(files)` and `" and N other file|other files"` when `fileCount > files.length`, then `"."`.
   - The file links are underlined, open in a new tab and use `rel=noopener`.
5. Sections in this order, each omitted when empty:
   - "Issues" (`h2.k-issue`, `#a82b50`), button noun "issues"
   - "Solutions" (`h2.k-solution`, `#937000`), noun "solutions"
   - "Wins" (`h2.k-win`, `#136c50`), noun "wins"
   - "Other" (navy, no tone), noun "other notes"

**Each section:**
1. Markup: `<section class="card"><h2>{title}</h2><div>{first 3 cards}<div hidden data-rest>{rest}</div></div><p style="margin:6px 0 0"><button class="more" data-show-rest>Show all {noun}</button></p></section>`. `SECTION_SHOWN = 3`.
2. Cards use `insightCard(i, {kind:false, action: Find solution for kinds problem and ask})`.
3. Clicking "Show all …" un-hides `[data-rest]` and removes the button's `<p>` (I:438-444). Nothing animates and there is no "show fewer".
4. If every list is empty, the page shows only the header block, with no empty message.

---

### 6. Companies list (`#/companies`) (I:718-773)

**Immediate render (no loading card):**
1. `<h1>Companies</h1>`.
2. Filter card: `<div class="card" style="margin-top:32px;padding:24px 28px"><div class="fields">` with four cells:
   - **Search:** `label.field[for=cq]` "Search" and `<input id="cq" placeholder="Company name">`.
   - **Industry:** label "Industry" and `<select id="ci">` holding only "All" (value "") until the first response.
   - **Member status:** label "Member status" and `<select id="cs">` with options "All" (value ""), "Council Member" (value `Active`) and "Not Council" (value `Inactive|Non-member|Unknown`; the server splits on `|`, S:989).
   - **Checkbox:** `<div style="align-self:end;height:46px;display:flex;align-items:center"><label class="chk"><input type="checkbox" id="cw" checked> Only companies with notes</label></div>`. It is checked by default.
3. Results card: `<div class="card" id="clist" style="padding:12px 28px 20px">`. It stays empty, with no spinner, until the first response.

**State:** filter values are **not** kept between visits. Each visit rebuilds them with the defaults. `companySort` **is** kept until reload (I:719-722).

**Fetch:**
1. URL: `GET companies?q=<enc value>[&industry=<enc>][&status=<enc>][&withInsights=1]&sort=<key>&dir=<asc|desc>`.
2. Triggers:
   - Text input: `input` event debounced by 250ms with `clearTimeout`/`setTimeout` (I:770).
   - `ci`, `cs` and `cw`: `change` event fires immediately (I:771).
   - Sort clicks fire immediately.
3. A `loads` counter keeps only the newest response (I:734-743).
4. While a request is pending, the old table stays on screen with no loading indicator.
5. Any error replaces the whole `#view` with `emptyState`.

**Response:** `{total, items[{id,name,industry,status,insights,problems,solutions,wins,last}], industries[]}`.
- The server caps `items` at 500 (S:4078-4081). The page has no pagination and does not display `total`.
- `industries` covers every industry on the roster, sorted, including "Unknown". The page fills the Industry dropdown once, only while it still has a single option (I:744-746).

**Server filtering (S:1843-1870):**
1. `q` matches the company name only, as a substring after normalising both sides with `nameKey`: NFKD, diacritics removed, lowercase, `&` → " and ", non-alphanumeric runs → a space, trimmed (S:479-482).
2. `industry` matches case-insensitively.
3. `status` must exactly equal one of the listed statuses.
4. `withInsights=1` drops companies with 0 non-internal notes.

**Table (`table.tbl`):**

| # | Column | Sort key | Cell |
|---|---|---|---|
| 1 | Company | `name` | `td.cn`: name, weight 700, navy |
| 2 | Industry | `industry` | industry |
| 3 | Status | `status` | `memberLabel(status)` |
| 4 | Notes | `insights` | `td.num`: `insights \|\| 0`, tabular numbers, left-aligned |
| 5 | Last mentioned | `last` | `fmtDate(last)` or blank |

**Sorting (I:747-766, S:1871-1882):**
1. Every column sorts.
2. Each `<th>` has `aria-sort` set to "ascending", "descending" or "none".
3. Each `<th>` contains a `<button class="sorter[ on]" data-sort="<key>">{heading}<span class="arrow" aria-hidden="true">▲ / ▼ / empty</span></button>`. The active column shows `&#9650;` for ascending or `&#9660;` for descending.
4. Clicking the active column reverses the direction.
5. Clicking a new column starts ascending for `name`, `industry` and `status`, and descending for `insights` and `last`.
6. The default sort is name ascending.
7. Sorting happens on the server, before the 500 cap. Tie-breaker: name ascending, `localeCompare` with sensitivity "base".
8. Status sorts by rank: Active 0, Inactive 1, Non-member 2, anything else (including Unknown) 9. Every non-Active row still displays "Not Council".
9. For `last`, companies never mentioned always go to the end in either direction.
10. **The table has no animation of any kind: no FLIP, no row enter or leave, no stagger.** Each response replaces `#clist.innerHTML`.

**Table styles:**
1. `th`: left-aligned, uppercase, `#4a5663`, `padding:14px 10px 12px; border-bottom:1.5px solid #9db3da; font-size:13.5px; font-weight:700; letter-spacing:.06em` (C:149-150, C:526).
2. Sorter button: no background, border or padding; `font:inherit; color:inherit; cursor:pointer; white-space:nowrap`. Hover and active turn the text navy (C:105-106).
3. `.arrow`: `display:inline-block; width:1.1em; font-size:10px; margin-left:3px`. It reserves its width even when empty (C:107).
4. `td`: `padding:15px 10px; border-bottom:1px solid #e6ebf3; font-size:16.5px; vertical-align:top`. The last row has no bottom border (C:151, C:527-528).

**Row interaction:**
1. Rows are `tr.click[data-id]` with `cursor:pointer`. Hover sets every cell's background to `--band #eaf1fb`. Cells have no transition (C:152, C:529).
2. Clicking a row sets `location.hash = "#/company/<enc id>"` (I:756-758).
3. **Rows are not keyboard-reachable.** They have no link, no tabindex and no key handler. The sort buttons are keyboard-reachable.

**Empty:** `<div class="empty">No companies match.</div>`.

**≤760px:** the table becomes `display:block; overflow-x:auto` (C:244).

---

### 7. Ask (`#/ask`) (I:446-716, renderers in A, styles C:599-607, C:702-893)

#### 7.1 Structure (I:462-474)
```
div.asx#asx
  aside.asx-rail[aria-label="Past questions"]
    div.rl-head: History toggle (pressed) + New
    div.rl-list#asxRail
    p.rl-note#asxNote
  div.asx-main
    h1.asx-h1 "Search Conexus Notes"
    form.asx-pill#asxForm
      span#asxSrc (program select + chevron)
      label.sr-only "Search Conexus notes"
      textarea#asxQ[rows=1][maxlength=1500][placeholder=ASK_START]
      button.asx-go[type=submit][aria-label=Search] (arrow icon)
    div.asx-tools
      span.asx-lb: History toggle + New
      span#asxBack
    div.asx-out#asxOut
    div.asx-recent#asxRecent
```

**Visual order:** CSS `order` overrides DOM order (C:807): tools 0, h1 1, pill 2, out 4, recent 5.

**Before the first question:**
1. `.asx`: `display:flex; gap:0 36px; align-items:flex-start` (C:803).
2. `.asx-main`: `flex:1 1 auto; max-width:1020px; margin:0 auto; flex-direction:column` (C:804).
3. h1: centred, `margin:110px 0 34px`. At ≤600 the margin is `40px 0 22px` (C:845, C:884).
4. Placeholder (`ASK_START`, I:454): "Search the notes, ask a question, or describe what a partner needs".
5. History opens closed on every visit (I:461).
6. If `PI.askPrefill` is not set, the textarea gets focus (I:668).

**Pill (C:847-858):**
1. `.asx-pill`: `display:flex; align-items:center; gap:6px; min-height:72px; padding:0 10px 0 12px; background:#fff; border:1px solid #e1e2e9; border-radius:999px; box-shadow:0 10px 30px rgba(7,33,78,.1)`.
2. Program select (I:514-519, C:849-852):
   - Options: "All programs" (value "") followed by each `/facets` source value.
   - Style: `appearance:none; padding:0 42px 0 16px; max-width:240px; height:50px; border:0; border-radius:999px; background:#f3f5f9; color:navy; font-size:16px`.
   - A chevron SVG, 14px and navy, sits absolutely at `right:16px` with `pointer-events:none`.
   - A change sets `chosen`, which persists until reload.
   - Fetch: `GET facets` → `{sources:[{value,count}]}`, sorted alphabetically (S:4073-4076). The page caches it in `state.sourceList`. It draws the select immediately and redraws it once the list arrives.
3. Textarea: 19px, line-height 1.55, height 30px, no border, transparent. Autosize sets height to `min(scrollHeight,160)px` on input (I:477).
4. Go button: 56×56 round, navy, white arrow. Hover is also navy, so it does not change visibly.

**Pill at ≤600 (C:885-889):**
1. The pill wraps: `min-height:60px; radius:28px; padding:8px`.
2. The select moves to row 2 at full width (`order:3; flex:1 1 100%`), with `height:40px; font-size:14px`.
3. The textarea is `flex:1 1 0; min-height:52px; 16px`.
4. The go button is 44×44.

**Tools row (C:859, C:863, C:843):**
1. `.asx-tools`: `display:flex; align-items:center; gap:14px; margin:0 0 10px; min-height:36px`.
2. `.ax-tg` "History" and `.ax-new` "New" in the Ask page: `height:42px; padding:0 18px; font-size:15px; border:1px solid #e1e2e9; border-radius:999px; background:#fff; color:navy; inline-flex; gap:7px` (C:702-703).
   - Pressed History: `background:#eef2fa; border-color:#c9d6ee; color:navy` (C:704).
   - Icons: History uses a 15px rail icon; New uses a 14px plus (A:24-35).
3. `.asx-lb` is hidden while the rail is open (C:843).

**Recent chips (I:528-533, C:869-872):**
1. They show only when no conversation is open and history is non-empty.
2. Markup: `<div class="rl-group">Recent</div><div class="fus">` holding up to 6 `button.fu[data-conv]` with conversation titles.
3. The block is centred with `margin-top:44px`, chips at 15px.
4. Clicking a chip opens that conversation.

#### 7.2 Asking (I:552-589)
1. **Submit triggers:** the form submit, or Enter without Shift and not during IME composition (I:621-622). Shift+Enter inserts a newline.
2. A trimmed question shorter than 3 characters only refocuses the textarea.
3. When no conversation is open (or `fresh`), the code creates a temporary one: `{id:"new-N", temp:true}` (A:235).
4. The code pushes a pending item, clears the textarea, redraws, clears Recent, and smooth-scrolls the last turn to `scrollY + top - 96` (`behavior:"auto"` under reduced motion; I:510-513).
5. **Request:** `POST assistant` with `{question, mode: "match"|"answer", sources: chosen ? [chosen] : [], exclude, fresh, conversationId}`.
   - The first question of a temporary conversation sends `conversationId:""`.
   - Follow-ups asked before the first answer arrives wait for it (A:217-230).
6. **Response:** `{conversation:{id,title,createdAt,updatedAt,turns,companyId}, turn}`.
7. On success, the settle animation plays. Then the turn joins its conversation, the history list updates (`AU.remember`), the page redraws, and it scrolls to the new turn when that conversation is on screen.
8. On error, the code adds an error turn and, if the box is empty, puts the question back in it.
9. Several questions can run at once. Pending items show in the order asked.
10. **Server validation:** a question shorter than 3 characters returns "Type a question first."; longer than 1,500 returns "Keep the question under 1,500 characters."; with no Claude key it returns 409 "Claude is not set up for this tool yet. Ask an admin to add the key." (S:4111-4116, S:3182).

#### 7.3 Chat mode (`.has-out`) and the pill FLIP (I:490-508, C:808-836)
**Entering chat:** `toChat(true)` runs when any turn or pending turn exists.

**Chat styles:**
1. h1 hidden.
2. `.asx-out` gets `order:1; flex:1 0 auto; margin-top:0; padding:0`.
3. `.asx-main` becomes a white panel: `border-radius:24px; padding:24px 36px 0`. At ≤600: `padding:16px 16px 0; radius:22px`.
4. `.asx` gets `align-items:stretch`.
5. `fitChat()` sets the main panel's `min-height` so it reaches the window bottom. It divides by the measured zoom factor and runs on resize.
6. The pill becomes `position:sticky; bottom:14px; z-index:5; margin:22px 0 14px; background:#f3f5f9; border-color:#e1e6ef; box-shadow:0 0 0 14px #fff, 0 -16px 22px -10px rgba(7,33,78,.10)`. The select inside turns white.
   - At ≤600: `bottom:10px; margin:18px 0 10px; box-shadow:0 0 0 10px #fff, 0 -14px 20px -10px rgba(7,33,78,.12)`.
7. The placeholder becomes "Ask a follow-up".

**Pill FLIP (the only FLIP in my scope):**
1. The code measures the form before and after the class change.
2. It applies `transform:translateY(dy/zoom)` with `transition:none`, then forces a reflow.
3. It sets `transition:transform .7s cubic-bezier(.22,.8,.24,1)` and clears the transform.
4. It clears the transition after 750ms.
5. Under reduced motion it skips all of this.

**History toggle fades (C:821-826):**
- `.asx.rail .asx-rail`, `.asx.rail.has-out .asx-main` and `.asx.has-out:not(.rail) .asx-main` run `asx-fade-a` or `asx-fade-b` (opacity 0 → 1) over `.25s ease`.
- Reduced motion turns the animation off.

**Turns:**
1. `.turn`: `flex column; gap:14px; margin:0 0 26px`. Inside `.asx-out` the margin-bottom is 40px, and the last turn in chat mode has 0.
2. `.qb` is the question bubble:
   - Base (C:709-710): `align-self:flex-end; max-width:min(520px,85%); border-radius:18px 18px 4px 18px; padding:12px 18px; color:navy; white-space:pre-wrap; overflow-wrap:anywhere`.
   - In `.asx-out` (C:835): 18px, white background, `border:1px solid #e1e2e9`.

#### 7.4 History rail (I:523-527, I:609-619, A:174-193, C:839-882)
1. The rail is hidden until `.rail`.
2. Open: `display:flex; flex-direction:column; width:300px; min-height:calc(125vh - 160px); max-height:calc(125vh - 120px); overflow-y:auto; position:sticky; top:16px; background:#eef0f3; border:1px solid #dcdfe4; border-radius:16px; padding:16px 12px`. The `125vh` values compensate for the .8 zoom.
3. `.rl-head`: `flex; gap:8px; margin:0 0 14px`.
4. At ≥1101px in chat mode, the rail and the chat panel join with no gap:
   - The main panel gets `border:1px solid #dcdfe4; border-left:0; border-radius:0 24px 24px 0; max-width:none`.
   - The rail gets `border-radius:24px 0 0 24px`.
5. At ≤1100px the rail becomes a fixed overlay: `left:0; top:0; bottom:0; z-index:950; width:min(360px,88vw); border-radius:0; box-shadow:0 0 40px rgba(7,33,78,.2); padding:20px`. The overlay has no backdrop and does not close on an outside click. Only the History toggle closes it.
6. **Contents:**
   - Loading: `<p class="rl-note"><span class="spinner"></span>Loading…</p>`.
   - Empty: "Your questions will be listed here."
   - Otherwise, groups "Today", "This week" and "Earlier". "Today" means the same date string. "This week" means within 7 days.
   - Group heading `.rl-group`: 11.5px, uppercase, letter-spacing .06em, `#4a5663`, `padding:14px 10px 6px`. The first group has `padding-top:2px`.
   - Each row is `.rl-row` (flex, radius 10px; hover background `rgba(255,255,255,.7)`) holding:
     - `button.rl-item[data-conv]` with the title: 15px on the Ask page, `padding:9px 10px`, radius 10px. The active conversation has a white background and navy text.
     - `button.rl-del[data-del][aria-label="Delete this conversation"]` with a bin icon: 32×32, muted, `opacity:0`. It becomes visible on row hover or focus.
   - Note line `.rl-note`: "Only you see these." plus " A copy is kept in Box." when `boxFolder` is true. 13px on the Ask page, `margin:auto 0 0`.
7. **Fetches:**
   - `GET assistant/history` → `{conversations:[summary], boxFolder}` on page load and when the rail first opens.
   - `GET assistant/conversation?id=` → `{conversation}` to open one. Opening resets state and scrolls to `(0,0)`.
   - `POST assistant/delete {id}` after `window.confirm("Delete this conversation from your history?")`. Errors show in `window.alert(err.message)`.
8. **New** (`data-new`) clears the conversation, scrolls to the top and focuses the box (I:600-608).

#### 7.5 Written answer (`AU.answerHtml`, A:131-152)
1. `.ans` holds the model's markdown, made safe (A:47-82): the code escapes everything first, then re-enables `#` headings as `h4`, `-`/`*`/`•` bullet lists, `1.`/`1)` numbered lists (with `start`), `**bold**`, `*italic*`, inline code, and `[n]` citation chips.
   - `.ans` in `.asx-out` is 18px, line-height 1.6.
   - `p`: `margin:0 0 10px`. Lists: `padding-left:22px`. `li`: `margin:0 0 7px`.
   - `h4`: `16px 0 6px` margins, 15px, navy. `strong` is navy.
2. A memory line appears when the answer came from a saved answer, as `p.memo` (15px in `.asx-out`):
   - `"A saved answer from {date}, updated with N new note(s)."`
   - or `"A saved answer from {date}. No notes have been added since."`
3. A sources disclosure follows.
4. **On the last turn only**, a `.fus` chip row:
   - each follow-up as `.fu[data-q]`
   - "Answer fresh" (`data-fresh`) when the answer came from memory
   - "Find partners who can help" plus an arrow (`.fu.go[data-match]`) when `turn.offerMatch`
5. `.fu` chip: `min-height:34px; padding:6px 14px; border:1px solid #e1e2e9; border-radius:999px; background:#fff; color:navy; inline-flex; gap:6px`. 15px in `.asx-out`. Hover sets a navy border.
6. Chip actions (I:637-639):
   - `data-q` asks in answer mode.
   - `data-fresh` asks fresh, which starts a new conversation.
   - `data-match` asks in match mode.

**Citation chips (A:39-43, C:729-731):**
1. Markup: `button.cite[data-ref][data-turn][aria-label="Source N"]`.
2. Style: inline-block, superscript, `padding:2px 5px; radius:6px; background:#eef2fa; color:navy; font-size:10.5px; line-height:1`.
3. `.on`: navy background, white text.
4. Clicking a chip (A:196-209) lights it, opens the `.srcs` details and the matching `.srow`, flashes that row with `ax-flash 1.4s ease` (`0%,40% background:#eef2fa → 100% transparent`; C:747-748), and calls `scrollIntoView({block:"nearest",behavior:"smooth"})`.

**Sources disclosure (A:103-113, C:732-746, C:865-867):**
1. `details.srcs`: `border-top:1px solid #edf0f5; padding-top:10px`, 15.5px in `.asx-out`.
2. Its summary shows a down-chevron SVG (12px) and `"N source(s)"`, weight 600, navy. The chevron is `rotate(-90deg)` when closed with `transition:transform .2s`.
3. Each `details.srow` summary is `flex; gap:10px; align-items:baseline; padding:4px 6px; radius:8px`, with hover background `#f3f5f9`. It holds:
   - `.sref` with the number (navy, min-width 18px)
   - `.sk` with the kind label (min-width 74px, coloured like `.kindl`)
   - `.stitle` (navy, flexes)
   - `.sby`: `"Company{ (company uncertain)}{ · Mar 5, 2026{ (estimated)}}"` in `#4a5663`, nowrap
4. The row body `.sbody` (`padding:2px 6px 8px 32px`, 15.5px) holds the detail and a `.sfoot`: `"Open {company}"` link · file links.
5. At ≤700 the summary wraps (C:790-793).

#### 7.6 Partner-search turn (`matchesHtml`, I:681-716)
Used when `turn.kind === "matches"`, which comes from match mode.

**Order on screen:**
1. If `ranking === "keyword"`, a `.banner`: "Ranked by keyword match only. Claude is not set up for this tool yet, so the order and wording are not reviewed."
2. `p.answer` with the summary: 22px, line-height 1.35, weight 700, navy, max-width 880px (C:600).
3. `<p class="secsub" style="margin:8px 0 0">Looked at {considered.insights as int, else 0} solutions, offers and wins.</p>`
4. If there are no matches: `.empty` "No partner in the notes clearly does this." plus " Partners working through the same thing are listed below." when peers exist.
5. A numbered list: `<div class="tlist" style="margin-top:18px;border-top:1px solid #9db3da">`. Each match is a `topicRow` (h3), with **no** `data-topic`.
   - Name: the company name, highlighted per §1.1.
   - Meta: `"{High|Medium|Low} match. {industry}. {Council Member|Not Council}."` (`companyFacts`, I:672-674; empty parts are dropped).
   - Body `.band`:
     1. `p.why` with the reason and citation chips (`.band > .why`: margin 0, 16px, line-height 1.55, `#16202b`)
     2. `p.caution` "**Check first:** …" when present (`margin:12px 0 0; border-left:4px solid #fbae40; padding:2px 0 2px 14px; 15px`; bold text navy; C:602-603)
     3. `p.secsub` "Contacts on file: a, b" with `margin-top:10px` (contacts escaped as plain strings)
     4. a points list with label "note": each point is the **bold note title**, and opening it shows `insightCard(note, {company:false})`
     5. `<p style="margin:16px 0 0"><a class="arrowlink" href="#/company/<id>">Open {name}{arrow}</a></p>` when the company has an id
   - Only match 1 gets the chevron cue.
6. When gaps exist: `<p class="secsub" style="margin-top:20px;padding-top:18px;border-top:1px solid #9db3da"><b style="color:navy">Not covered:</b> …</p>`.
7. When search terms exist: `<p class="secsub" style="margin-top:8px">Also searched for: a, b.</p>`.
8. The sources disclosure.
9. When peers exist: `<div class="card" style="margin-top:28px"><h2>Working through the same thing</h2>` holding each peer's notes as insight cards with the peer company.

**Match turn shape** (S:2743-2754): `{kind:"matches", answer, gaps, ranking, searchTerms, followUps:[], matches[{strength, why, caution, company{id,name,industry,status,contacts}, refs[]}], peers[{company, notes[]}], sources[snapshot], considered}`. A snapshot (S:2735-2739) is `{ref, id, kind, title, detail, date, estimated, checkCompany, topicLabel, company, files[{name,url}]}`.

#### 7.7 Pending and error turns (A:241-342, C:711-721)
**Pending turn:**
1. Markup: `div.turn.pending[data-pid]` holding the `.qb` and `div.thinking[role=status]`.
2. `.thinking`: `flex; gap:12px; #4a5663; 15px`. It contains the mark, `span.pi-phrase[aria-hidden]` with the phrase plus "…", and `.sr-only` "Reading the notes…".

**The mark:**
1. `.pi-mark` is 64×32 with a navy SVG of the Conexus loops.
2. `.pm-ride` is an 11.26px amber square rotated 45° that follows `offset-path:path("M32.02 15.99 L39.84 7.94 A11.38 11.38 0 1 1 39.84 24.04 L24.19 7.94 A11.38 11.38 0 1 0 24.19 24.04 Z")`.
3. It runs `pm-ride 2.6s linear infinite`. Its scale is 1 at 0%, 50% and 100%, and 0.42 from 9% to 41% and from 59% to 91%.
4. A negative `animation-delay` keeps all marks on the page in step.
5. Reduced motion stops the ride animation.

**Phrases:** 31 shop-floor phrases (A:246-278), shown in a shuffled bag with no immediate repeat. The phrase changes every `2600*4 = 10400ms`.

**Settle (when the answer arrives):**
1. The diamond runs on to its next crossing of the centre (each half lap) and stops there.
2. It then swells with `rotate(45deg) scale(1) → scale(1.6) at offset .4 → scale(1)`, duration 500ms, easing `cubic-bezier(.45,0,.25,1)`.
3. The mark fades from opacity 1 to 0 over 250ms with a 420ms delay, `ease-in`, `fill:forwards`.
4. The answer waits at most 1s for this. Under reduced motion it resolves immediately.

**Error turn:** `.qb` plus `div.msg.err` with the message (16px in `.asx-out`, colour `#b3401f`).

#### 7.8 Arriving with a prefill (I:658-669)
1. `PI.askPrefill` is read once, then cleared.
2. From "Find solution": `{question, mode:"match", exclude, name}`. `#asxBack` shows `<span class="secsub" style="margin:0">Looking for partners other than {name or "the company with the issue"}.</span>`.
3. From the Ask box's "Find partners who can help": `{question, mode:"match", from:{id,title}}`. `#asxBack` shows `<a href="#" class="back" data-resume="<id>">← Back to Ask box: {title}</a>`.
   - Clicking it calls `AU.resume(id)` and then `history.back()`, or sets `#/home` when there is no history.
   - Arriving back re-opens that conversation in the floating box (A:508, A:606).
4. In both cases the question runs immediately.
5. The `exclude` id goes only with that one question, and the exclusion note clears after it is sent (I:562-563).

---

### 8. Floating Ask box

Covered in full in Part 3A.

---

### 9. Animation inventory for Part 1

**Everything that animates:**
1. Background clouds
2. Header shadow, and the phone lift and fade
3. Time-window lens slide and stretch, plus the 160ms / 180ms content fade
4. Topic circle pop and close, line grow and regrow, highlight wipe, hover spring on the circle and chevron, chevron cue
5. Plus-to-minus button
6. Arrow nudges on `.back`, `.arrowlink`, `.go-arrow`, `button.find`
7. Program card inset ring
8. Spinner
9. Ask pill FLIP, history fades, thinking mark and its settle, citation flash, sources chevron rotation, smooth scrolls
10. Ask box grow, veil, and content fade

**What does not animate:**
1. Companies table sorting or filtering. There is no FLIP and no enter or leave.
2. "Show more" appends: topics, meetings, "Show all" sections.
3. Topic bodies opening, apart from the line.
4. Summaries filling in.
5. Route changes. `#view` swaps instantly.
6. The nav underline.
7. No list in my scope staggers its items.

**Reduced motion:**
- CSS:
  - C:281 stops the background clouds.
  - C:498-500 turns off animations and transitions on the topic circle, line, chevron, highlight, plus button, lens and app bar.
  - C:557 turns off the tab lens and content fades.
  - C:721 stops the thinking mark.
  - C:826 turns off the history fades.
- JS (`STILL`, I:146) skips the lens stretch, sets the fade wait to 0, skips the pill FLIP and uses `behavior:"auto"` for scrolls. `AU.settle` resolves immediately.
- **Not covered:** the spinner, the background-colour transitions on hovers, and the `.back`/`.go-arrow` nudges.

---

### 10. Unclear or worth flagging
1. Two rules with equal specificity define `.tline.shrink`. The later `tline-regrow .5s cubic-bezier(.3,1.3,.5,1)` wins (C:450 against C:461).
2. The program page's meetings list ignores the window on the server, yet it fades and redraws on every window change (S:4044-4045, I:408).
3. Companies table rows cannot be reached by keyboard (I:753-758).
4. `#whoami` is populated but hidden (C:316).
5. The Ask history overlay at ≤1100px has no backdrop and no outside-click close. The Ask page markup has no `[data-off]` element, though the click handler checks for one (I:627).
6. Several hover rules end up at the same colour because `--accent` equals navy in the app: `.asx-go:hover` and `.pm i:hover`.
7. I did not verify how the browser's own hash-traversal scroll restoration interacts with `scrollTo(0,0)`. The code always calls `scrollTo(0,0)` synchronously after starting a render, so the expected result is top-of-page every time.

---

## Part 2: The company page, the design system and motion

**Read first: two global facts**
1. **Desktop zoom.** At widths of 761px and up, `.pi-app .wrap` has `zoom:.8; max-width:1400px; padding-left/right:40px` (CSS:288). The company page sits inside `.wrap`, so every px value below renders at 80% on desktop. The top bar is outside `.wrap` and stays at full size.
2. **`--accent` is navy in the app.** `.pi-app` redefines `--accent:#07214e` (CSS:252). The root value `--accent:#325eae` (CSS:14) applies only outside `.pi-app`, which means the control panel. Everything below that says "accent" renders navy `#07214e`.

---

### 2A. Company page (`#/company/<id>[/<tab>]`)

#### 1.1 Routing and URL
- `route()` (IH:1097-1116) splits the hash on "/". `#/company/<id>` calls `company(decodeURIComponent(id), parts[2] || "overview")` (IH:1113).
- The "Companies" nav link gets `.on` and `aria-current="page"` on company routes (IH:1102).
- Tab URLs come from `tabHref` (IH:802):
  - Overview: `#/company/<encodeURIComponent(id)>`, with no suffix.
  - Other tabs: `#/company/<id>/<tabId>`.
  - Tab ids: `overview`, `issues`, `solutions`, `wins`, `meetings`, `contacts` (IH:780-788).
- Legacy segments map through `OLD_TABS = {problems:"issues", notes:"meetings"}` (IH:789, 821).
- An unknown segment falls back to Overview. The URL keeps the bad segment (IH:822).
- Tabs are plain `<a href>` links. A click changes the hash, `hashchange` fires `route()`, and `company()` runs. If the same company is still on screen (`sameCompany`, IH:872, which checks `coPage.id === id` and that `view` still contains the tab bar), it calls `switchTab` only (IH:824). Browser Back and Forward follow the same path.
- **Scroll.** `route()` calls `window.scrollTo(0,0)` after every route. The exception is a tab move within the company already on screen (`tabMove`, IH:1107, 1115). Tab switches keep the scroll position.

#### 1.2 Data and endpoints
All calls go to `/api/partner-intel/<path>` with `authorization: Bearer <sessionStorage "beta-token">` (PJ:77-88).

1. `GET company?id=<id>` (IH:828). Server: SRV:4083-4090, `profileView` SRV:1739-1766, plus `people`.
   - Response: `{company:{id,name,industry,status,program,contacts,source,people[]}, counts:{insights,wins,problems,solutions,meetings}, meetings[≤60], meetingTotal}`.
   - `industry` falls back to `"Unknown"` (SRV:1756).
   - `people` comes from `companyPeople` (SRV:464-478): `[{name,title,email,source:"upload"|"roster"|"both"}]`, sorted by name with `localeCompare`.
   - The client uses only `company.*` and `company.people`. `counts`, `meetings` and `meetingTotal` are unused.
   - A missing company returns 404 `{error:"Company not found."}`.
2. `GET company/topics?id=<id>&list=all|issues|solutions|wins` (IH:800). Server: SRV:4091-4097, `topicsView` SRV:1826-1832.
   - Response: `{list,total,mentions,byTopic[],latest[≤12],sourceTotal}`.
   - Kinds per list (SRV:1732-1733):
     - issues: `problem`, `ask`
     - solutions: `solution`, `offer`, `equipment`
     - wins: `win`
     - all: the three lists together
3. `GET company/meetings?id=<id>` (IH:801). Server: SRV:4098-4101, `meetingsView` SRV:1837-1841.
   - Response: `{total, meetings: bySource(...)}`.
   - Every kind is included, `news` and `commitment` among them.
- **Topic object** (SRV:1786-1795): `{topic,label,priority,mentions,meetings,issues,resolved,solutions,wins,last,items[]}`. `label` is `"Other"` when the note has no topic.
- **Source/meeting object** (SRV:1816-1818): `{key,date,label,eventType,estimated,programs[],files[{id,name,url}],count,topics[]}`.
- **Item (statement)**, from `shapeInsight` (SRV:918-929): `{id,kind,title,detail,quote,topic,topicLabel,tags,urgency,urgencyReason,status,solves,confidence,scope,date,dateSource,estimated,eventType,series,speaker,sources[{id,name,url}],review,checkCompany,company{id,name,industry,status,member,source}}`.
  - `url` is `https://app.box.com/file/<id>` when the id is all digits, otherwise `""` (SRV:912-914).
- **Client cache** (IH:794-799). `tabCache` is keyed by company id and holds the request promise per path, in an `Object.create(null)` map. A failed request is evicted. The cache resets when a different company loads (IH:826). `switchTab` prefetches the new tab's data before the fade starts (IH:891-892).

#### 1.3 Ordering rules (server)
- **Topic order** (SRV:1797-1798):
  1. The `"other"` topic always goes last.
  2. Then `priority` descending. `priority` is the sum over live mentions of `recencyFactor = 1/(1+ageDays/180)`, rounded to 2 decimals (SRV:1722-1727, 1789). A note with no date counts 0.5.
  3. Then `last` descending.
  4. Then `label` ascending.
- **Items within a topic** (SRV:1783-1784):
  1. Mentions first. A resolved issue (`problem`/`ask` with `status==="resolved"`, SRV:1769) is not a mention and goes last.
  2. Then date descending.
  3. Then category: issues, then solutions, then wins.
  4. Then urgency `{high:0, medium:1, low:2, none:3}` (SRV:1034).
  5. Then `id` ascending.
- `mentions` counts live items only. `last` is the newest live date, or the newest of all items when nothing is live (SRV:1790-1794).
- **Meetings / latest sources:** date descending, then label ascending (SRV:1816). Topics inside one meeting use the same topic sort. Every row there shares one date, so priority comes down to the count.

#### 1.4 Page states before render
1. **Loading:** `view.innerHTML = <div class="card"><span class="spinner"></span>Loading…</div>` (IH:105, 827).
2. **Error** (IH:97-103):
   - If `err.body.empty`: a card with `.empty`: "**There is no data yet.**" then a line break, then "Open the [control panel](/partner-intel/control-panel/), choose the Box folder, and run the first scan."
   - Otherwise: a card holding `<div class="msg err">` with the error message, or "Something went wrong.". For example "Company not found.".
3. Stale responses are dropped with the `seq` counter (IH:95, 825, 829).

#### 1.5 Layout, top to bottom (IH:840-852)
1. **Back link.** `<a class="back" href="#/companies">` containing a BACK svg (left arrow, 16x16 viewBox, stroke 2.4, round caps; IH:50) and the text "All companies" (IH:81, 840).
   - CSS:331-333: `inline-flex`, `align-items:center`, gap 8px, margin `0 0 16px`, 15px, weight 700, navy.
   - Svg 15x15px with `transition:transform .2s`. On hover the svg moves `translateX(-3px)` and the text gets no underline.
2. **Name.** `<h1 class="coname">` (IH:841).
   - 40px, or 28px at ≤600px (CSS:535, 627). `line-height:1.05`, weight 700, `letter-spacing:-0.022em`, navy, margin 0 (CSS:23, 319).
   - If `status==="Active"`, the last word and the council badge are wrapped in `<span class="nw">` (`white-space:nowrap`) so the badge never starts a line on its own (IH:835-838, CSS:536). Other statuses show the plain name with no badge.
3. **Council badge** `svg.cm` (IH:57-80).
   - viewBox `0 0 96 62`, `aria-label="Council member"`, `<title>Conexus Indiana council member</title>`.
   - Rounded-rect outline, stroke 2.6 (path in IH:61).
   - The Conexus mark sits at x22 y9, 52×26.
   - Text "COUNCIL": x49.2, y51, centred, Aptos, weight 700, 12.5px, `letter-spacing:2.4`.
   - One `linearGradient` (userSpaceOnUse, 0,0 to 96,62) is cut to these shapes by a mask. Stops: 0 `#a57c2f`, .22 `#e4c06a`, .36 `#f5df9e`, .5 `#c8952e`, .68 `#a3782a`, .84 `#eccb7a`, 1 `#b48a37`.
   - A "pressed-in" filter (IH:69-77) adds `feTurbulence fractalNoise baseFrequency ".05 1.5" numOctaves 2 seed 7` grain, a dark inner edge (`#3d2700` at .75 opacity, dy 1.3, blur .8) and a white lower catch (dy 1.2).
   - CSS:538: `height:1.12em`, `aspect-ratio:96/62`, `vertical-align:-.21em`, `margin-left:.5em`.
4. **Industry line** `<p class="lede">` (IH:831-832, 842).
   - Parts: `[company.industry, company.program]` with falsy values removed, plus `"Not Council"` if status is not `"Active"` (PJ:107).
   - Joined with ". " and ended with ".". Examples: `Food Manufacturing. Council.` or `Unknown. Not Council.`. Industry reads "Unknown" when the server has none.
   - Omitted entirely when there are no parts.
   - CSS:320: margin `12px 0 0`, 20px, `line-height:1.45`, weight 600, navy, `max-width:780px`. 17px at ≤600 (CSS:628).
5. **Tab bar** (section 1.6).
6. **Panel.** `<section class="tabpanel"><div id="tabBody"></div></section>` (IH:852).
   - CSS:562: margin-top 20px, `#fff`, radius 24px, padding `26px 36px 24px`. Padding `22px 18px` at ≤600 (CSS:629).
   - A `.card` inside the panel gets `padding:0; margin:0; border-radius:0` (CSS:563).

#### 1.6 Tab bar and the sliding pill
**Markup** (IH:845-851):
```
<div class="ctwrap"><nav class="ctabs" aria-label="Company sections" style="--n:6;--at:<from>">
  <i class="ctlens" aria-hidden="true"></i><a href=…>Overview</a>…<a class="on" aria-current="page">…</a></nav>
  <button type="button" class="ctmore" aria-label="More sections" hidden><svg 16x16 path "M6 3l5 5-5 5" stroke 2 round/></button></div>
```
- Labels: Overview, Issues, Solutions, Wins, Meetings, Contacts.
- No counts are shown on the tabs.
- The `note` strings in `COMPANY_TABS` are never rendered.

**Styles:**
- `.ctwrap` (CSS:559-560): `position:relative`, `display:inline-block`, `max-width:100%`, margin-top 32px, `vertical-align:top`. The `.ctabs` inside it has margin-top 0.
- `.ctabs` (CSS:539-540): `position:relative`, `display:inline-grid`, `grid-auto-flow:column`, `grid-auto-columns:1fr`, so every tab is as wide as the widest. Padding 6px, radius 999px, background `rgba(7,33,78,.07)`.
- `.ctabs a` (CSS:541-544, 284):
  - `z-index:1`, `display:flex`, centred both ways, height 52px, padding `0 26px`, radius 999px.
  - 18px, weight 500, colour `#16202b`, `nowrap`, no underline.
  - `transition: color .3s, background-color .2s` (default `ease`).
  - Hover: background `rgba(7,33,78,.05)`, colour navy.
  - `.on` (including on hover): background none, colour `#fff`, weight 600.
- `.ctlens`, the navy pill (CSS:549-551):
  - `position:absolute`, `z-index:0`, top/bottom 6px, left 6px, `width:calc((100% - 12px) / var(--n,6))`, radius 999px.
  - Background navy `#07214e`, `box-shadow:0 2px 6px rgba(7,33,78,.18)`.
  - `translate: calc(var(--at,0) * 100%) 0`. It uses the `translate` property, not `transform`, so the stretch scales about the pill's own centre (comment at CSS:546-548).
  - `transition: translate .6s cubic-bezier(.22,1,.36,1), scale .45s cubic-bezier(.22,1,.36,1)`.
  - `.ctlens.moving { scale:1.18 .88 }` (CSS:554).

**Behaviour on a fresh render** (IH:839, 854-861):
- `from` is the tab index of the last company shown, if `lastTab.id` matches this company, for example after going elsewhere and pressing Back. Otherwise `from` equals the current index.
- The nav is rendered with `--at:from`. If `from !== at`, the code forces layout (`void tabs.offsetWidth`) and then sets `--at` to `at`, so the pill slides over 0.6s.
- The `moving` stretch is not applied on this path.

**Behaviour on a tab switch** (`switchTab`, IH:875-904):
1. Set `.on` and `aria-current` on the new tab and clear them from the others.
2. If `lastTab.at === at`, stop here (no animation).
3. Set `--at = at`. The pill slides 0.6s.
4. If the bar overflows (phone), smooth-scroll it so the active tab is centred: `left = onTab.offsetLeft - (clientWidth - onTab.offsetWidth)/2`.
5. Unless reduced motion: add `moving` to `.ctlens` and remove it after **220ms**. The pill stretches to 1.18×0.88 over .45s, then eases back.
6. Prefetch the new tab's data.
7. Add `#tabBody.fading`, which fades opacity 1 to 0 in **.14s ease** (CSS:556).
8. After **140ms** (0ms with reduced motion):
   - Set `body.style.minHeight = offsetHeight px` so the page does not jump.
   - Call `fillTab()`.
   - When it resolves, clear `minHeight` and remove `fading`, which fades opacity back to 1 in **.18s ease** (CSS:555).
- Reduced motion: `transition:none` on `.ctlens` and `#tabBody` (CSS:557). The JS `STILL` flag (IH:146) skips `moving` and the 140ms wait.

**Phone (≤860px)** (CSS:611-620):
- `.ctabs`: `overflow-x:auto`, scrollbar hidden, background `#e9ecf1`, `grid-auto-columns:108px`.
- Tabs: height 46px, padding `0 8px`, 16px. The pill is 108px wide.
- On render, the bar scrolls so the active tab is centred (IH:857).
- `.ctmore` shows when not `hidden`: absolute at top/right/bottom 0, width 52px, flex centred, padding `0 6px 0 0`, no border, radius `0 999px 999px 0`, background `#e9ecf1`, navy, 18px svg.
  - Hidden when there is no overflow (`scrollWidth <= clientWidth+1`) or when the bar is scrolled within 4px of its end. This is checked on scroll, on resize and once at start (IH:864-868).
  - Click: `scrollBy({left: clientWidth*.6})`, smooth unless reduced motion (IH:865).
- Above 860px, `.ctmore` is always `display:none` (CSS:561).

#### 1.7 `fillTab` dispatch (IH:906-920)
- Overview, Issues, Solutions and Wins go to `topicsTab` (they have `list`).
- Meetings goes to `meetingsTab`.
- Contacts renders synchronously from `company.people`. No extra fetch.

#### 1.8 Overview / Issues / Solutions / Wins (`topicsTab`, IH:925-949)
1. **Loading:** `<p class="small muted" style="margin-top:14px"><span class="spinner"></span>Loading…</p>`. `.small` is 12.5px and `.muted` is `#7c8794`.
2. **Empty** (`r.total === 0`): `<div class="empty">`.
   - Overview: "No issues, solutions or wins recorded yet."
   - Other tabs: "No issues recorded yet." / "No solutions recorded yet." / "No wins recorded yet."
   - `.empty` (CSS:154, 342): padding `28px 10px`, centred, colour `#4a5663`.
3. **Toolbar:** `<div class="row spread toolbar"><div class="seg soft" id="pmode" role="group" aria-label="View">` holding buttons "By topic" (`data-mode="topic"`) and "Latest source" (`data-mode="latest"`). The active one gets `.on` and `aria-pressed="true"`.
   - `topicsMode` is a module-level variable, default `"topic"` (IH:924). It persists across tabs and companies until the page reloads.
   - Styles:
     - `.toolbar`: margin `18px 0 4px` (CSS:564). `.row`: flex, gap 10px, wrap. `.spread`: space-between.
     - `.seg`: gap 8px.
     - Buttons: radius 999px, `1px solid #c9d3e3`, padding `9px 20px`, 14px, weight 600, white, navy (CSS:85-86, 346, 351).
     - `.on` in `.soft`: background and border `#dce6f5`, navy text (CSS:370).
     - No hover change: `.seg button` at CSS:85 overrides `button:hover` at CSS:67.
4. **By topic** (`byTopic`, IH:993-996):
   - `<h2 class="subh">Most Referenced Topics</h2>` on Overview, otherwise "Most Referenced Issues/Solutions/Wins". `#pview > h2.subh` (CSS:321-322): margin `22px 0 4px`, 22px/1.25, weight 700, navy.
   - Then `topicList(r.byTopic, …, limit = TOPICS_SHOWN = 3)` (IH:992).
5. **Topic list** (`topicList`, IH:960-979).
   - Each topic is a `topicRow` (IH:124-134):
     ```
     <section class="tp [open]" [hidden]><h3 class="thead-h"><button type="button" class="tp-row" aria-expanded="false">
       <span class="circ" aria-hidden="true">N</span>
       <span><span class="tname"><span class="hl">First word(s)</span>rest[<span class="allres">All resolved</span>]</span><span class="tmeta">meta</span></span>
     </button></h3><i class="tline [cue]" aria-hidden="true"></i><div class="tbody" data-body hidden>…</div></section>
     ```
   - Numbering starts at 1.
   - **Highlight words** (IH:114-118): the first word. If the first word has 4 or fewer alphanumeric characters and more words follow, the first two words. Trailing `,;:.` is stripped.
   - **Meta:** "Last raised Oct 5, 2026." using `PI.fmtDate(t.last)`. Empty in Latest-source mode (IH:952-954).
   - **"All resolved"** shows after the name when `t.mentions` is 0 (IH:977). CSS:597: margin-left 10px, 13px, weight 700, `#0b6a92`.
   - Only topic 1, while closed, gets the `cue` class.
   - All topics start closed.
   - Topics with index 3 and above get the `hidden` attribute. They are followed by `<p class="colmore"><button class="more" data-more-rows>Show {count} more {noun}</button></p>` (IH:982-984):
     - Overview noun: "topics".
     - Other tabs: "issues", "solutions" or "wins". **Quirk:** the count is topics, not statements, but the noun says "issues/solutions/wins".
     - No singular form: one remaining topic reads "Show 1 more topics" or "Show 1 more issues".
     - Clicking unhides every hidden `.tp` in the preceding `.tlist` at once and removes the `<p>` (IH:985-990). No animation.
   - **Topic body on Overview** (IH:963-972): `<div class="band"><div class="cols3">` with three `<section>` columns, Issues | Solutions | Wins.
     - Each column has `<h4 class="colh k-issue|k-solution|k-win">`. Items are sorted into columns by `PI.categoryOf(kind)`, keeping server order.
     - The first `COLUMN_SHOWN = 3` cards show (IH:956). The rest sit in `<div hidden data-rest>`, followed by `<p class="colmore"><button class="find" data-show-rest>View all issues|solutions|wins` and the ARROW svg.
     - Clicking reveals the rest of that column and removes the button (IH:438-444; it looks up `closest("section")`, which is the column). No animation.
     - An empty column shows `<p class="muted small" style="margin:12px 0 0">None in this topic.</p>`.
     - Items with category "other" are not shown on Overview. The `all` list excludes those kinds on the server.
   - **Topic body on Issues/Solutions/Wins** (IH:974): `<div class="band notes">` with every item card. No cap and no columns.
   - Every card is `rowCard(i, companyId, kind=false)` (IH:816-818), so it gets `company:false`, no kind label, and Find solution when the item is an issue.
6. **Latest source** (`latestSource`, IH:1069-1086):
   - If `r.latest.length > 1`: `<div style="max-width:520px;margin:14px 0 8px"><label class="field" for="psrc">Source</label><select id="psrc">`.
     - Options read `"{fmtDate} · {label || eventType || "Meeting"}"` with value = index. There are at most 12 (server).
     - Select styling (CSS:371, 374): height 46px, `1.5px solid #c9d3e3`, radius 12px, padding `0 14px`, 15px. Focus: border navy and `box-shadow:0 0 0 3px #dce6f5`.
   - Body: `<div style="margin:16px 0 4px"><h3>{label||eventType||"Meeting"}</h3><p class="secsub" style="margin:4px 0 0">`.
     - Text: `{date}[ estimated-date pill][. {programs joined ", "}].[ From {file links}]`. There is no closing period after the file links.
     - h3 is 16px, weight 600, navy. `.secsub` is 15px, `#4a5663`.
   - Then `topicList(s.topics, …, inMeeting=true)` with no limit, so every topic shows and there is no meta line.
   - Changing the select redraws immediately with no animation.

#### 1.9 Topic open/close interaction (IH:147-167; CSS:417-462)
- A click on any `.tp-row` (delegated on `document`):
  1. Removes `cue` from every sibling `.tp` line.
  2. Closes any other open `.tp` in the same parent, so one topic is open at a time.
  3. Toggles this one: `.open`, `aria-expanded`, and `hidden` on `[data-body]`.
- Animations:
  - Circle: `c-open` or `c-close`.
  - Line: `grow` or `shrink`.
  - Classes are restarted with a reflow (IH:135-140) and removed on `animationend` (IH:141-143).
- Keyboard: it is a native `<button>`, so Enter and Space work. Focus-visible removes the row outline and puts `outline:3px solid #fbae40; outline-offset:3px` on the `.circ` (CSS:422-423).
- **Row geometry** (CSS:419): grid `40px minmax(0,1fr)`, gap `0 34px` (`0 16px` at ≤600, CSS:631), padding `24px 0 30px`, no border, no background, `font:inherit`, left-aligned.
- **`.tname`** (CSS:425): block, 25px/1.15, weight 700, navy, `letter-spacing:-0.015em`. 20px at ≤600.
- **`.tmeta`** (CSS:426): block, margin-top 6px, 15px, `#4a5663`.
- **`.circ`** (CSS:427-436):
  - 40×40px, margin-top -3px, `3px solid` navy border, radius 999px, white, navy text, 15px, weight 700, tabular numbers.
  - `transform:scale(var(--s))`.
  - Transitions: `background-color .2s, color .2s, border-color .2s, transform .65s var(--spring)`.
  - Hover: `--s:1.1`, background `#eaf1fb`, border and text navy.
  - Open: `--s:1`, navy fill, white text, `box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 4px 12px rgba(7,33,78,.25)`.
  - Open and hovered: `--s:.9`.
  - `c-open`: `circ-pop .6s ease-out`. Keyframes scale 1 → .84 (24%) → 1.1 (52%) → .97 (74%) → 1, each times `--s`.
  - `c-close`: `circ-close .45s ease-in-out`. Keyframes 1 → .95 (35%) → 1.02 (70%) → 1.
- **`.tline`** (CSS:440-452, 461-462):
  - `position:absolute`, left 19px, top 61px, width 2.5px, height `var(--rest)` = 21px, transparent, radius 2px.
  - `transition:height .65s var(--spring)`.
  - `::after` chevron: 8×8px, `border-right` and `border-bottom` 2px navy, `rotate(45deg)`, bottom 1px, left 50%, margin-left -5px.
  - Hover on a closed topic: `--rest:27px`.
  - `.cue::after`: `chevron-cue 1s ease-in-out 1.2s 2`, a 1.2s delay then two dips. Keyframes: 0/60/100% `translateY(0)`, 25% `translateY(4px)`, rotation kept.
  - Open: width 3px, left 18.5px, `height:calc(100% - 91px)`, navy, `transition:none`, chevron removed.
  - `grow`: `tline-grow .55s ease-out`. Keyframes 0% 14px; 50% `(100% - 91px)*1.07`; 75% `*.99`; 100% `100% - 91px`.
  - `shrink`: the later rule at CSS:461 wins, so the effective animation is `tline-regrow .5s cubic-bezier(.3,1.3,.5,1)`, from height 0 to `var(--rest)`. The `tline-shrink` keyframes (CSS:450, 452) are dead code.
- **`.hl` highlight** (CSS:454-457):
  - `::before` at `z-index:-1`, left/right -.14em, top .31em, bottom .02em, background `#f9f871`.
  - Closed: `scaleX(0)` from the left, `transition: transform .55s cubic-bezier(.4,0,.2,1)`.
  - Open: `scaleX(1)` with `transition: transform 1.25s var(--spring-soft) .08s`.
- **`.band`** (CSS:460): margin `-6px 0 30px 20px`, padding `16px 28px 30px 54px`, no background.
  - `.band.notes`: padding `6px 28px 30px 54px` (CSS:573).
  - At ≤600: `.band` margin-left 20px, padding `12px 8px 26px 36px`; `.notes` padding `6px 8px 26px 36px` (CSS:641-642).
- `.tlist`: margin-top 6px. `.tbody`: padding 0.

#### 1.10 Statement card (`PI.insightCard`, PJ:126-162) as used on the company page
**Order:**
1. `.kindl` label, never shown on company tabs (see below).
2. `.ktopic`, only where `opts.topic` is passed (Meetings tab).
3. `.title`.
4. `.by`.
5. `.detail`.
6. `.why`, the "Addresses:" line.
7. `<details class="src">`.
8. `.acts`.

**Card details:**
- Company page cards use `company:false`, so `.by` never names the company. `.by` appears only when it has content:
  - "Check company": `<span class="pill medium" title="Which company said this is uncertain. Staff can settle it on the control panel, under Statements to check.">` when `checkCompany` is true.
  - "Resolved": when `status==="resolved"`.
  - Parts are separated by a trailing "·" (`::after`, margin `0 8px`, `#7c8794`) on every part but the last (CSS:398).
- **Kind label:** `kind:false` everywhere on the company page except "Other notes" on the Meetings tab. There `kind:true`, but `KIND_TONE` (PJ:114) covers only problem, solution and win. Other-category kinds (news, commitment) therefore still get no label.
- **`.ktopic`** (CSS:593): block, margin-bottom 2px, 12.5px, weight 700, `letter-spacing:.04em`, uppercase, `#7c8794`. Text is the topic label.
- **`.title`:** 21px, weight 700, navy, `line-height:1.35`, margin-top 2px (CSS:123, 392).
- **`.detail`:** 19px, `line-height:1.55`, `max-width:900px`, margin-top 8px (CSS:124, 393, 402).
- **`.by`:** flex wrap, baseline, margin-top 3px, 17px, `#4a5663` (CSS:396). A pill inside gets margin-left 8px and no `::before`.
- **`.why`:** `<b>Addresses:</b> {solves}`, 16px, `#4a5663`, margin-top 6px (CSS:125, 409).
- **Source disclosure:**
  - Native `<details class="src"><summary>Source</summary>`, closed by default. Default UA marker is kept.
  - margin-top 10px, 16px. Summary weight 700, navy, pointer; hover navy (CSS:131-133, 404-405).
  - Contents `<div class="srcm">` (flex wrap, gap `4px 16px`, margin `8px 0 0`, `#4a5663`; CSS:406) in this order:
    1. Date: `PI.fmtDate`, "Mon D, YYYY" in UTC (for example "Oct 5, 2026"), or "No date" (PJ:91-96).
    2. "estimated date" pill (`.pill.est`: italic, `#8a5200`, 12.5px, weight 500). Because it follows a span, `* + .pill::before` puts "·" before it (margin `0 8px 0 4px`, `#7c8794`) (CSS:110-116).
    3. eventType.
    4. speaker.
    5. `<span class="files" title="all names">`: links joined ", ". Box links open with `target=_blank rel=noopener`. `max-width:340px`, ellipsis, nowrap (CSS:407).
  - Then the `<blockquote>` with "“quote”" if a quote exists: margin `8px 0 0`, padding `2px 0 2px 14px`, `border-left:2px solid #c9cdd8`, `#4a5663`, 13px (CSS:134-135).
- **`.acts`** (margin-top 8px) holds Find solution, for issues only.
- **Card frame** (CSS:381-382):
  - Border-top `1px solid #dce3ef`, padding `20px 0`. The first child has no border and padding-top 6px.
  - In `.band.notes`, the border is `#edf0f5` (CSS:595).
  - In `.cols3` (CSS:568-572): border-top `1px #edf0f5`, padding `14px 0`. The first card after `.colh` has no border and padding-top 8px. Title 18px, detail 17px, src/srcm 15px.
- **Phone (≤600):** title 18px, detail 16px, `.by` 15px, src 14.5px (CSS:633-636).
- **Urgency** is never displayed. It is used only in sorting.
- **Status** shows only as "Resolved" in `.by`, the "All resolved" topic tag, and resolved issues sorting last.

#### 1.11 "Find solution"
- **Shown on:** any card whose kind is `problem` or `ask` (IH:813, 817).
- **Markup:** `<button class="find" data-find="{question}" data-co="{companyId}" data-co-name="{i.company.name}">Find solution{ARROW}</button>` (IH:809-812).
  - ARROW svg: 16 viewBox, stroke 2.4, `M2 8h11M9 3.5 13.5 8 9 12.5` (IH:49).
- **Question text:** `"Who can help with this: " + title + (detail ? ". " + detail : "")`. If over 600 characters, cut to 597 and append "..." (IH:805-808).
- **Style** (CSS:410-413): no border, no background, no padding, navy, 16px, weight 700, `inline-flex`, gap 6px. Svg 14×14px with `transition:transform .2s`; hover moves it `translateX(3px)` with no background change.
- The column "View all …" buttons share this style.
- **Click** (IH:1089-1094):
  1. Sets `PI.askPrefill = {question, mode:"match", exclude: companyId, name}`.
  2. Sets `location.hash = "#/ask"`.
  3. The Ask page runs a partner-match search immediately and shows "Looking for partners other than {name}." in `.secsub` (IH:658-666).

#### 1.12 Meetings tab (`meetingsTab`, IH:1034-1067; CSS:575-597)
1. **Loading:** the same `Loading…` paragraph as topic tabs.
2. **Empty:** `<div class="empty">No meetings recorded yet.</div>`.
3. **Summary:** `<p class="msum">{N meeting|meetings}, newest first. Click a meeting to see what came out of it.</p>`. Margin `4px 0 6px`, 15px, `#4a5663`.
4. **Table:** `<table class="tbl mtbl">` with `thead` cells `<th scope="col">Program</th><th scope="col" class="mdate" aria-sort="descending">Date</th>`. Columns are not sortable.
   - `table.tbl th` (CSS:149-150, 526): padding `14px 10px 12px`, `border-bottom:1.5px solid #9db3da`, 13.5px, weight 700, `letter-spacing:.06em`, uppercase, `#4a5663`, left-aligned.
   - The first th has padding-left 34px (CSS:577).
   - `.mdate` cells: width 220px, nowrap (CSS:576).
   - `td` (CSS:527-531): padding `15px 10px`, `border-bottom:1px solid #e6ebf3`, 16.5px, `vertical-align:top`. Last row has no border. `td.cn` is weight 700, navy.
   - The last `tr` is always a `tr.mdetail`, even when hidden, so the last visible meeting row keeps its bottom border.
5. **Each meeting** adds two rows (IH:1039-1045):
   - `<tr class="mtrow click" [hidden data-later]>`, with `<td class="cn">` containing `<button type="button" class="mopen" aria-expanded="false" aria-controls="mt{n}">`:
     - CHEV_RIGHT svg: `.mchev`, `M9 6l6 6-6 6`, stroke 2.6.
     - `<span class="mprog">{program}</span>`, then `<span class="msub">{sub}</span>` if there is one.
   - `<td class="mdate">{fmtDate}[ estimated-date pill]</td>`. No "·" here because the pill follows a text node, not an element.
   - `<tr class="mdetail" id="mt{n}" hidden><td colspan="2">{meetingDetail}</td></tr>`.
6. **Naming** (`meetingNames`, IH:1005-1013):
   - program = `programs.join(", ")`, or `eventType`, or "Meeting".
   - sub collects:
     - `label`, if it differs from the company name and from program;
     - `eventType`, if it differs from program and is not contained (case-insensitive) in label.
   - The two are joined with " · ".
7. **Styles:**
   - `.mopen` (CSS:579-583): grid `24px minmax(0,1fr)`, full width, no padding, border or background, `font:inherit`, left-aligned, pointer.
   - `.mchev`: 14×14px, margin-top 6px, navy, `transition:transform .25s ease`. Rotates 90deg when `aria-expanded="true"`. Reduced motion removes the transition (CSS:594).
   - `.mprog`: block, weight 700, navy.
   - `.msub`: block, margin-top 2px, 14.5px, weight 400, `#4a5663`.
   - Row hover: `td` background `#eaf1fb`, cursor pointer (CSS:152, 529). An open row keeps its `td` background `#eaf1fb` (CSS:586).
8. **Toggle** (IH:1053-1061): a delegated click anywhere in `tr.mtrow` flips `aria-expanded`, `.open` on the row, and `hidden` on the detail row. It opens instantly with no height animation. Enter and Space work through the native button. No custom focus style.
9. **Cap:** the first `MEETINGS_SHOWN = 10` rows show (IH:1001). If more exist: `<p class="colmore"><button class="more" data-more-meetings>Show {N} more meetings</button></p>`.
   - Always plural, so one remaining reads "Show 1 more meetings".
   - The click reveals all the rest at once and removes the button (IH:1062-1066).
10. **Detail** (`meetingDetail`, IH:1015-1033):
    - `<div class="mband">`: relative, margin `4px 0 24px 20px`, padding `6px 4px 4px 32px`. `::before` draws a 3px navy bar at left -1.5px, full height, radius 2px (CSS:588-589).
    - `<p class="mfrom">From {file links}</p>` if there are files. 15px, `#4a5663`, margin `0 0 10px` (CSS:324, 590).
    - Then `.cols3`: Issues | Solutions | Wins. Notes are flattened in topic order, then item order. Each card gets `opts.topic = topic label`, so the `.ktopic` line shows. Each column caps at 3, then "View all …". An empty column reads "None from this meeting.".
    - Then, if any exist, `<section class="mother"><h4 class="colh">Other notes</h4>` with cards. Margin-top 18px, padding-top 12px, `border-top:1px solid #edf0f5`; cards bordered `#edf0f5`, padding `14px 0` (CSS:591-592).

#### 1.13 Contacts tab (IH:909-918)
- If `people.length > 0`: `<table class="tbl" style="margin-top:14px">` with headers Name, Title, Email, Source.
  - Name is in `td.cn`.
  - Email is a `mailto:` link. It has no class, so it is underlined with `text-underline-offset:3px` and 1px thickness (CSS:283).
  - Source labels: upload is "Contacts upload", roster is "Member roster", both is "Roster and contacts upload".
  - Rows are not clickable and have no hover style.
- Otherwise: `<div class="empty">No contacts on file. Upload the contacts list in the <a href="/partner-intel/control-panel/">control panel</a>.</div>`.
- This tab returns `null`, so the fade-in follows right after it is filled.

#### 1.14 Shared button: `button.more`
- CSS:346-349: radius 999px, `2px solid` navy, white, navy text, weight 700, padding `10px 22px`, 14px.
- Hover: navy fill, white text. Instant, with no transition.
- `.pi-app .colmore` margin `14px 0 0` (CSS:596).

#### 1.15 Motion on the company page: what does not exist
- No list enter animations, no staggers, no FLIP, no per-item delays.
- The page swaps in with plain `innerHTML`. Tab content fades (.14s out, .18s in).
- "Show more" and "View all" reveal instantly.
- The only per-item motion is the topic open/close set (circle, line, highlight) and the meeting chevron rotation.

#### 1.16 Context
- The floating Ask box (askbox.js) appears on this page. When the hash is `#/company/<id>`, its empty state starts with the suggestion "Summarize what we have heard from this company.", and new conversations carry `companyId` (askbox.js:364-367, 390-392, 468, 476).
- It is covered in Part 3A.

---

### 2B. Design system and motion (pi.css)

#### 2.1 Tokens
**`:root`** (CSS:10-16): `color-scheme:light`

| Token | Value |
|---|---|
| `--page` | `#ffffff` |
| `--surface-1` | `#ffffff` |
| `--navy` | `#07214e` |
| `--text-primary` | `#16202b` |
| `--text-secondary` | `#4a5663` |
| `--text-muted` | `#7c8794` |
| `--border` | `#e1e2e9` |
| `--border-strong` | `#c9cdd8` |
| `--wash` | `#f3f5f9` |
| `--accent` | `#325eae` |
| `--teal` | `#108fc2` |
| `--sky` | `#00b0f0` |
| `--amber` | `#fbae40` |
| `--coral` | `#f26b43` |
| `--good` | `#108fc2` |
| `--warn` | `#fbae40` |
| `--bad` | `#f26b43` |
| `--nav-text` | `#c9d3e3` |

**`.pi-app` overrides** (CSS:252-254, 388):

| Token | Value |
|---|---|
| `--accent` | `#07214e` |
| `--hl` | `#f9f871` (highlight yellow) |
| `--soft` | `#dce6f5` |
| `--band` | `#eaf1fb` |
| `--rule` | `#9db3da` |
| `--line` | `#c9d3e3` |
| `--issue` | `#a82b50` |
| `--solution` | `#937000` |
| `--win` | `#136c50` |

**Easing curves defined as tokens:**
- `--spring: linear(0, 0.055, 0.195, 0.383, 0.588, 0.784, 0.953, 1.084, 1.172, 1.221, 1.234, 1.219, 1.185, 1.140, 1.092, 1.047, 1.008, 0.978, 0.958, 0.948, 0.945, 0.949, 0.958, 0.968, 0.979, 0.990, 0.999, 1.006, 1.010, 1.012, 1.013, 1.012, 1.010, 1.007, 1.005, 1.002, 1)`
- `--spring-soft: linear(0, 0.045, 0.153, 0.291, 0.437, 0.575, 0.697, 0.799, 0.880, 0.940, 0.983, 1.011, 1.028, 1.036, 1.038, 1.037, 1.032, 1.027, 1.021, 1.016, 1.011, 1.008, 1.004, 1.002, 1.001, 1.000, 0.999, 0.999, 0.999, 0.999, 1)`

**Literal colours used:**
- Rules and borders: `#dce3ef` (item rule), `#edf0f5` (faint rule), `#e6ebf3` (table td rule), `#e9ecf1` (phone tab track).
- Text tones: `#0b6a92` (ok / all resolved), `#8a5200` (medium / estimated / caution), `#b3401f` (error / high).
- Ask surfaces: `#eef2fa` (cite and toggle background), `#c9d6ee`, `#eef0f3` (Ask rail), `#dcdfe4`, `#e1e6ef`.

**Dark mode:** none. There is no `prefers-color-scheme` rule anywhere and `color-scheme` is `light` (grep confirmed).

#### 2.2 Typography
- **Family:** `Aptos, "Segoe UI", Arial, sans-serif` (CSS:19, 659). No `@font-face` or webfont link; it relies on installed fonts.
- **Base:** `body` 14px/1.55 (CSS:18-19). `body.pi-app` is 15px (CSS:257).
- **Headings:** h1 to h4 are navy, weight 600, margin 0 (CSS:23).

| Element | Base | In `.pi-app` |
|---|---|---|
| h1 | 34px/1.15, -0.01em (26px ≤600) | 44px/1.05, weight 700, -0.022em (32px ≤600) (CSS:319, 626) |
| h2 | 20px/1.25 | `h2.subh`: 22px/1.25, 700, margin-top 44px (CSS:321) |
| h3 | 16px | none |
| h4 | 13.5px | none |
| `.card > h2` / `> h3` | none | 22px, 700 |

- Other text styles:
  - `.lede`: 20px/1.45, 600, accent.
  - `.secsub`: 15px secondary.
  - `.small`: 12.5px.
  - `.muted`: `#7c8794`.
  - `.tname`: 25px.
  - `.bpt .txt`: 20px/1.5 (17px ≤600).
- Uppercase labels:
  - `th`: `.06em` in `.tbl`, `.04em` base.
  - `.ktopic`: `.04em`.
  - `.kindl`: 14px, 700, `.06em` (CSS:385).
  - `.rl-group`: 11.5px, `.06em`.
- Tabular numbers on `.circ`, `td.num` and `.bignum`.

#### 2.3 Page and layout
- `* { box-sizing:border-box }`. `html { scroll-padding-top:84px }` (CSS:39).
- `html` starts `visibility:hidden` and is revealed by the script (IH:10, 39).
- **Background** (`body.pi-app`, CSS:257): `linear-gradient(165deg, #ffffff 0%, #f2f2f4 45%, #d9dfea 100%) fixed`.
- **Three drifting "clouds"** (CSS:258-281): `position:fixed; z-index:-1; pointer-events:none; filter:blur(90px); will-change:transform; animation: ease-in-out infinite alternate`.

  | Cloud | Position and size | Fill | Animation |
  |---|---|---|---|
  | `body::before` | left -180px, top 60px, 860×640 | `rgba(7,33,78,.03)` | `pi-morph-a` 42s |
  | `body::after` | right -160px, top 260px, 720×620 | `rgba(50,94,174,.05)` | `pi-morph-b` 50s |
  | `html:has(>body.pi-app)::before` | left 38%, bottom -260px, 560×520 | `rgba(50,94,174,.10)` | `pi-morph-c` 38s |

  - Keyframes animate `border-radius` and `transform` at 0/50/100% (CSS:266-274):
    - a: translate(70px,40px) rotate(10deg) at 50%, then translate(-30px,90px) rotate(-8deg).
    - b: translate(-80px,-30px) rotate(-12deg) at 50%, then translate(-20px,60px) rotate(6deg).
    - c: translate(50px,-70px) rotate(14deg) at 50%, then translate(-60px,-20px) rotate(-6deg).
    - Exact radii are in the file.
  - At ≤760px: blur 56px; sizes 420×360 (left -120, top 40), 380×340 (right -140, top 360), 320×300 (left 20, bottom -120).
  - Reduced motion: `animation:none`.
- **`.wrap`:** base `max-width:1080px; padding:32px 32px 96px`. In the app: `max-width:1120px; padding:44px 32px 96px`. At ≥761px: `zoom:.8; max-width:1400px; padding:0 40px` horizontally. At ≤600: `28px 16px 64px`. With the Ask box on: padding-bottom 150px.
- **`.card` in the app** (CSS:338-343): `#fff`, no border, radius 24px, padding `28px 36px`, margin `20px 0 0`. At ≤600: padding `22px 18px`. `.banner` radius 16px.
- **Shadows in use:**
  - App bar raised: `0 2px 10px rgba(7,33,78,.10)`.
  - Pill: `0 2px 6px rgba(7,33,78,.18)`.
  - Open circle: as in 1.9.
  - Others belong to the glass lens and Ask components.

#### 2.4 Top bar (CSS:36-50, 293-316; PJ:12-30)
- Sticky, `z-index:100`, navy.
- `.raised` (scrollY > 2): `box-shadow:0 2px 10px rgba(7,33,78,.10)`.
- `.in`: max-width 1120px, min-height 64px, gap `0 24px`, `align-items:stretch`.
- `.appname`: 20px, 600, white.
- `.nav a`: flex, padding `0 12px`, 4px transparent top and bottom borders, `#c9d3e3`, 17px, weight 400.
  - Hover: white.
  - `.on`: white, weight 500, `border-bottom-color:#f9f871`.
- `.tools`: 14px, gap 18px. `#whoami` is hidden.
- Transitions: `box-shadow .2s ease, transform .18s cubic-bezier(.25,1,.5,1)`.
- **Phone (≤600):**
  - Two-row grid, padding `0 12px`.
  - Name and tools are 44px tall with `opacity:var(--fade)` and `transition:opacity .18s cubic-bezier(.25,1,.5,1)`.
  - JS sets `--lift = min(nav.offsetTop, scrollY)px` and `--fade = 1 - lift/row`. The bar moves `translateY(-lift)`. `.lifted` hides the name and tools.
  - Nav links: padding `6px 10px 4px`, 15px. A later rule sets `8px 8px` (CSS:625).

#### 2.5 Buttons, pills, fields
- **Base `button`** (CSS:65-72): 13.5px, 600, radius 4px, `1px solid #c9cdd8`, padding `7px 14px`, white, navy. Hover `#f3f5f9`. Disabled `opacity:.5`.
- **App `button`** (CSS:346): radius 999px, 14px, padding `9px 20px`, `1px solid #c9d3e3`.
- **`button.primary`:** padding `12px 26px`, 15px, 700, no border, accent fill. Hover navy.
- **`button.more`:** see 1.14.
- **`button.find`:** see 1.11.
- **`button.link`:** no chrome, weight 700, underlined in the app.
- **Glass `.seg.glass`** time window, used on Home and program pages (CSS:355-369):
  - Track: padding 4px, radius 999, `rgba(7,33,78,.07)`, `backdrop-filter: blur(24px) saturate(180%)`, `1px solid rgba(7,33,78,.12)`, `box-shadow: inset 0 1px 2px rgba(7,33,78,.06), 0 1px 0 rgba(255,255,255,.8)`.
  - Buttons: 38px tall, padding `0 22px`, 15px, 600 (700 when on), `transition:color .3s`. Focus-visible: `3px solid #fbae40`, offset 2px.
  - `.lens`: absolute, top and left 4px, 38px tall, `rgba(255,255,255,.4)`, `backdrop-filter: saturate(170%) brightness(1.06)`, `1px solid rgba(255,255,255,.85)`, four inset shadows.
  - Lens transitions: `left .6s cubic-bezier(.22,1,.36,1), width .6s cubic-bezier(.22,1,.36,1), transform .45s cubic-bezier(.22,1,.36,1)`. `.moving` applies `transform: scaleX(1.18) scaleY(.88)`.
  - `html.lg-refract` (Chromium) adds an SVG displacement filter `url(#pi-lens-glass)` built by `PI.glassFilter` (PJ:35-66). Parameters: `LENS_GLASS {freq:"0.04 0.09", octaves:1, seed:4, scale:12, rim:12, rimY:8, soft:5}`.
- **Pills** are plain text (CSS:110-116): inline, 12.5px, 500, `#4a5663`, nowrap. `* + .pill::before` inserts a "·" separator.
  - `.good`: `#0b6a92` 600.
  - `.medium`: `#8a5200` 600.
  - `.high`: `#b3401f` 600.
  - `.est`: `#8a5200` italic.
- **Fields** (CSS:371-377):
  - input/select: 46px tall, `1.5px solid #c9d3e3`, radius 12px, padding `0 14px`, 15px.
  - textarea: radius 12px, padding 14px, min-height 104px.
  - Focus: no outline, navy border, `box-shadow:0 0 0 3px #dce6f5`.
  - `label.field`: 13.5px, 600, `#4a5663`, margin-bottom 6px.
  - Checkbox: 17px, `accent-color` navy.
- **Links:** base `a` uses accent with no underline; hover navy with underline.
  - In the app, `.wrap a:not([class])` and `button.link` are underlined with offset 3px and thickness 1px (CSS:283).
  - `.back`/`.arrowlink` svg moves ∓3px over .2s (CSS:332-335).
- **Spinner** (CSS:165-167): 14px, `2px solid #e1e2e9`, top border accent, round, `spin .8s linear infinite` (to `rotate(360deg)`), `vertical-align:-2px`, margin-right 6px. It is not stopped by reduced motion.

#### 2.6 Tables (`table.tbl`)
- Base: `width:100%`, `border-collapse:collapse`.
- `th`: left-aligned, uppercase, `#4a5663`, weight 600.
- `td`: `vertical-align:top`.
- `tr.click`: pointer cursor. The app values are in 1.12.
- At ≤760px, `table:not(.sr-only)` becomes `display:block; overflow-x:auto` (CSS:244).

#### 2.7 Every transition and animation in pi.css

| Where (CSS line) | What | Value |
|---|---|---|
| 36 | `.appbar` | `box-shadow .2s ease` |
| 294 | `.pi-app .appbar` | `box-shadow .2s ease, transform .18s cubic-bezier(.25,1,.5,1)` |
| 309 | phone `.appname`/`.tools` | `opacity .18s cubic-bezier(.25,1,.5,1)` |
| 166-167 | `.spinner` | `spin .8s linear infinite` |
| 259-274 | background clouds | `pi-morph-a` 42s / `-b` 50s / `-c` 38s, `ease-in-out infinite alternate` |
| 332-335 | `.back`/`.arrowlink` svg | `transform .2s` (±3px on hover) |
| 359 | `.seg.glass button` | `color .3s` |
| 367-368 | `.seg .lens` | `left`/`width` .6s and `transform` .45s, all `cubic-bezier(.22,1,.36,1)`; `.moving` = `scaleX(1.18) scaleY(.88)` |
| 412-413 | `button.find` svg | `transform .2s`, hover `translateX(3px)` |
| 429 | `.circ` | `background-color .2s, color .2s, border-color .2s, transform .65s var(--spring)` |
| 433-436 | `.circ.c-open` / `.c-close` | `circ-pop .6s ease-out` / `circ-close .45s ease-in-out` |
| 441 | `.tline` | `height .65s var(--spring)` |
| 445-446 | `.tline.cue::after` | `chevron-cue 1s ease-in-out 1.2s` delay, 2 iterations |
| 447 | `.tp.open .tline` | `transition:none` |
| 449, 451 | `.tline.grow` | `tline-grow .55s ease-out` |
| 450, 452 | `.tline.shrink` | `tline-shrink .6s ease-out`, overridden by line 461 (dead) |
| 461-462 | `.tline.shrink` (effective) | `tline-regrow .5s cubic-bezier(.3,1.3,.5,1)`, height 0 to `var(--rest)` |
| 456-457 | `.hl::before` | close `transform .55s cubic-bezier(.4,0,.2,1)`; open `transform 1.25s var(--spring-soft) .08s` |
| 485 | `button.pm i` | `background-color .15s` |
| 488-489 | `button.pm .v` | to plus: `transform .14s ease-out .1s`; to minus: `transform .14s ease-in` (`scaleY(0)`) |
| 490-497 | `button.pm.a-shrink`/`a-expand` and `.h` bars | `pm-pop`/`pm-pop-b` .5s ease-out (scale 1 → .74@24% → 1.08@52% → .97@72% → 1); `pm-bar`/`pm-bar-b` .5s ease-out (scaleX 1 to 40%, 1.12@58%, .97@78%, 1) |
| 506 | `.pcard` | `box-shadow .2s` |
| 511 | `.go-arrow` | `transform .25s cubic-bezier(.3,1.6,.5,1)`, hover `translateX(5px)` |
| 542 | `.ctabs a` | `color .3s, background-color .2s` |
| 551, 554 | `.ctlens` | `translate .6s cubic-bezier(.22,1,.36,1), scale .45s cubic-bezier(.22,1,.36,1)`; `.moving` `scale:1.18 .88` |
| 555-556 | `#tabBody`, `.fades` | `opacity .18s ease`; `.fading` = opacity 0 with duration .14s |
| 582-583 | `.mopen .mchev` | `transform .25s ease`, `rotate(90deg)` when open |
| 655 | `.ax-veil` | `opacity .35s ease` |
| 660 | `.abx` | `width .42s cubic-bezier(.2,.8,.2,1), height .48s cubic-bezier(.2,.8,.2,1), border-radius .42s, box-shadow .42s` |
| 672 | `.abx-head`/`-body`/`-rail` | `opacity .25s ease .14s` |
| 719-720 | `.pi-mark .pm-ride` | `pm-ride 2.6s linear infinite` (offset-path figure 8, scale 1 / .42) |
| 735-736 | `.srcs` summary svg | `transform .2s`, `rotate(-90deg)` when closed |
| 747-748 | `.flash` | `ax-flash 1.4s ease` (`#eef2fa` held to 40%, then transparent) |
| 821-825 | `.asx` rail and main | `asx-fade-a`/`-b` .25s ease (opacity 0 to 1) |

**JS-driven timings in index.html:**
- Pill and lens `moving` class held for 220ms (IH:301, 889).
- Tab fade wait 140ms (IH:903).
- Time-window fade wait 160ms (IH:312).
- Summary request delay 700ms (IH:236).
- Ask pill slide: `transform .7s cubic-bezier(.22,.8,.24,1)`, cleared after 750ms (IH:505-507).
- Smooth scrolls (IH:512, 865, 886).
- askbox.js has its own JS motion, covered in Part 3A.

#### 2.8 Reduced motion
- **CSS rules:**
  - CSS:281: clouds `animation:none`.
  - CSS:498-500: `.circ`, `.tline`, `.tline::after`, `.hl::before`, `button.pm`, `button.pm i`, `.seg .lens` and `.appbar` all get `animation:none !important; transition:none !important`.
  - CSS:557: `.ctlens`, `#tabBody` and `.fades` get `transition:none`.
  - CSS:594: `.mchev` gets `transition:none`.
  - CSS:721: `.pm-ride` gets `animation:none`.
  - CSS:826: `.asx-rail`/`.asx-main` get `animation:none !important`.
- **JS:** `STILL` (IH:146) skips the `moving` stretch, sets the fade waits to 0, and switches smooth scrolling to `auto`.
- The spinner still spins.

#### 2.9 Breakpoints
| Breakpoint | Lines | What changes |
|---|---|---|
| `max-width:600px` | CSS:31, 50, 307-315, 622-645, 883-893 | Phone layout, top-bar lift, type sizes |
| `max-width:700px` | CSS:786-800 | Ask box |
| `max-width:760px` | CSS:186-192, 204, 237-242, 244, 275-280 | Base topic layout, scrolling tables, smaller clouds |
| `min-width:761px` | CSS:288 | `zoom:.8` |
| `max-width:860px` | CSS:61, 609-621 | Single column for `.cols3` and `.pgrid`, scrolling tab bar |
| `max-width:1100px` / `min-width:1101px` | CSS:827-831, 878-882 | Ask page rail |

#### 2.10 Unclear or dead code
1. The first half of pi.css (CSS:1-244) is shared with the control panel. Several selectors there are not used by the company page: `nav.tabs`, `.cohead`, `details.ptopic`, `h4.colhead`, `.thead`, `.topics`, `.rank`.
2. `.mtopic` (CSS:325-329) is not produced by the current Meetings code.
3. `.tp { --rest:14px }` (CSS:418) is shadowed by `.tline { --rest:21px }`.
4. The file header comment says "no gradients or shadows", but the app section uses both.
5. I did not verify how `linear()` easing and the `translate`/`scale` properties fall back in older browsers. The code includes no fallback.

---

## Part 3: The floating Ask box and the control panel

Sources read: `public/partner-intel/askbox.js` (AB), `public/partner-intel/pi.css` (CSS), `public/partner-intel/pi.js` (PJ), the Ask parts of `public/partner-intel/index.html` (IX), `public/partner-intel/control-panel/index.html` (CP). I checked the server response shapes in `src/partner_intel.js` (SRV). I changed nothing.

**Colour context.** The Ask box lives in `body.pi-app` (IX:12). There, `--accent` is redefined to `#07214e` (navy) (CSS:252). Every `var(--accent)` in the Ask box therefore renders navy, not `#325eae`. The control panel body has no class (CP:12), so it keeps the base tokens (CSS:12-15): `--accent:#325eae`, `--navy:#07214e`, `--text-primary:#16202b`, `--text-secondary:#4a5663`, `--text-muted:#7c8794`, `--border:#e1e2e9`, `--border-strong:#c9cdd8`, `--wash:#f3f5f9`, `--amber:#fbae40`. The Ask box also uses `--amber:#fbae40`.

---

### 3A. The floating Ask box

#### 1.1 Where it appears

1. `askbox.js` is loaded only by the staff app `index.html` (IX:34), after `pi.js`. The control panel does not load it.
2. It mounts on DOMContentLoaded, or at once if the DOM is already parsed (AB:609).
3. It appends two elements to the end of `<body>`, outside `.wrap`, so the desktop `zoom:.8` on `.wrap` (CSS:288) does not apply to it (CSS:648). The markup is at AB:524-541:
   - `div.ax-veil[aria-hidden=true]`
   - `section.abx[aria-label="Ask"]`, which contains:
     - `aside.abx-rail[aria-label="Past questions"]` > `div.rl-top` > `button.ax-back[data-off=rail]` (back icon + "Back"); then `div.rl-list`; then `p.rl-note`.
     - `div.abx-main` > `header.abx-head` > `div.abx-hl` > `h2.abx-title` "Ask Partner Intelligence" plus `div.abx-hb` holding the History toggle and the New button. The header also holds `button.ax-shrink[aria-label=Shrink]` (down chevron).
     - `div.abx-body` > `div.abx-thread`.
     - `form.abx-bar` > `button.ax-hist[aria-label="Past questions"]` (clock icon); `label.sr-only[for=abxq]` "Ask anything about the partner notes"; `textarea#abxq[rows=1][maxlength=1500][placeholder="Ask anything about the partner notes"]`; `button.ax-up[aria-label="Open the conversation"]` (up chevron); `button[type=submit].ax-send[aria-label=Ask]` (up arrow).
4. **Hidden on the Ask route.** `onAskPage()` matches `location.hash` against `/^#\/?ask(\/|$)/` (AB:363). `place()` runs on mount and on every `hashchange` (AB:595-607). On Ask, the box shrinks instantly (`shrink(true)`) and gets `root.hidden = true` (`.abx[hidden]{display:none}`, CSS:661). Everywhere else, `body.ax-on` is set. That class adds `padding-bottom:150px` to `.pi-app.ax-on .wrap` (CSS:652) so page content clears the dock.

#### 1.2 Icons (AB:14-28)

All icons are SVG with `fill=none stroke=currentColor`, round caps and joins, `aria-hidden`. Stroke width is 2 unless stated.

| key | size | viewBox | stroke | path |
|---|---|---|---|---|
| clock | 20 | 0 0 24 24 | 1.8 | `M3 12a9 9 0 1 0 3-6.7` + `M3 4v4h4` + `M12 7v5l3 2` |
| up | 18 | 0 0 16 16 | 2 | `M8 13V3M3.5 7.5 8 3l4.5 4.5` |
| arrow | 18 | 16 | 2 | `M2 8h11M9 3.5 13.5 8 9 12.5` |
| down | 18 | 16 | 2 | `M3.5 6 8 10.5 12.5 6` |
| open | 18 | 16 | 2 | `M3.5 10 8 5.5 12.5 10` |
| plus | 14 | 16 | 2 | `M8 3v10M3 8h10` |
| back | 16 | 16 | 2.2 | `M14 8H3M7 3.5 2.5 8 7 12.5` |
| rail | 15 | 16 | 1.6 | `<rect x=1.5 y=2.5 width=13 height=11 rx=2/>` + `M6 2.5v11` |
| bin | 15 | 16 | 1.6 | `M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5` |

CSS overrides some sizes. The `.srcs > summary svg` is 12×12 (CSS:735) and `.fu svg` is 13×13 (CSS:763).

#### 1.3 Collapsed pill (default state)

**Container** `.abx` (CSS:657-660):
- `position:fixed; z-index:901; left:50%; bottom:28px; transform:translateX(-50%)`
- `width:min(720px, calc(100vw - 32px)); height:60px; box-sizing:border-box`
- `display:flex; border:1px solid var(--border); border-radius:30px; overflow:hidden`
- `font:15px/1.55 Aptos,"Segoe UI",Arial,sans-serif; color:var(--text-primary)`

**Glass look when not open** (CSS:666-667):
- `background:rgba(255,255,255,.4)`
- `backdrop-filter:blur(14px) saturate(180%)`, with the `-webkit-` prefix too
- `border-color:rgba(7,33,78,.24)`
- `box-shadow: inset 0 0 0 1px rgba(255,255,255,.7), inset 0 1px 1px rgba(255,255,255,.95), 0 2px 4px rgba(7,33,78,.1), 0 8px 24px rgba(7,33,78,.14)`
- The base shadow `0 10px 30px rgba(7,33,78,.14)` (CSS:659) is overridden by this rule.

**Chromium refraction.**
- `pi.js` adds `html.lg-refract` when `navigator.userAgentData` exists (PJ:35).
- The collapsed pill then uses `backdrop-filter:url(#pi-ask-glass) blur(1.5px) saturate(170%) brightness(1.05)` (CSS:668).
- The SVG filter `#pi-ask-glass` is built by `PI.glassFilter` (PJ:38-66). It is sized to the pill's `offsetWidth`/`offsetHeight` and uses `PI.ASK_GLASS = {freq:"0.011 0.045", octaves:2, seed:7, scale:28, rim:22, rimY:13, soft:8}` (PJ:36).
- Filter chain: feTurbulence fractalNoise → feDisplacementMap (scale 28, R/G channels) → white feFlood inset by rim 22/rimY 13 → feGaussianBlur stdDeviation 8 → composite "in" for the clear middle and "out" for the warped rim → feMerge. The filter lives in a hidden `<svg id="pi-glass-defs">`.
- It is rebuilt on mount, on `resize`, and on every `transitionend` of `.abx`, only while not `.open` (AB:550-553). It is skipped when the size is unchanged (PJ:42).

**Bar** `.abx-bar` when collapsed (CSS:686): `display:flex; align-items:center; gap:6px; min-height:58px; padding:0 8px`. `.abx-main` is a flex column with `justify-content:flex-end` (CSS:671), so only the bar shows when collapsed.

**Bar contents, left to right:**
1. `.ax-hist` (clock). It is a 44×44 circle with no border (CSS:692-693). Collapsed override (CSS:669): `background:rgba(255,255,255,.55); box-shadow:inset 0 1px 0 #fff, 0 0 0 1px rgba(7,33,78,.14); color:var(--navy)`. Hover rule: `background:var(--wash); color:var(--navy)` (CSS:697). The base `.abx .ax-hist` is transparent with `--text-secondary` (CSS:696).
2. `textarea`. Styles (CSS:688-689): `flex:1 1 auto; min-width:0; height:26px; border:0; resize:none; background:transparent; padding:0 6px; font-size:16px; line-height:1.6; overflow:hidden; outline:none; box-shadow:none`.
3. `.ax-up` (open chevron). Shown only when `.abx.has-conv:not(.open)` (CSS:698-699), meaning a conversation exists but the box is collapsed. It is transparent with navy colour, and on hover gets `--wash`.
4. `.ax-send` (up arrow). 44×44 circle (CSS:694-695, 670). Collapsed: `background:rgba(7,33,78,.9); box-shadow:inset 0 1px 0 rgba(255,255,255,.3), 0 4px 12px rgba(7,33,78,.25)`, white icon. Hover: `background:var(--accent)`, which is navy in pi-app.

**Placeholder fitting** `A.fitPlaceholder` (AB:347-354): the box uses the long placeholder "Ask anything about the partner notes" if it fits on one line; otherwise "Ask about the notes". Test: `scrollHeight > clientHeight + 2` with `height:auto`. It runs at mount, on window resize, and 500 ms after open or shrink (AB:375, 433, 445, 594, 597). It does nothing when the textarea has a value.

**Autosize** (AB:376-379): `height = min(scrollHeight, open ? 140 : 40)` px. It runs on `input`, open, shrink, and submit.

#### 1.4 Opening (expand upward into a panel)

**Triggers:**
1. Submitting a question.
2. Clicking `.ax-up`, which runs `openBox()` and then `scrollToLast()` (AB:590).
3. Clicking `.ax-hist`, which runs `openBox()` and then `setToggle("rail", true)` (AB:591).
4. Opening a conversation from history (AB:503).

**Sequence in `openBox()`** (AB:420-434):
1. Add `.show`. This sets `.abx-head` and `.abx-body` to `display:flex`, and `.abx-rail` too if `.rail` is set. They start at `opacity:0` (CSS:672-674).
2. Force a reflow.
3. Add `.open`.
4. Set `role="dialog"` and `aria-modal="true"`.
5. Add `veil.on`.
6. Add `html.ax-lock` (`overflow:hidden`, CSS:653).
7. Call `setWidth()`, `render()`, `autosize()`, then `fitPrompt` after 500 ms.

**Open state CSS:**
- `.abx.open` (CSS:662): `height:min(692px, calc(100vh - 96px)); border-radius:28px; box-shadow:0 18px 50px rgba(7,33,78,.2)`. The background becomes plain `#fff` with `border:1px solid var(--border)`. The glass rule only applies `:not(.open)`, so the switch is instant and not transitioned.
- Width is set inline by `setWidth()` (AB:370-374): `min(820px, calc(100vw - 32px))`, or `min(1090px, calc(100vw - 32px))` when History (rail) is on. At ≤700px, or when closed, the inline width is cleared and the CSS width applies.
- `.abx` transition (CSS:660): `width .42s cubic-bezier(.2,.8,.2,1), height .48s cubic-bezier(.2,.8,.2,1), border-radius .42s, box-shadow .42s`. The last two use the default `ease`.
- Contents fade with `.abx-head, .abx-body, .abx-rail { transition:opacity .25s ease .14s }` (0.14 s delay) to `opacity:1` under `.abx.open` (CSS:672, 675).
- In the open bar (CSS:687): `margin:12px 16px 16px; min-height:56px; border:1px solid var(--border); border-radius:999px; padding:0 6px 0 20px`. `.ax-hist` is hidden (CSS:700). `.ax-up` is hidden. The textarea gets `overflow-y:auto` (CSS:690).

**Veil** `.ax-veil` (CSS:654-656): `position:fixed; inset:0; z-index:900; background:rgba(7,33,78,.16); backdrop-filter:blur(8px)`. It goes from `opacity:0; pointer-events:none` to `.on{opacity:1; pointer-events:auto}` with `transition:opacity .35s ease`.

**Header** `.abx-head` (CSS:676-680):
- `align-items:flex-start; gap:8px; padding:14px 16px 10px 28px`.
- Left column `.abx-hl` is a flex column with `gap:10px`. It holds the title (15px, weight 600, navy, nowrap, ellipsis), then `.abx-hb` (flex, `gap:8px`) with History and New.
- Right side: `.ax-shrink`, a 44×44 circle with `background:var(--wash)` and navy colour (CSS:701).

**History and New pills** (CSS:702-704):
- `height:36px; padding:0 14px; border:1px solid var(--border); border-radius:999px; background:#fff; color:var(--navy); font-size:13px; font-weight:400; display:inline-flex; gap:7px; white-space:nowrap`.
- History markup: `<button class="ax-tg" data-tg="rail" aria-pressed>` with the rail icon and "History" (AB:31-33).
- New markup: `<button class="ax-new" data-new>` with the plus icon and "New" (AB:35).
- Pressed History: `background:#eef2fa; border-color:#c9d6ee; color:var(--accent)`.
- I found no distinct hover style. The `.pi-app .ax-tg` specificity beats `button:hover`.

**Thread** `.abx-body` is `flex:1 1 auto; min-height:0`. `.abx-thread` has `overflow-y:auto; padding:8px 36px 16px` (CSS:681-682).

#### 1.5 Closing (shrink)

**Triggers:** the `.ax-shrink` button (AB:589); a click on the veil (AB:560); `Escape` while open, a document-level keydown (AB:561); Find partners (instant, AB:519); arriving on the Ask route (instant, AB:603).

**Sequence in `shrink(instant)`** (AB:435-448):
1. Remove `.open`, the `role`, and `aria-modal`.
2. Remove `veil.on` and `html.ax-lock`.
3. `setWidth()` clears the inline width, so the width animates back to `min(720px, 100vw-32px)`.
4. `autosize()`, then `fitPrompt` after 500 ms.
5. Remove `.show` after 480 ms, or at once when `instant`. Contents fade out over .25 s after a .14 s delay while the height shrinks over .48 s.

`box.rail` is not reset on shrink, so the rail reappears the next time the box opens. The conversation is kept, and `.has-conv` shows the `.ax-up` button.

I found no focus trap and no focus move on open, despite `aria-modal`. Only `startNew()` focuses the textarea (AB:513).

#### 1.6 History "rail" mode

**Toggle** `setToggle("rail", on)` (AB:449-459):
1. Sets `box.rail`, the `.rail` class, `aria-pressed` on every `[data-tg=rail]`, and calls `setWidth()`.
2. When on, it renders `A.railHtml`. If history is not loaded, it calls `GET assistant/history` and re-renders. On error the rail shows `<p class="rl-note">{error message}</p>`.

**Desktop layout** (CSS:683-685): the rail is the first flex child, to the left of the main column. `width:270px; background:var(--wash); border-right:1px solid var(--border); padding:22px 14px 18px; overflow-y:auto`, flex column. The `.rl-top` Back button is hidden on desktop. The box width animates 820 → 1090 px over .42 s.

**Rail animation.** The rail switches from `display:none` to `flex` with `opacity:1` already applied under `.open`. No CSS transition can run from `display:none`, so the rail appears at once while the box widens. I found no `@starting-style`. This is my reading of the CSS, not something I ran.

**List** `A.railHtml(activeId)` (AB:174-190):
- History not yet loaded: `<p class="rl-note"><span class="spinner"></span>Loading…</p>`.
- Empty: "Your questions will be listed here."
- Otherwise, groups by `updatedAt`: "Today" (same `toDateString`), "This week" (under 7×86400000 ms), "Earlier". Empty groups are omitted. Order follows the server, newest first (SRV:2287 keeps 50 conversations per person).
- Group label `.rl-group` (CSS:773-774): 11.5px, uppercase, `letter-spacing:.06em`, `--text-secondary`, `padding:14px 10px 6px`; the first has `padding-top:2px`.
- Row `.rl-row` (CSS:775-782): flex, radius 10px, hover `background:rgba(255,255,255,.7)`.
  - `.rl-item[data-conv]` holds the conversation title: left-aligned, no border, radius 10px, transparent, 13.5px, weight 400, `padding:9px 10px`. Active (`.on`) has a `#fff` background with navy text.
  - `.rl-del[data-del]` holds the bin icon: 32×32, `--text-muted`, `opacity:0`, shown on row hover or focus. `aria-label="Delete this conversation"`.
- Note `.rl-note` (CSS:783): 12px, `--text-secondary`, `padding:10px 10px 0; margin:auto 0 0`, pinned to the bottom. Text: "Only you see these." plus " A copy is kept in Box." when `boxFolder` is true (AB:191-193). `boxFolder` is true when the server has a Database folder set (SRV:3951).

**Delete:** `window.confirm("Delete this conversation from your history?")`, then `POST assistant/delete {id}`. If that conversation is on screen, it is cleared (`box.conv=null`) and re-rendered. On error, `window.alert(err.message)` (AB:578-586). Server 404 text: "That conversation is no longer in your history." (SRV:3964).

**Opening a conversation from the rail:** `openConversation(id)` (AB:497-507):
1. On ≤700px, the rail closes first.
2. `GET assistant/conversation?id=…`, then set `box.conv`, `openBox()`, `render()`, and `scrollToLast()`.
3. On error, `box.error = {q:"", message}`. This renders an empty question bubble with the error under it (AB:406-408). That rendering is a side effect of the code.

#### 1.7 Empty state (open, no conversation) (AB:389-396)

- `div.ax-empty`. Paragraph (CSS:764: `margin:6px 0 14px`, `--text-secondary`): "Ask anything about the partner notes: what members are raising, what has changed, what to put on an agenda, or what one company has said."
- Then `.fus` chips with these exact strings:
  1. "What are the top issues to discuss at the next quarterly meeting?"
  2. "What have members said about hiring this year?"
  3. "Which topics have grown in the last 90 days?"
- On a company page (`#/company/<id>`), "Summarize what we have heard from this company." is prepended.

#### 1.8 Asking (submit flow) (AB:461-495)

**Keyboard:** `Enter` without Shift and not during IME composition submits. `Shift+Enter` inserts a newline (AB:556-558). The form submit does the same (AB:555).

**Client validation:** only empty or whitespace is ignored. The server rejects fewer than 3 characters ("Type a question first.") or more than 1500 characters ("Keep the question under 1,500 characters.") (SRV:4114-4115). The textarea `maxlength` is 1500.

**Flow:**
1. `openBox()`.
2. If there is no conversation, or this is Answer fresh, create `A.newConv(companyId)`: a temporary id `"new-N"`, `temp:true`. The `companyId` is the existing conversation's, or the company in the current hash.
3. Push a pending item `{q, conv, id:"pN"}`.
4. Clear the textarea, render, and scroll to the last turn.

**Request:** `POST /api/partner-intel/assistant` with `{question, mode:"answer", companyId, fresh, conversationId}` (AB:476, 217-230). `conversationId` is `""` for fresh or temporary conversations.
- A follow-up asked before a new conversation's first answer arrives waits for that first request (`conv.first`) so it joins the same conversation.
- Several questions can be in flight at once.
- The Ask box always sends `mode:"answer"`. It never sends `sources` or `exclude`.

**No streaming.** `PI.api` does a plain `fetch` and `r.json()` (PJ:77-89). The server returns one JSON object `{conversation:{id,title,createdAt,updatedAt,turns,companyId}, turn, saved}` (SRV:3256, 2893). The answer appears in one piece.

**On success:**
1. Run `A.settle(thread, pendingId)`, the end-of-loader animation (1.10).
2. Remove the pending item and push `r.turn` into its conversation. If the same conversation was reopened from history as another object, push it there too.
3. `A.remember(r.conversation)` moves it to the top of the cached history.
4. If that conversation is on screen, set `box.sel` and re-render (an instant innerHTML swap with no fade), then `scrollToLast()`.

**On error:** push an error turn `{id:"err-N", q, error}` and render it as `.turn` > `.qb` question plus `div.msg.err` with the message. Default message: "Something went wrong." If the textarea is empty, the question text is put back.

`scrollToLast()` (AB:414-418) sets `thread.scrollTop = lastTurn.offsetTop - 12` instantly, with no smooth scroll.

`box.sel` is assigned but never read in askbox.js. It has no visual effect there.

#### 1.9 Conversation rendering

**Turn** `.turn` (CSS:708): flex column, `gap:14px; margin:0 0 26px`.

**Question bubble** `.qb` (CSS:709-710): `align-self:flex-end; max-width:min(520px,85%); background:var(--wash); border-radius:18px 18px 4px 18px; padding:12px 18px; color:var(--navy); white-space:pre-wrap; overflow-wrap:anywhere`.

**Answer** (AB:131-152):
- `kind==="matches"` uses `A.matchesCompact`. Otherwise `div.ans` contains `A.md(answer, turnId)`.
- `.ans` (CSS:722-728): 15px, `line-height:1.6`, `overflow-wrap:anywhere`. `p` has `margin:0 0 10px`. `ul`/`ol` have `margin:0 0 10px; padding-left:22px`. `li` has `margin:0 0 7px`. `h4` has `margin:16px 0 6px`, 15px, navy. `strong` is navy. `code` is .92em on `--wash`, radius 4px, `padding:0 4px`.

**Markdown subset** `A.md` (AB:47-82). Everything is HTML-escaped first, then these forms are restored:
1. `#`… headings become `<h4>`, with `*`/`#` stripped.
2. `-`, `*`, or `•` lines become `<ul>`.
3. `1.` or `1)` lines become `<ol start=n>`.
4. A continuation line is appended to the last list item.
5. Blank lines end the paragraph or list.
6. `**x**` becomes `<strong>`. `*x*` becomes `<em>` (word-bounded). `` `x` `` becomes `<code>`.
7. `[n]` (1-2 digits) becomes a citation button.

No links are rendered from Markdown.

**Citation** (AB:39-43): `<button class="cite" data-ref=n data-turn=tid aria-label="Source n">n</button>`. CSS (CSS:729-731): `display:inline-block; vertical-align:super; margin:0 1px; padding:2px 5px; border:0; border-radius:6px; background:#eef2fa; color:var(--accent); font-size:10.5px; line-height:1`. Active `.cite.on`: accent background, white text.

**Saved-answer memo** `p.memo` (AB:136-141; CSS:765, 13px, `--text-secondary`):
- `mode==="updated"`: "A saved answer from {Mon D, YYYY}, updated with {n} new note(s)." The plural "s" is dropped when n is 1.
- Otherwise: "A saved answer from {date}. No notes have been added since."
- The date is `PI.fmtDate` of the first 10 characters of `memory.from` (`en-US`, short month, numeric day and year, UTC) (PJ:91-96).

**Sources list** `A.sourcesInline` (AB:103-113). This renders only if there are sources.
- `<details class="srcs">` (closed). Its summary is the down icon plus "1 source" or "N sources".
- `.srcs` (CSS:732-736): `border-top:1px solid #edf0f5; padding-top:10px; font-size:13px`. Summary: weight 600, navy, flex, `gap:6px`, no marker. Chevron 12px, rotated `-90deg` when closed, `transition:transform .2s`.
- Each source is a `<details class="srow" data-ref>` (CSS:737-742). Its summary (flex, `gap:10px`, baseline, `padding:4px 6px`, radius 8px, hover `--wash`) holds:
  1. `.sref` number: min-width 18px, accent colour.
  2. `.sk` kind label: min-width 74px. Colour `#a82b50` for Issue (problem), `#937000` for Solution, `#136c50` for Win, otherwise `--text-secondary`. Labels come from `PI.kindLabel` (PJ:102): problem=Issue, solution=Solution, win=Win, offer=Offer, ask=Ask, equipment=Equipment, news=News, commitment=Commitment.
  3. `.stitle`: flex 1, navy.
  4. `.sby`: `--text-secondary`, nowrap. Text: company name, then " (company uncertain)" if `checkCompany`, then " · {date}" and " (estimated)" if estimated.
- The body `.sbody` (`padding:2px 6px 8px 32px`, 13.5px) holds the detail text plus `.sfoot` (`margin-top:6px`, 13px, secondary). The foot holds "Open {company}", which links to `/partner-intel/#/company/{id}` when the company has an id, then " · " and the Box file links. File links open `target=_blank rel=noopener` (PJ:165-169).
- Source fields used: `ref, kind, title, detail, date, estimated, checkCompany, company{id,name}, files[{name,url}]` (SRV:2783-2789).

**Follow-up chips** (only on the last turn, and only when this conversation has no pending question) (AB:143-150, 403):
- `.fus` (CSS:759): flex wrap, `gap:8px`.
- `.fu` (CSS:760-763): `min-height:34px; padding:6px 14px; border:1px solid var(--border); border-radius:999px; background:#fff; color:var(--accent); font-size:13px; weight 400; text-align:left; inline-flex; gap:6px`. Hover: `border-color:var(--accent)`.
- Chips:
  1. `turn.followUps` (up to 3, `data-q`). These submit the text.
  2. "Answer fresh" (`data-fresh=q`) if `turn.memory`. This submits with `fresh=true`, which starts a new conversation.
  3. "Find partners who can help" + arrow icon (`class="fu go"`, `data-match=q`) when `turn.offerMatch` is true. I found no `.go` style.

**Matches turn (compact, Ask box only)** `A.matchesCompact` (AB:116-128). This applies to `kind:"matches"` turns reopened from history.
- The answer appears as `.ans p`.
- With no matches: "No partner in the notes clearly does this."
- Otherwise `ol.mlist` (`padding-left:22px`; `li` margin 10px). Each item holds the bold company, linked to `#/company/{id}` if it has an id; `.mstr` with "High match", "Medium match", or "Low match" (12.5px secondary); and a `div` with the reason and its citations.
- `p.gaps` (13.5px secondary): "**Not covered:** {gaps}".

**Clicking a citation** `A.showSource` (AB:196-209; handler AB:568-574):
1. Clear every `.cite.on` in the thread, then add `.on` to the matching `turn` and `ref`.
2. Open the turn's `details.srcs` and the `details.srow[data-ref]`.
3. Restart the `.flash` class: `ax-flash 1.4s ease`, keyframes `0%,40% {background:#eef2fa} 100% {background:transparent}` (CSS:747-748).
4. `scrollIntoView({block:"nearest", behavior:"smooth"})`.

**"Find partners who can help"** `toAskPage` (AB:517-521):
1. Set `PI.askPrefill = {question, mode:"match", from:{id,title}}`. `from` is null while the conversation is temporary.
2. `shrink(true)`.
3. `location.hash="#/ask"`.

**New** (`[data-new]`) `startNew()` (AB:510-514): clears the conversation, selection, and error, re-renders (empty state), and focuses the textarea.

#### 1.10 Loading state and its animations

**Pending turn** `A.pendingHtml` (AB:309-315): `div.turn.pending[data-pid]`, the question bubble, then `div.thinking[role=status]` containing:
1. The mark.
2. `span.pi-phrase[aria-hidden]` with "{phrase}…".
3. `span.sr-only` "Reading the notes…".

`.thinking` (CSS:711): flex, center-aligned, `gap:12px`, `--text-secondary`, 15px. `.pending` adds `color:var(--text-muted)`; `.pi-app .pending` sets `font-size:15px` (CSS:205, 480). The `.turn` margin wins over `.pending`'s `margin-top:12px` because it comes later in the file.

**Phrases** (AB:246-278, 31 strings in this order): "Chamfering the edges", "Calibrating the gauges", "Aligning the fixtures", "Deburring the details", "Torquing the bolts", "Tempering the steel", "Milling the notes", "Machining the answer", "Welding the seams", "Polishing the surfaces", "Shimming the gaps", "Squaring the corners", "Tapping the threads", "Forging the links", "Checking the tolerances", "Greasing the bearings", "Tightening the specs", "Zeroing the axes", "Soldering the joints", "Wiring the harness", "Kitting the components", "Staging the pallets", "Routing the shipments", "Sequencing the jobs", "Walking the gemba", "Pulling the kanban", "Asking the five whys", "Mapping the value stream", "Cutting the muda", "Mistake-proofing the process", "Finding the next kaizen".
- Shuffle-bag order (Fisher-Yates). Every phrase shows once before any repeats, and never the same phrase twice running (AB:284-295).
- The phrase changes every `MARK_LAP*4 = 10400 ms` via `setInterval`. The change is applied to every `.pi-mark:not(.settled) + .pi-phrase` on the page. The interval stops when none remain (AB:296-302, 311). The text swaps instantly with no fade.

**Mark** `A.markHtml` (AB:304-308; CSS:715-721):
- `span.pi-mark` is 64×32, `position:relative`.
- It contains an SVG `viewBox="46 -1 361 180.4" width=64 height=32` with a navy fill, drawing the Conexus figure-8 path `MARK_LOOPS` (AB:280; copy it verbatim).
- `span.pm-ride` is the amber diamond: `11.26×11.26px`, `background:var(--amber)`, `offset-path:path("M32.02 15.99 L39.84 7.94 A11.38 11.38 0 1 1 39.84 24.04 L24.19 7.94 A11.38 11.38 0 1 0 24.19 24.04 Z")`, `offset-rotate:0deg; offset-anchor:center; transform:rotate(45deg); animation:pm-ride 2.6s linear infinite`.
- Keyframes `pm-ride`:

| at | offset-distance | scale |
|---|---|---|
| 0% | 0% | 1 |
| 9% | 9% | 0.42 |
| 41% | 41% | 0.42 |
| 50% | 50% | 1 |
| 59% | 59% | 0.42 |
| 91% | 91% | 0.42 |
| 100% | 100% | 1 |

  Every frame keeps `rotate(45deg)`.
- Sync: inline `animation-delay:-{((now - markClock) % 2600)/1000}s` keeps every mark in phase across re-renders.
- `prefers-reduced-motion:reduce` sets `animation:none`.

**Settle (end of loading)** `A.settle` (AB:316-342), run before the answer is inserted:
1. It reads the running animation's progress in laps and computes the next half-lap boundary (the centre crossing).
2. It sets `iterations` to that value with `fill:forwards`.
3. After `(stop - laps) * 2600` ms it adds `.settled`, cancels the ride animation, and plays two WAAPI animations:
   - Swell: `[{transform:"rotate(45deg) scale(1)"}, {transform:"rotate(45deg) scale(1.6)", offset:0.4}, {transform:"rotate(45deg) scale(1)"}]`, 500 ms, `cubic-bezier(.45,0,.25,1)`.
   - Fade on the whole mark: opacity 1→0, 250 ms, delay 420 ms, `ease-in`, `fill:forwards`.
4. The promise resolves when both finish, capped at 1000 ms.
5. It resolves immediately when reduced motion is set or the mark is not on screen.

**After settle:** a full re-render swaps the pending turn for the answer. There is no entry animation on the answer.

#### 1.11 Mobile (≤700px; `narrow()` AB:368, CSS:786-800)

- Collapsed: `bottom:14px; width:calc(100vw - 24px)`.
- Open: `width:calc(100vw - 20px); height:calc(100dvh - 68px)`. The inline width is cleared.
- Head: `padding:10px 8px 4px 16px; gap:4px`. History and New padding: `0 10px`.
- Thread padding: `6px 18px 12px`. Open bar margin: `8px 10px 12px`.
- Rail: `position:absolute; inset:0; z-index:3; width:auto; border:0; background:var(--wash)`, a full-panel overlay. `.rl-top` shows (`display:block; margin-bottom:8px`) with the `.ax-back` button: back icon + "Back", accent colour, 14px, `padding:6px 4px`, `gap:6px` (CSS:705).
- Source rows wrap: `.srow > summary` gets `flex-wrap:wrap; gap:2px 10px`. `.sk` min-width 0. `.stitle` `flex-basis:calc(100% - 120px)`. `.sby` `white-space:normal; width:100%; padding-left:28px`.
- The placeholder shortens to "Ask about the notes" when the long one wraps.

#### 1.12 Endpoints the Ask box uses

All calls go to `/api/partner-intel/` with `Authorization: Bearer {sessionStorage beta-token}` and `content-type: application/json`. A 401 signs the person out. A non-OK response throws `body.error` or "HTTP {status}" (PJ:77-89).

| Call | Request | Response used |
|---|---|---|
| `GET assistant/history` | none | `{conversations:[{id,title,createdAt,updatedAt,turns(count),companyId}], boxFolder:bool}` |
| `GET assistant/conversation?id=` | none | `{conversation:{id,title,turns:[turn…],companyId,…}}` |
| `POST assistant/delete` | `{id}` | `{ok, saved}` |
| `POST assistant` | `{question, mode:"answer", companyId, fresh, conversationId}` | `{conversation, turn, saved}` |

Turn fields: `id, q, at, kind("answer"|"matches"), answer, followUps[≤3], sources[], considered{}, offerMatch, memory{from,newNotes,mode}`. Matches turns add `matches[{strength,why,caution,company,refs}], gaps, ranking, searchTerms, peers` (SRV:2791-2810).

Server-side Ask errors: "Claude is not set up for this tool yet. Ask an admin to add the key." (409, SRV:3182). Data-missing routes go through the `needsData` gate (SRV:3969).

#### 1.13 Relationship to the Ask page (`#/ask`, IX:446-716)

1. The dock is hidden on `#/ask` (1.1). The Ask page reuses the shared `PI.AskUI` pieces in-page: `toggle`, `newButton`, `ICON`, `railHtml`, `railNote`, `answerHtml`, `pendingHtml`, `settle`, `send`, `showSource`, `sourcesInline`, `cites`, `errorHtml`, `history`/`loadHistory`/`remember`/`forget`, `newConv`, `pendingId`, `sameConv`, `resume`.
   - The history cache `A.history` is shared, so the dock and the page show the same list.
   - Because each new conversation id comes from the server, both sides read the same per-person history.
2. Page markup (IX:462-474), in this order: `.asx` > `aside.asx-rail` (with `.rl-head` holding History pressed and New) > `.asx-main`. `.asx-main` holds:
   - `h1.asx-h1` "Search Conexus Notes"
   - `form.asx-pill` with a program `<select>` "All programs" plus the program list from `GET facets`; `textarea#asxQ` (maxlength 1500, placeholder "Search the notes, ask a question, or describe what a partner needs", or "Ask a follow-up" once chatting); `button.asx-go[aria-label=Search]` with the arrow icon
   - `.asx-tools` with History and New, plus `#asxBack`
   - `#asxOut`
   - `#asxRecent`, which shows "Recent" and up to 6 history titles as `.fu` chips before the first question
3. Differences from the dock:
   - The page requires 3 or more characters (IX:554).
   - It sends `sources: [program]` and `exclude`.
   - It sends `mode:"match"` for Find solution or "Find partners who can help". In the dock, that chip navigates to the page.
   - It renders matches with the full `matchesHtml` (IX:682-716), not `matchesCompact`.
   - Autosize max is 160px.
   - It scrolls the window with `scrollTo(top - 96px)`, smooth unless reduced motion.
   - History opens closed every time.
4. Pill motion on the first question: `toChat` (IX:490-508). The pill moves from mid-page to sticky bottom (`bottom:14px`) via a FLIP translateY, `transition:transform .7s cubic-bezier(.22,.8,.24,1)`, cleared after 750 ms. It is skipped under reduced motion.
   - Rail open/close fades with `asx-fade-a`/`asx-fade-b`, opacity 0→1 over .25 s ease (CSS:821-826).
   - At ≤1100px the rail becomes a fixed left drawer `width:min(360px,88vw)`, `z-index:950`, `box-shadow:0 0 40px rgba(7,33,78,.2)` (CSS:878-882).
5. Hand-off back to the dock:
   - When `PI.askPrefill.from` is set, `#asxBack` shows the link "Back to Ask box: {title}" (IX:660-661).
   - Clicking it calls `AU.resume(id)`. Because the person is still on Ask, this stores `A.pendingResume`. It then runs `history.back()` (or goes to `#/home` if there is no history).
   - The dock's `place()` on `hashchange` sees `pendingResume` and calls `openConversation(id)`, so the dock reopens on that conversation (AB:508, 606).
   - Find solution from a note sets `askPrefill {question, mode:"match", exclude, name}` and shows "Looking for partners other than {name}." (IX:662-664, 1088-1094).

---

### 3B. Control panel (`/partner-intel/control-panel/`)

#### 2.1 Page shell

1. `<title>`: "Partner Intelligence control panel", then a space, U+2014, a space, and "Connector" (CP:6).
2. Favicon: a 32×32 navy rounded square with three dots (white, amber, white) (CP:8).
3. `access.js` runs with `data-app="partner-intel" data-need="admin"` (CP:7). The page stays hidden until access is confirmed, and shows "You don't have access" otherwise (public/access.js header).
4. Inline `html{visibility:hidden}` (CP:10) is cleared by the script (CP:193). With no token, `pi.js` redirects to `/admin/login.html?next=…` (PJ:8).
5. The body has **no** `pi-app` class, so only the base styles apply (CSS:10-244): white page, 14px/1.55 Aptos stack, `.wrap` max-width 1080px with `padding:32px 32px 96px` (≤600px: `20px 16px 64px`).
6. Appbar (CP:13-23; CSS:36-50): sticky, navy, `z-index:100`. `.in` max-width 1080, min-height 56, `padding:0 32px`, `gap:0 28px`.
   - `.appname` "Partner Intelligence control panel": 15px, weight 600, white.
   - `.tools` (13px, `#c9d3e3`, hover white): `#whoami` "Signed in as {name or email}" from `GET /api/beta/me` (PJ:180-185); a link "Open the tool" to `/partner-intel/`; a link "Admin hub" to `/admin/`; `button.link` "Sign out".
   - Shadow `.raised` `0 2px 10px rgba(7,33,78,.10)` once scrolled more than 2px, `transition:box-shadow .2s ease` (PJ:16-27).
7. Intro `p.sub` (13.5px secondary, `margin:0 0 24px`): "Point the tool at the Box notes, run scans, and keep the partner list current."
8. Each section is a `.card` (CSS:56-58): no box, `border-top:1px solid var(--border)`, `padding:24px 0`, `margin:0 0 8px`.
   - `h2` is 20px, weight 600, navy. `h3` is 16px. `.desc` is 13.5px secondary with `margin:4px 0 16px`.
   - The first child of `.wrap` is the `<p>`, so every card keeps its top rule.

**Shared controls** (CSS:62-81, 148-167):
- Buttons: 13.5px, weight 600, radius 4px, `1px solid #c9cdd8`, `padding:7px 14px`, white, navy text; hover `--wash`.
- `.primary`: `#325eae` background and border, white text; hover navy.
- `.danger`: text `#b3401f`, border `rgba(242,107,67,.5)`.
- `.tiny`: `padding:3px 9px; font-size:12px`. `:disabled`: `opacity:.5; not-allowed`.
- `button.link`: no chrome, accent colour, underline on hover.
- Inputs: `1px solid #c9cdd8`, radius 4px, `padding:8px 10px`; focus `outline:2px solid rgba(50,94,174,.35)` with accent border.
- `label.field`: 12.5px secondary.
- `.fields`: grid `repeat(auto-fit,minmax(170px,1fr))`, `gap:14px`.
- `.row`: flex wrap, `gap:10px`, center-aligned.
- Tables: full width, collapsed borders. `th` is 11.5px, uppercase, `.04em`, secondary, weight 600, `padding:10px 12px`, bottom border `#c9cdd8`. `td` is `padding:12px`, bottom border `#e1e2e9`, top-aligned, 13.5px. At ≤760px tables become `display:block; overflow-x:auto`.
- `.msg`: 12.5px, `margin:8px 0 0`. `.err` is `#b3401f`. `.ok` is `#0b6a92`.
- `.msg.warn` is used (CP:399, 591) but has **no CSS rule**, so it renders as a plain `.msg`.
- `.pill` is plain text, 12.5px, weight 500, secondary. When it follows another element it gets a "·" `::before` (`margin:0 8px 0 4px`, muted). `.good` is `#0b6a92` 600, `.medium` `#8a5200` 600, `.high` `#b3401f` 600, `.est` `#8a5200` italic. `.info` is used (CP:450) but has no rule, so it renders in the default secondary colour.
- `.stat`: inline-block, `margin-right:22px`. `b` is 24px, weight 600, navy, block. `span` is 12.5px secondary.
- `.banner`: `border:1px solid rgba(251,174,64,.6); background:rgba(251,174,64,.12)`, radius 4px, `padding:12px 16px`, `margin-bottom:20px`, 13.5px.
- `.spinner`: 14px ring, `2px solid var(--border)`, top `#325eae`, `spin .8s linear infinite` (rotate 360deg), `margin-right:6px`.
- `.empty`: `padding:28px 10px`, centred, muted.

**Animations:** the spinner (above), the appbar shadow transition, and smooth `scrollIntoView` calls (CP:326, 467). I found no other animations on this page.

**Helpers:**
- `msg(id, text, kind)` sets the class `msg [kind]` and the text (CP:198).
- `num()` formats with `toLocaleString`, and non-numbers show "0" (CP:219).
- `PI.fmtStamp` gives `en-US` "Mon D, h:mm AM" (PJ:97-100).

#### 2.2 Sections in DOM order

##### (a) Re-link banner `#relink` (CP:27-30)
- Hidden unless `status.relinkNeeded`.
- Text: "**The partner list changed since the data was last built.** Re-link applies the change to every note. It reads nothing new and uses no Claude."
- Button `.primary` "Re-link now" → `POST run {mode:"rebuild"}`. Messages: "Starting…", then ok "Started. Refresh in a minute.", or the error. Then `pollRuns(true)` (CP:411-415).
- The banner stays visible until status reloads.

##### (b) One-time update card `#oneoff` (CP:32-36, 235-240, 372-379)
- Hidden unless `status.oneTimeUpdate` exists. The inline `border-color:rgba(251,174,64,.7)` tints the top rule amber.
- `h2` and `p.desc` come from `upd.title` and `upd.body`.
- `.primary` "Apply the update": disables, shows "Starting…", then `POST update/apply {id}`.
  - Success: the card hides, `#runMsg` shows ok "The update started. It takes about a minute. This page refreshes when it finishes.", then `pollRuns(true)`.
  - Error: the button re-enables and the error shows in `#oneoffMsg`.

##### (c) One-time refresh `#refreshCard` (CP:38-46, 380-410)
- Same amber top rule. Hidden only when `status.refresh.state === "done"`. A missing value is treated as `{state:"new"}`, which shows the card.
- `h2` "One-time refresh". `.desc` (CP:40-43): "Brings everything read under older rules up to date, once. It cuts the onboarding notes into one entry per meeting, works out estimated dates again with the current rules (file times, folder names), treats the recording and the clean write-up of one call as one meeting, and reads again only the sections read under older instructions. Text that has not changed is never paid for twice. Step 1 shows what it will do and reads nothing."
- `#refreshBody` by state:
  - `planning`: "Checking. This page updates when it finishes." Button disabled.
  - `running`: "The refresh is running. It reads in a batch at half price, which can take up to an hour. This page updates when it finishes." Button disabled.
  - `planned` with a plan: "**What the refresh will do** (checked {stamp}):" followed by a list:
    1. "{files} file(s) taken up: {reason n, …}"
    2. "{sections_to_read} section(s) read by Claude, about {words_to_read} words ({reason n, …})"
    3. "{files_redated} file(s) get a new date"
    4. "{meetings} meeting(s) in the onboarding notes", only if `running_documents`
  - `r.error` appends `div.msg.warn`.
- Button label: "Check what it will do" (step `plan`) or "Run the refresh" (step `run`, when planned).
- The run step asks `confirm("Run the one-time refresh? Claude reads only the sections listed. It cannot be run a second time.")`.
- Click: disables, "Starting…", then `POST refresh {step}`, then renders `res.refresh` and `pollRuns(true)`. On error the button re-enables and the message shows.

##### (d) Status (CP:48-51, 220-251)
- Initial content: spinner + "Loading…".
- From `GET status`: a row (`gap:6px; margin-bottom:12px`) of three pills, each `.good` when true and `.medium` when false:
  1. "Box connected" / "Box not connected"
  2. "Scans can start" / "GitHub token missing"
  3. "Claude key set (Ask)" / "Claude key not set (Ask uses keywords)"
- Then stats: `{dataset.insightCount}` "insights"; `{fmtStamp(dataset.generated_at)}` "data last built". If there is no dataset: muted "No data yet. Choose the folder and run a trial scan." Then `{roster.Active}` "current members" and `{roster.total}` "partners listed".
- `loadStatus` also fills: relink visibility, the schedule, `settings`, the one-off card, the refresh card, the folder table, `#syncLast`, the report, usage, contacts, and `#rosterSummary`.
- `status.toCheck` is returned by the server (SRV:3668) but not used by the page.
- If the first load fails: `#status` shows `div.msg.err` with the message (CP:706).

##### (e) "1. Box folders" (CP:53-66, 301-346)
- `.desc`: "Three folders, each chosen here. Notes are read from one, the database is written to another, and the member list is read from a third. They can be the same folder or different ones."
- The text says three, but the table has **five** rows. This mismatch is in the source.
- Table columns: **Folder | What it is for | Chosen | (blank)**. Rows in fixed order (CP:302-308):
  1. **Meeting notes** (`notes`; folderId/folderName): "Read. Every subfolder is read too. Word, text, VTT, SRT, HTML and PDFs with a text layer are used; images, audio and spreadsheets are ignored."
  2. **Database** (`data`; dataFolderId/dataFolderName): "Written after every scan: partner_intel_database.json, partner_intel_insights.csv (opens in Excel) and partner_intel_state.json. The state file lets the tool restore itself without reading the notes again. partner_intel_results_archive.json keeps every Claude result ever paid for, so none is paid for twice."
  3. **Member list** (`roster`): "Read. Put the member list here as a .csv or .xlsx. The newest file is used, and it is re-read at the start of every scan."
  4. **Contact list** (`contacts`): "Written when a contact list is uploaded below: the file as uploaded, and partner_intel_contacts.json, the list as read. If the app loses its copy it reads this one back."
  5. **Cache** (`cache`): "Written as the tool works, so nothing Claude wrote is paid for twice: partner_intel_results_archive.json and partner_intel_state.json (what the scan has read), partner_intel_summaries.json (trending summaries), and Saved answers with partner_intel_saved_answers.json (Ask answers reused for similar questions). Until one is chosen, these go to the Database folder."
- "Chosen" column: bold folder name (or "folder {id}"), or muted "Not chosen". The last column has a "Choose" button.
- **Picker** `#picker`, initially hidden, `margin-top:14px`:
  - `h3#pickTitle` "Choose the {label lowercased} folder".
  - `#crumbs` (small, muted): `button.link` crumbs joined by " / ". A crumb with no name shows "All Files".
  - `#folders`: one `button.link` per subfolder (server sorts by name), or "No subfolders." in muted small text.
  - Row: `.primary` "Use this folder", "Cancel", and `#folderMsg`.
  - Opening starts at Box root `id "0"` and smooth-scrolls the picker into view (`block:"nearest"`).
  - Browsing calls `GET box/folders?id=` → `{id,name,breadcrumb[{id,name}],folders[{id,name}]}` and shows "Loading…" meanwhile. Errors appear in `#folderMsg`.
  - Validation: still at root shows err "Open the folder first."
  - Save: `POST settings {which, folderId, folderName}`, then ok "Saved.", hide the picker, and `loadStatus()`.
  - Server errors: "Choose a Box folder.", "Unknown folder setting.", "Box is not connected yet." (409), "Box API error (a/b)" (SRV:3687-3723).
  - Cancel hides the picker.

##### (f) "2. Scan" (CP:68-86, 200-211, 348-370, 417-430)
- `.desc`: "A scan also runs by itself once a day, at the time below. It lists the folder, skips every file Box says has not changed, and calls Claude only for text it has never read, so a day with no new notes uses none. Every Claude result is saved and reused."
- Schedule row (`align-items:flex-end; gap:12px; margin-bottom:14px`):
  1. Label "Daily scan (Eastern time)" + `input[type=time]#schedTime` with `step=300` (5 min) and default `07:00`.
  2. Checkbox `#schedOn` "Run every day", checked by default.
  3. Button "Save time".
- `#schedMsg` text:
  - Enabled: "Next scan {sc.next} at {h:mm AM/PM} Eastern."
  - Disabled: "The daily scan is off. Scan now still works."
  - Then either " The last automatic start failed: {lastError}" (err class) or " Last started automatically {stamp}."
- Save time:
  1. Validate `/^\d\d:\d\d$/`, else err "Choose a time."
  2. Disable the button, then `POST schedule {time, enabled}` → schedule view.
  3. On success: re-enable and show ok "Saved. " + the schedule line. On error: re-enable and show the error. Server error: "Choose a time, such as 07:00."
- Run buttons:
  1. "Trial run (first 5 files)" → `POST run {mode:"scan", limit:5}`, label "Trial run"
  2. `.primary` "Scan now" → `{mode:"scan"}`, label "Scan"
  3. "Re-read every file" (title "Re-reads every file. Text already read is served from the saved results.") → `confirm("Re-read every file? Text that was already read is reused, so this is cheap unless the files changed.")` → `{mode:"scan", force:true}`, label "Full re-read"
  4. "Re-link only" (title "Applies the current partner list to the saved results. No Box, no Claude.") → `{mode:"rebuild"}`, label "Re-link"
- Hint (small, muted): "Start with the trial run. It reads five files so the first cost is small and you can check the results before the full scan."
- `#runMsg`: "Starting…", then ok "{label} started. It takes a few minutes. This page updates when it finishes.", or the error. The buttons are not disabled while starting.
- Server errors: "GITHUB_TOKEN and GITHUB_REPO are not set on the Worker." (500); "Choose the Box folder first." (400) (SRV:3725-3736).
- Runs table `#runs` (`margin-top:12px`), from `GET run-status` → `{runs:[{status,conclusion,created_at,event,url}]}`:
  - Columns: **Started | Trigger | State**.
  - Rows follow server order. The client does no sorting.
  - Started is `fmtStamp(created_at)`.
  - Trigger is "Daily" if `event==="schedule"`, else "Manual".
  - State: completed+success shows `.good` "Finished". Completed otherwise shows `.high` with `{conclusion}` or "Failed". Queued shows `.medium` "Queued". Anything else shows "Running".
  - A " log" link (new tab) appears if the url starts with `https://`.
  - No runs: empty. Polling errors are swallowed.
- **Polling** `pollRuns(fast)` (CP:418-430):
  - It schedules another poll in **12000 ms** while any run is not completed, or once when `fast`.
  - When runs go from active to all done, it reloads status, review, checks, and topics. It does not reload the roster.
  - The initial call is `pollRuns(false)` after the first load.

##### (g) "Last scan" (CP:88-91, 272-299)
- Default: small muted "No scan has run yet."
- From `status.report`: if `r.error`, only `div.msg.err`. Otherwise:
  1. "{stamp} · {mode}", plus " · trial of {n} files" when it was a trial.
  2. A stat row (`margin:8px 0`): files_seen "files seen", files_to_read "files read", files_unchanged "unchanged", units_to_read "sections to read", claude_calls "Claude calls", units_cached "reused from saved results", insights "insights", rows_rejected "rows dropped (quote not in notes)", sections_split "sections read in pieces", not_on_roster "names to review".
  3. Optional lines:
     - "Saved to Box: a, b"
     - `box_note` as `msg err`
     - "The saved state was restored from the Box database folder."
     - "Member list: {error|skipped|applied {file.name}} {warning}"
     - "Tokens used: {in} in, {out} out (… {batch} of {calls} calls through the half-price batch)."
     - "{n} section(s) came back from the Box results archive at no cost."
     - `batch_note`
     - "Ignored (not notes): k n, …"
  4. Collapsible `<details>` lists, each "**{Title} ({count})**", each item a string or "{file}: {error}": Errors, Could not save to Box, Need converting to .docx, Unreadable, PDFs with no text (scans), Too large.

##### (h) "Claude use" (CP:93-97, 253-270)
- `.desc`: "Tokens Claude read and wrote, by what they were for. Reading notes goes through the batch, which costs half. "Reused" counts answers served from saved results instead of a new call."
- Default: "Nothing used yet."
- Shows two tables: `h3` "This month ({month})" and "Last month ({month})" (margin-top 12px).
- Columns: **Use | Calls | Tokens in | Tokens out | Reused**.
- Rows, in this fixed order and only where present:
  1. extractionBatch "Reading notes (batch, half price)"
  2. extraction "Reading notes (direct)"
  3. summaries "Trending topic summaries"
  4. ask "Ask: partner search"
  5. assistant "Ask: answers (Ask box and Ask page)"
- No rows: "Nothing used."
- There is **no dollar cost and no meter or bar**, only token counts.

##### (i) "3. Partner list" (CP:99-149, 432-547)
- `.desc`: "Industry, member status and contacts come from here, and it is how a company named in the notes is recognized. Update it whenever partners join or leave: upload a fresh Salesforce export, or edit one partner below. Nobody is deleted by an upload. A partner missing from a full list is marked Not Council and keeps their history."
- `#rosterSummary`: "{Active} members · {Inactive} former · {Non-member} not members".

**Load from Box** (`h3` "Load from the member list folder in Box"):
- Note: "Reads the newest .csv or .xlsx in the member list folder (section 1). A scan also does this by itself first, so partners who join or leave are picked up every morning."
- `select#syncMode`: `replace` "The file is the full current list" / `merge` "Only add and update the partners in the file".
- "Preview changes" → spinner + "Reading the file…" → `POST roster/sync {preview:true, mode}`.
  - `r.skipped` shows a plain msg.
  - Otherwise: an optional warning `.banner`, then "{file.name} · {modified stamp}", then the summary, then `.primary` "Apply these changes" → `POST roster/sync {mode}` → ok "Applied." + summary, and reloads roster, status, and review.
  - Errors show inline. `#syncLast`: "Last applied: {name}, {stamp} ({added} added, {reactivated} returning, {deactivated} marked Former). {warning}".

**Upload by hand** (`h3` "Or upload a file by hand"):
- `input[type=file]` accepts `.csv,text/csv`.
- `select#csvMode`: "This file is the full current list" / "Only add and update the partners in this file".
- "Preview changes" is disabled until the file is read.
- The file is decoded as UTF-8 (fatal) with a fallback to windows-1252 (CP:508-511).
- Preview: "Checking…" → `POST roster/import {csv, mode, preview:true}` → summary + "Apply these changes" → `POST roster/import {csv, mode}` → "Applied." + summary. This clears the file and disables Preview again.

**Summary format** (CP:520-528): "**a** new · **u** changed · **r** returning · **d** no longer on the list · n unchanged", then `<details>`:
- "New partners"
- "Returning partners"
- "**Will be marked Not Council**", which is `open` by default
- "Changed"

Each list shows at most 40 names, then "and N more".

**Add/edit form** (`h3#formTitle` "Add a partner" or "Edit {name}"):
- Fields:
  - Name
  - Industry (datalist of existing industries, sorted)
  - Status select: Active "Council Member"; Inactive "Not Council (former member)"; Non-member "Not Council (never a member)"
  - "Contacts (one per line)" textarea, 3 rows
  - "Other names the notes use (one per line)" textarea, 3 rows. **This is the only alias control on the page.**
- Buttons: `.primary` "Add partner" (or "Save changes" when editing), "Cancel edit" (hidden unless editing), `.danger` "Delete" (hidden unless editing).
- Save: `POST roster/partner {id, name, industry, status, contacts[], aliases[]}`. Lines are trimmed and blanks dropped. On success: ok "Saved.", the form resets, and roster and status reload. There is no client-side validation.
- Delete: `confirm("Delete this partner? Marking them Not Council instead keeps their history attached.")` → `POST roster/partner/delete {id}`.
- Clicking Edit smooth-scrolls the name field to the centre.

**Roster table:**
- Filter input "Search partners" (min-width 220px) and select: "" "All statuses", Active "Council Member", "not" "Not Council".
- Columns: **Partner | Industry | Status | Contacts | (Edit)**.
- **Default sort: name A to Z** (`localeCompare`). The filter is a case-insensitive substring match on the name.
- Status is a pill: good when Active, `info` otherwise. Labels come from `PI.statusLabel` (Active → "Council Member", else "Not Council").
- Contacts are joined with ", " in small text. The last column has a `.tiny` "Edit" button.
- Empty: "No partners." spanning 5 columns. The table sits in `overflow-x:auto` with `margin-top:10px`.

##### (j) "4. Contacts at partner companies" (CP:151-160, 549-597)
- `.desc`: "The people at partner companies, from a Salesforce export (.xlsx or .csv with First Name, Last Name, Title, Account Name and Email). The scan uses it to tell who is speaking and which company they work for, so "Ben" in a call with Evonik is Ben Larson of Evonik. It does not need to be complete. Each upload replaces the last one. After saving, press Re-link (no Claude cost)."
- `#contactsNow`: "Current list: **{fileName}**, {stamp}" + summary, or muted "No contact list uploaded yet. The scan uses the primary and secondary contacts on the partner list only."
- Summary: "**kept** contacts at **companies** companies · {n} of your partners have at least one ({m} have none)". Then a muted line joining the non-zero items with " · ":
  - "{n} names repaired from the email address (Excel had damaged them)"
  - "duplicate rows skipped"
  - "rows with no usable name skipped"
  - "rows with no company skipped"
  - "names appear at two companies; those are only used when the notes show which"
- Then `<details>` "{n} contacts at companies not on the partner list", listing "name (count)".
- The file input accepts `.xlsx,.csv` and the xlsx/csv MIME types. The file is read as base64 in 32 KB chunks.
- "Preview": "Reading…" → `POST contacts/import {preview:true, fileName, data}` → summary + `.primary` "Save this contact list" → `POST contacts/import {fileName, data}`.
  - Success: ok "Saved" + ", with a copy in Box" (if `r.box.box`) + ". Press Re-link to apply it to the data.", plus `msg warn` with `r.box.note`. It resets the input and reloads status.

##### (k) "5. Statements to check {(total)}" (CP:162-166, 599-648)
- `.desc`: "Statements where it is uncertain which company said them: the speaker works for a different partner than the one credited, the file is named for another partner, or two contacts share the speaker's name. Pick the right company, or keep the current one. A decision applies at once and clears the Check company marker."
- Loading: "Loading…". Data comes from `GET attribution/review?offset=N` → `{items, total, offset}`.
- The count in the heading is "(total)" in small muted text.
- Each item uses `.item` (no box, bottom border, `padding:18px 0`):
  - `.title` (15px, 600, navy)
  - `.detail`
  - A small muted line: "{date} · {speaker} · {programs}"
  - Source details `PI.sourceHtml`: "Source: {first file} +n", the quote in a blockquote, and "From {links}"
  - A row (`margin-top:8px; gap:6px`) with:
    - `.tiny` "Keep {company name | 'no company'}"
    - a `.tiny` button per option "{name} (why)" with title=why
    - a select "Another partner…" listing all partners A to Z
    - `.tiny` "Use it"
- Decisions: `POST attribution/decide {id, keep:true}` or `{id, companyId}`, then reload checks and status. Errors use `alert()`.
- Paging: 25 per page. "Previous" and "Next 25" buttons. If a later page empties, the page goes back.
- Empty: "Nothing to check." On an error matching /no data/i: "No data yet." Otherwise `msg err`.

##### (l) "6. Names to review" (CP:168-172, 650-678)
- `.desc`: "Company names that appear in the notes but could not be matched to the partner list with confidence. Match one to a partner, or add it as a non-member. Changes apply after Re-link."
- `GET review` → `items[{raw,count,candidates[{id,name}],pending}]`.
- Table columns: **Name in the notes | Times | Match to a partner | (action)**. Rows follow server order.
  - Name cell: bold raw name, plus a pill `.est` "applies on Re-link" when pending.
  - Times: the count.
  - Match cell: `.tiny` "Same as {name}" per candidate, then a row with a select "Choose a partner…" (partners A to Z) and `.tiny` "Match".
  - Last cell: `.tiny` "Add as non-member".
- Calls: `POST review/map {raw, companyId}` and `POST review/add {raw}`, then reload roster, status, and review. These calls have **no error handler**.
- Empty: "Nothing to review." Load error: "Review opens after the first scan."

##### (m) "7. Conexus staff" (CP:174-179, 544-547)
- `.desc`: "People who work for Conexus, one per line. What they say in a conversation is not counted as a partner's issue or solution."
- Textarea: 4 rows, max-width 420px, filled from `roster.staff`.
- "Save staff" → `POST roster/staff {names: lines}` (lines are split, not trimmed, on the client) → ok "Saved. Applies after Re-link." and reloads status.

##### (n) "8. Topics" (CP:181-185, 680-702)
- `.desc`: "Every note is filed under one topic, and the shared-issues ranking counts companies per topic. Rename a topic, or merge two that mean the same thing."
- `GET topics` → `topics[{id,label,override{label,mergeInto}}]`. The `id "other"` topic is excluded.
- Table columns: **Topic | Shown as | Merge into | (Save)**. Rows follow server order.
  - "Shown as": an input whose value is the override label and whose placeholder is the topic label.
  - "Merge into": a select with "Keep separate" plus every non-other topic. The list includes the topic itself. It is preset to `override.mergeInto`.
  - `.tiny` "Save" → `POST topics/override {id, label, mergeInto}`. The button text becomes "Saved" for **1500 ms**. Errors use `alert()`.
- Load error: "Topics appear after the first scan."

#### 2.3 Load order (CP:705-706)

1. `Promise.all([loadRoster() (GET roster), loadStatus() (GET status)])`.
2. Then `loadReview()`, `loadChecks()`, `loadTopics()`, `pollRuns(false)`.
3. On failure, the error replaces `#status`.

#### 2.4 Requested items that are not on this page

The control panel has **no** controls for:
- meeting dates
- removing meetings
- a standalone alias editor (aliases are set only through the partner form's "Other names the notes use"; the Worker has a `roster/alias` route at SRV:3868, but this page does not call it)
- dollar cost meters (token counts only)
- a progress bar (run state is a text pill)

#### 2.5 All control-panel endpoints

Prefix `/api/partner-intel/`:

| Method | Endpoint |
|---|---|
| GET | `status` |
| GET | `roster` |
| GET | `box/folders?id=` |
| GET | `run-status` |
| GET | `attribution/review?offset=` |
| GET | `review` |
| GET | `topics` |
| POST | `settings` |
| POST | `schedule` |
| POST | `run` |
| POST | `update/apply` |
| POST | `refresh` |
| POST | `roster/sync` |
| POST | `roster/import` |
| POST | `roster/partner` |
| POST | `roster/partner/delete` |
| POST | `roster/staff` |
| POST | `contacts/import` |
| POST | `attribution/decide` |
| POST | `review/map` |
| POST | `review/add` |
| POST | `topics/override` |

Outside the prefix: `GET /api/beta/me` for whoami.

No pull request was opened. This was a read-only task and I made no file changes.
