/* Shared helpers for Partner Intelligence pages: sign-in, API calls, escaping, small renderers. */
(function () {
  "use strict";
  var PI = {};
  var token = null;
  try { token = sessionStorage.getItem("beta-token"); } catch (e) {}
  // Staff only, always. Not driven by the app-visibility setting: this holds members' candid words.
  if (!token) { window.location.replace("/admin/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash)); return; }
  window.PI = PI; // pages check for it, so none of them runs without a session
  PI.token = token;

  PI.esc = function (s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  PI.signOut = function () {
    try { sessionStorage.removeItem("beta-token"); } catch (e) {}
    window.location.href = "/admin/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
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

  PI.kindLabel = { problem: "Issue", solution: "Solution", win: "Win", offer: "Offer", ask: "Ask",
    equipment: "Equipment", news: "News", commitment: "Commitment" };
  // A company is either a council member or not; former members, non-members and companies not on the
  // roster all read "Not Council".
  PI.statusLabel = { Active: "Council Member", Inactive: "Not Council", "Non-member": "Not Council", Unknown: "Not Council" };
  PI.memberLabel = function (status) { return status === "Active" ? "Council Member" : "Not Council"; };
  // The filter value for "Not Council": every status other than Active.
  PI.NOT_COUNCIL = "Inactive|Non-member|Unknown";

  PI.pill = function (cls, text) { return '<span class="pill ' + cls + '">' + PI.esc(text) + "</span>"; };

  // The three kinds that get a label on a note, each in its own color.
  var KIND_TONE = { problem: "k-issue", solution: "k-solution", win: "k-win" };

  /** Which company tab a kind belongs to: issues, solutions, wins, or other. */
  PI.categoryOf = function (kind) {
    return kind === "problem" || kind === "ask" ? "issues" : kind === "win" ? "wins"
      : kind === "solution" || kind === "offer" || kind === "equipment" ? "solutions" : "other";
  };

  /** One note, read top to bottom: what kind it is, its title, who said it (company, industry and member
   * status, unless opts.company is false), the note itself, then Source, closed until clicked, holding the
   * date, the meeting type, the speaker, the files in Box and the quote. opts.action (Find solution) sits
   * under Source, where it stays in reach. */
  PI.insightCard = function (i, opts) {
    opts = opts || {};
    var co = i.company || {};
    var by = [];
    if (opts.company !== false && co.name) {
      by.push(co.id ? '<a class="co" href="/partner-intel/#/company/' + encodeURIComponent(co.id) + '">' + PI.esc(co.name) + "</a>"
                    : '<span class="co">' + PI.esc(co.name) + "</span>");
      if (co.industry && co.industry !== "Unknown") by.push("<span>" + PI.esc(co.industry) + "</span>");
      if (co.id) by.push("<span>" + PI.esc(PI.memberLabel(co.status)) + "</span>");
      // Which company said this is in doubt (the speaker works elsewhere, the file is named for
      // another partner, or two people share the speaker's name). Listed on the control panel.
      if (i.checkCompany) {
        by.push('<span class="pill medium" title="Which company said this is uncertain. Staff can settle it on the control panel, under Statements to check.">Check company</span>');
      }
    }
    if (i.status === "resolved") by.push("<span>Resolved</span>");
    var src = ["<span>" + PI.esc(PI.fmtDate(i.date)) + "</span>"];
    if (i.estimated) src.push(PI.pill("est", "estimated date"));
    if (i.eventType) src.push("<span>" + PI.esc(i.eventType) + "</span>");
    if (i.speaker) src.push("<span>" + PI.esc(i.speaker) + "</span>");
    var files = PI.fileLinks(i.sources);
    if (files) src.push('<span class="files" title="' + PI.esc((i.sources || []).map(function (f) { return f.name; }).join(", ")) + '">' + files + "</span>");
    return '<div class="item">' +
      // Only Issue, Solution and Win get a label, and not where the page already says which it is.
      (opts.kind !== false && KIND_TONE[i.kind] ? '<span class="kindl ' + KIND_TONE[i.kind] + '">' + PI.esc(PI.kindLabel[i.kind]) + "</span>" : "") +
      '<div class="title">' + PI.esc(i.title) + "</div>" +
      (by.length ? '<div class="by">' + by.join("") + "</div>" : "") +
      '<div class="detail">' + PI.esc(i.detail) + "</div>" +
      (i.solves ? '<div class="why"><b>Addresses:</b> ' + PI.esc(i.solves) + "</div>" : "") +
      '<details class="src"><summary>Source</summary><div class="srcm">' + src.join("") + "</div>" +
      (i.quote ? "<blockquote>&ldquo;" + PI.esc(i.quote) + "&rdquo;</blockquote>" : "") + "</details>" +
      (opts.action ? '<div class="acts">' + opts.action + "</div>" : "") +
      "</div>";
  };

  /** A link to each source file in Box, or the plain name when there is no Box id. */
  PI.fileLinks = function (files) {
    return (files || []).map(function (f) {
      return f.url ? '<a href="' + PI.esc(f.url) + '" target="_blank" rel="noopener">' + PI.esc(f.name) + "</a>" : PI.esc(f.name);
    }).join(", ");
  };

  /** The quote and the file it came from. Every quote shown anywhere names and links its file. */
  PI.sourceHtml = function (i) {
    var files = PI.fileLinks(i.sources);
    return '<details class="src"><summary>Source' + (i.sources && i.sources.length ? ": " + PI.esc(i.sources[0].name) +
      (i.sources.length > 1 ? " +" + (i.sources.length - 1) : "") : "") + "</summary>" +
      (i.quote ? "<blockquote>&ldquo;" + PI.esc(i.quote) + "&rdquo;</blockquote>" : "") +
      (files ? '<div class="meta">From ' + files + "</div>" : "") + "</details>";
  };

  PI.whoami = function (target) {
    fetch("/api/beta/me", { headers: { authorization: "Bearer " + token } })
      .then(function (r) { if (!r.ok) throw new Error("no"); return r.json(); })
      .then(function (me) { if (target) target.textContent = "Signed in as " + (me.username || me.email); })
      .catch(PI.signOut);
  };
})();
