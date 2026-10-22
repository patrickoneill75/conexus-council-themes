/**
 * Include via <script src="/tier-gate.js" data-app="<id>"></script>, early in <head>,
 * on any mini app's public base page (council-data, mcm, ...). Checks that app's
 * current visibility tier from GET /api/beta/app-visibility (see src/beta_auth.js):
 * "public"/"hidden" reveal the page immediately with no check; "admin-only" (shown in
 * Settings as "Staff with access") requires a session with use access to this app:
 * no session redirects to /admin/login.html, and a signed-in person without access
 * sees a plain "You don't have access to this app" message instead of the page. That
 * second check is public/access.js, loaded here only when the tier calls for it.
 *
 * Pair this with `html { visibility: hidden; }` in the page's own CSS (this script
 * sets it back to visible once the check resolves) so a staff-only page never flashes
 * its real content before the redirect fires. On a network error this fails OPEN
 * (reveals the page) rather than stranding it blank forever -- an acceptable tradeoff
 * for a low-stakes internal tool.
 */
(function () {
  "use strict";
  var thisScript = document.currentScript;
  var appId = thisScript && thisScript.getAttribute("data-app");

  function reveal() {
    document.documentElement.style.visibility = "visible";
  }

  if (!appId) { reveal(); return; }

  fetch("/api/beta/app-visibility").then(function (r) { return r.json(); }).then(function (body) {
    var tier = (body.visibility || {})[appId];
    if (tier !== "admin-only") { reveal(); return; }
    var token = null;
    try { token = sessionStorage.getItem("beta-token"); } catch (e) {}
    if (!token) { window.location.replace("/admin/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash)); return; }
    // Signed in: public/access.js asks whether this person may use the app, then reveals the page
    // or shows the no-access message.
    var gate = document.createElement("script");
    gate.src = "/access.js";
    gate.setAttribute("data-app", appId);
    gate.setAttribute("data-need", "use");
    gate.onerror = reveal;
    document.head.appendChild(gate);
  }).catch(reveal);
})();
