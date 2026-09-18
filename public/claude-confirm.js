/**
 * Shared "this will spend Claude API budget" confirmation modal -- loaded by every
 * control panel page that has a button whose click ultimately triggers a real
 * Anthropic Claude API call, either directly in the Worker or by dispatching a
 * GitHub Actions workflow that runs a Claude-calling pipeline. One shared
 * implementation so the warning looks and behaves identically across every mini
 * app, and so any future change to it (wording, an added cost estimate) only has
 * to happen in this one file.
 *
 * Usage:
 *   var ok = await confirmClaudeSpend("This will process 3 pending meeting(s).");
 *   if (!ok) return; // admin cancelled -- skip the action entirely
 *
 * The optional `detail` argument is appended as a second line, plain text (never
 * HTML) -- use it to say roughly how much work this click triggers ("one call per
 * pending meeting", "3 SEC filings", etc.) when that's known up front.
 *
 * Every control-panel page already defines the same --surface-1/--text-primary/
 * --text-secondary/--border/--warn CSS variables (see any control panel's <style>
 * block) -- this modal reuses them by name instead of carrying its own palette, so
 * it's automatically themed correctly (light/dark) wherever it's loaded, with no
 * per-app setup beyond adding the <script> tag.
 */
(function () {
  "use strict";
  if (window.confirmClaudeSpend) return; // already loaded on this page

  var styleInjected = false;
  function ensureStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var style = document.createElement("style");
    style.textContent =
      ".cc-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;" +
        "align-items:center;justify-content:center;z-index:9999;padding:20px;}" +
      ".cc-modal{background:var(--surface-1,#fff);color:var(--text-primary,#0b0b0b);" +
        "border:1px solid var(--border,rgba(0,0,0,.1));border-radius:12px;max-width:420px;" +
        "width:100%;padding:22px;font:14px/1.5 system-ui,-apple-system,\"Segoe UI\",sans-serif;" +
        "box-shadow:0 10px 40px rgba(0,0,0,.3);}" +
      ".cc-title{display:flex;align-items:center;gap:8px;font-size:15.5px;font-weight:650;margin:0 0 10px;}" +
      ".cc-title .cc-icon{font-size:17px;line-height:1;}" +
      ".cc-body{font-size:13.5px;color:var(--text-secondary,#52514e);margin:0 0 18px;}" +
      ".cc-detail{display:block;margin-top:8px;color:var(--text-primary,#0b0b0b);font-weight:600;}" +
      ".cc-actions{display:flex;justify-content:flex-end;gap:10px;}" +
      ".cc-actions button{font:inherit;border-radius:8px;border:1px solid var(--border,rgba(0,0,0,.1));" +
        "cursor:pointer;padding:8px 15px;background:var(--surface-1,#fff);color:var(--text-primary,#0b0b0b);}" +
      ".cc-actions button.cc-proceed{background:var(--warn,#fab219);border-color:var(--warn,#fab219);" +
        "color:#1a1400;font-weight:650;}";
    document.head.appendChild(style);
  }

  window.confirmClaudeSpend = function (detail) {
    ensureStyle();
    return new Promise(function (resolve) {
      var backdrop = document.createElement("div");
      backdrop.className = "cc-backdrop";
      backdrop.innerHTML =
        '<div class="cc-modal" role="alertdialog" aria-modal="true" aria-labelledby="ccTitle">' +
          '<h3 class="cc-title" id="ccTitle"><span class="cc-icon">⚠️</span>Claude API call</h3>' +
          '<p class="cc-body">Warning: this action will result in a Claude API call, spending money ' +
            'from the API Token Budget. Would you like to proceed?' +
            (detail ? '<span class="cc-detail"></span>' : "") +
          "</p>" +
          '<div class="cc-actions">' +
            '<button type="button" class="cc-cancel">Cancel</button>' +
            '<button type="button" class="cc-proceed">Proceed</button>' +
          "</div>" +
        "</div>";
      if (detail) backdrop.querySelector(".cc-detail").textContent = detail;
      document.body.appendChild(backdrop);

      function done(result) {
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
        resolve(result);
      }
      function onKey(event) {
        if (event.key === "Escape") done(false);
      }
      backdrop.addEventListener("click", function (event) { if (event.target === backdrop) done(false); });
      backdrop.querySelector(".cc-cancel").addEventListener("click", function () { done(false); });
      backdrop.querySelector(".cc-proceed").addEventListener("click", function () { done(true); });
      document.addEventListener("keydown", onKey);
      // Cancel is the default focus target -- an accidental Enter keypress
      // (e.g. from a lingering focus elsewhere) should never confirm a spend.
      backdrop.querySelector(".cc-cancel").focus();
    });
  };
})();
