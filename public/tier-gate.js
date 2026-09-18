/**
 * Include via <script src="/tier-gate.js" data-app="<id>"></script>, early in <head>,
 * on any mini app's public base page (council-data, mcm, ...). Checks that app's
 * current visibility tier from GET /api/beta/app-visibility (see src/beta_auth.js):
 * "public"/"hidden" reveal the page immediately with no check; "admin-only" requires
 * an existing beta session, redirecting to /admin/login.html if there isn't one --
 * the same check every admin-only page in this app already does, just driven by a
 * runtime setting instead of being hardcoded into the page.
 *
 * Pair this with `html { visibility: hidden; }` in the page's own CSS (this script
 * sets it back to visible once the check resolves) so an admin-only page never flashes
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
    if (!token) { window.location.replace("/admin/login.html"); return; }
    reveal();
  }).catch(reveal);
})();
