/**
 * The page-side access check every staff page and control panel shares. Include it early in <head>:
 *
 *   <script src="/access.js" data-app="<id>" data-need="admin"></script>   a control panel
 *   <script src="/access.js" data-app="<id>" data-need="use"></script>     a staff page of that app
 *   <script src="/access.js" data-need="overall"></script>                 overall admins only (Settings)
 *
 * No session: straight to sign-in, as every page here already does. Signed in: asks GET /api/beta/me
 * (role, apps, appAdmin -- see src/beta_auth.js) and either shows the page or replaces it with a plain
 * "You don't have access" message. The page stays hidden until the answer comes back, so it never
 * flashes. It also hides links to a control panel or Settings this person cannot open.
 *
 * This is for the person's sake, not the security boundary: every API route checks the same access
 * itself and refuses with 403. So a network error here shows the page rather than stranding it blank.
 * public/tier-gate.js loads this script for an app whose visibility tier is "admin-only".
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var appId = (script && script.getAttribute("data-app")) || "";
  var need = (script && script.getAttribute("data-need")) || "use";
  var root = document.documentElement;

  function canUse(me, id) {
    return Boolean(me) && (me.role === "admin" || (me.apps || []).indexOf(id) >= 0);
  }
  function canAdmin(me, id) {
    return Boolean(me) && (me.role === "admin" || (me.appAdmin || []).indexOf(id) >= 0);
  }
  window.ConnectorAccess = { canUse: canUse, canAdmin: canAdmin };

  function toLogin() {
    try { sessionStorage.removeItem("beta-token"); } catch (e) {}
    window.location.replace("/admin/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash));
  }
  var token = null;
  try { token = sessionStorage.getItem("beta-token"); } catch (e) {}
  if (!token) { toLogin(); return; }

  var style = document.createElement("style");
  style.textContent =
    "html.access-pending body{visibility:hidden!important}" +
    "html.access-denied body>*:not(.access-msg){display:none!important}" +
    "html.access-denied body{margin:0;background:#F3F5F9}" +
    "div.access-msg{box-sizing:border-box;max-width:560px;margin:12vh auto 0;padding:32px 32px 28px;background:#fff;" +
    "border:1px solid #E1E2E9;border-radius:8px;font:15px/1.55 Aptos,'Segoe UI',Arial,sans-serif;color:#16202B}" +
    "div.access-msg h1{margin:0 0 8px;font-size:22px;line-height:1.3;font-weight:600;color:#07214E}" +
    "div.access-msg p{margin:0 0 20px;color:#4A5663}" +
    "div.access-msg .acts{display:flex;flex-wrap:wrap;gap:16px;align-items:center}" +
    "div.access-msg a{color:#325EAE;font-weight:600;text-decoration:none}" +
    "div.access-msg a:hover{text-decoration:underline}" +
    "div.access-msg button{font:inherit;font-weight:600;color:#325EAE;background:none;border:0;padding:0;cursor:pointer}" +
    "@media (max-width:640px){div.access-msg{margin:32px 16px 0;padding:24px 20px}}";
  (document.head || root).appendChild(style);
  root.classList.add("access-pending");

  function whenBody(fn) {
    if (document.body) fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  function reveal() {
    root.classList.remove("access-pending");
    root.style.visibility = "visible";
  }
  function deny(title, text) {
    whenBody(function () {
      var box = document.createElement("div");
      box.className = "access-msg";
      box.setAttribute("role", "alert");
      var h = document.createElement("h1");
      h.textContent = title;
      var p = document.createElement("p");
      p.textContent = text;
      var acts = document.createElement("div");
      acts.className = "acts";
      var back = document.createElement("a");
      back.href = "/admin/index.html";
      back.textContent = "Back to Connector";
      var out = document.createElement("button");
      out.type = "button";
      out.textContent = "Sign out";
      out.addEventListener("click", toLogin);
      acts.appendChild(back);
      acts.appendChild(out);
      box.appendChild(h);
      box.appendChild(p);
      box.appendChild(acts);
      document.body.appendChild(box);
      root.classList.add("access-denied");
      document.title = title + " — Connector";
      reveal();
    });
  }
  /* Links this person cannot follow: another app's control panel they don't admin, and Settings. */
  function hideLinks(me) {
    var links = document.querySelectorAll('a[href*="/control-panel"], a[href^="/admin/settings"]');
    Array.prototype.forEach.call(links, function (a) {
      var href = a.getAttribute("href") || "";
      var open = href.indexOf("/admin/settings") === 0 ? me.role === "admin"
        : !appId || need !== "use" || canAdmin(me, appId);
      // An inline style, because a page's own CSS (a.btn { display:inline-flex }) beats the hidden attribute.
      if (!open) a.style.display = "none";
    });
  }

  fetch("/api/beta/me", { headers: { authorization: "Bearer " + token } })
    .then(function (r) {
      if (r.status === 401) { toLogin(); return null; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (me) {
      if (!me) return;
      if (need === "overall" ? me.role !== "admin" : need === "admin" ? !canAdmin(me, appId) : !canUse(me, appId)) {
        if (need === "overall") deny("You don't have access to Settings", "Only an admin can open Settings.");
        else if (need === "admin") deny("You don't have access to this app's settings", "Ask an admin.");
        else deny("You don't have access to this app", "Ask an admin to give you access.");
        return;
      }
      whenBody(function () { hideLinks(me); reveal(); });
    })
    .catch(function () { whenBody(reveal); });
})();
