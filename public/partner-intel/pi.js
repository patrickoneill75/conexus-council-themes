/* Shared helpers for Partner Intelligence pages: sign-in, API calls, escaping, small renderers. */
(function () {
  "use strict";
  var PI = {};
  var token = null;
  try { token = sessionStorage.getItem("beta-token"); } catch (e) {}
  // Staff only, always. Not driven by the app-visibility setting: this holds members' candid words.
  if (!token) { window.location.replace("/admin/login.html"); return; }
  window.PI = PI; // pages check for it, so none of them runs without a session
  PI.token = token;

  PI.esc = function (s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  PI.signOut = function () {
    try { sessionStorage.removeItem("beta-token"); } catch (e) {}
    window.location.href = "/admin/login.html";
  };

  PI.api = function (path, options) {
    options = options || {};
    options.headers = Object.assign({ "content-type": "application/json", authorization: "Bearer " + token },
      options.headers || {});
    return fetch("/api/partner-intel/" + path, options).then(function (r) {
      if (r.status === 401) { PI.signOut(); throw new Error("Not signed in"); }
      return r.json().then(function (body) {
        if (!r.ok) { var err = new Error(body.error || ("HTTP " + r.status)); err.status = r.status; err.body = body; throw err; }
        return body;
      });
    });
  };
  PI.post = function (path, body) { return PI.api(path, { method: "POST", body: JSON.stringify(body || {}) }); };

  PI.fmtDate = function (iso) {
    if (!iso) return "No date";
    var d = new Date(iso + "T12:00:00Z");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  };
  PI.fmtStamp = function (iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  PI.kindLabel = { problem: "Problem", solution: "Solution", win: "Win", offer: "Offer", ask: "Ask",
    equipment: "Equipment", news: "News", commitment: "Commitment" };
  PI.statusLabel = { Active: "Member", Inactive: "Former member", "Non-member": "Not a member", Unknown: "Unknown" };

  PI.pill = function (cls, text) { return '<span class="pill ' + cls + '">' + PI.esc(text) + "</span>"; };

  /** One insight as a card. opts: { company: true|false, why: true|false } */
  PI.insightCard = function (i, opts) {
    opts = opts || {};
    var co = i.company || {};
    var head = "";
    if (opts.company !== false) {
      head += co.id ? '<a class="co" href="/partner-intel/#/company/' + encodeURIComponent(co.id) + '">' + PI.esc(co.name) + "</a>"
                    : '<span class="co">' + PI.esc(co.name) + "</span>";
      head += PI.pill("info", co.industry || "Unknown");
      head += PI.pill(co.status === "Active" ? "good" : "info", PI.statusLabel[co.status] || co.status || "Unknown");
      // The notes' file is named for a different partner. Often right (a supplier mentioned in
      // the call), sometimes a misreading, so it is shown for a person to check.
      if ((i.review || []).indexOf("company_differs_from_file") >= 0) {
        head += '<span class="pill medium" title="The source file is named for a different partner. Check which company said this.">Check company</span>';
      }
    }
    var urgentProblem = i.kind === "problem" && i.urgency !== "none";
    if (!urgentProblem) head += PI.pill("info", PI.kindLabel[i.kind] || i.kind);
    if (urgentProblem) head += PI.pill(i.urgency, i.urgency === "high" ? "High urgency" : i.urgency === "medium" ? "Medium urgency" : "Low urgency");
    if (i.status === "resolved") head += PI.pill("good", "Resolved");
    var meta = PI.esc(PI.fmtDate(i.date)) + (i.estimated ? " " + PI.pill("est", "estimated date") : "") +
      (i.eventType ? " &middot; " + PI.esc(i.eventType) : "") +
      (i.speaker ? " &middot; " + PI.esc(i.speaker) : "");
    var srcNames = (i.sources || []).map(function (s) { return PI.esc(s.name); }).join(", ");
    return '<div class="item' + (i.kind === "problem" && (i.urgency === "high" || i.urgency === "medium") ? " u-" + i.urgency : "") + '">' +
      '<div class="head">' + head + "</div>" +
      '<div class="title">' + PI.esc(i.title) + "</div>" +
      '<div class="detail">' + PI.esc(i.detail) + "</div>" +
      (i.urgencyReason && opts.why !== false ? '<div class="why"><b>Why it is urgent:</b> ' + PI.esc(i.urgencyReason) + "</div>" : "") +
      (i.solves ? '<div class="why"><b>Addresses:</b> ' + PI.esc(i.solves) + "</div>" : "") +
      (i.tags && i.tags.length ? '<div class="chips">' + i.tags.map(function (t) { return '<span class="chip">' + PI.esc(t) + "</span>"; }).join("") + "</div>" : "") +
      '<div class="meta">' + meta + "</div>" +
      '<details class="src"><summary>Source</summary><blockquote>&ldquo;' + PI.esc(i.quote) + "&rdquo;</blockquote>" +
      '<div class="meta">' + srcNames + "</div></details></div>";
  };

  PI.whoami = function (target) {
    fetch("/api/beta/me", { headers: { authorization: "Bearer " + token } })
      .then(function (r) { if (!r.ok) throw new Error("no"); return r.json(); })
      .then(function (me) { if (target) target.textContent = "Signed in as " + (me.username || me.email); })
      .catch(PI.signOut);
  };
})();
