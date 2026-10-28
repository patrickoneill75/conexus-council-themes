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

  // The link bar floats at the top; a faint shadow shows once the page has scrolled under it. On a phone
  // its top row (the name and account links) rides up out of view at the rate the page scrolls, and the
  // page links stay. pi.css eases each step, so the row trails the scroll slightly and settles.
  var phone = window.matchMedia ? window.matchMedia("(max-width:600px)") : null;
  function raiseBar() {
    var bar = document.querySelector(".appbar");
    if (!bar) return;
    var y = window.scrollY || document.documentElement.scrollTop;
    bar.classList.toggle("raised", y > 2);
    var nav = bar.querySelector(".nav");
    var row = phone && phone.matches && nav ? nav.offsetTop : 0;
    var lift = Math.min(row, Math.max(0, Math.round(y)));
    bar.style.setProperty("--lift", lift + "px");
    bar.style.setProperty("--fade", row ? String(1 - lift / row) : "1");
    bar.classList.toggle("lifted", !!row && lift >= row);
  }
  window.addEventListener("scroll", raiseBar, { passive: true });
  window.addEventListener("resize", raiseBar);
  document.addEventListener("DOMContentLoaded", raiseBar);

  /* Liquid glass edge. Chrome and Edge can run an SVG filter on what sits behind an element: this one
   * bends the backdrop near the element's rim and leaves the middle clear. Other browsers keep the plain
   * blur in pi.css. One filter per id, rebuilt when the element's size changes. */
  if (navigator.userAgentData) document.documentElement.classList.add("lg-refract");
  PI.ASK_GLASS = { freq: "0.011 0.045", octaves: 2, seed: 7, scale: 28, rim: 22, rimY: 13, soft: 8 };
  PI.LENS_GLASS = { freq: "0.04 0.09", octaves: 1, seed: 4, scale: 12, rim: 12, rimY: 8, soft: 5 };
  PI.glassFilter = function (id, w, h, o) {
    w = Math.round(w); h = Math.round(h);
    if (!w || !h || !document.body) return;
    var NS = "http://www.w3.org/2000/svg", f = document.getElementById(id);
    if (f && f.getAttribute("width") === String(w) && f.getAttribute("height") === String(h)) return;
    var host = document.getElementById("pi-glass-defs");
    if (!host) {
      host = document.createElementNS(NS, "svg");
      host.id = "pi-glass-defs";
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
      document.body.appendChild(host);
    }
    if (f) f.parentNode.removeChild(f);
    f = document.createElementNS(NS, "filter");
    function set(node, attrs) { Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); }); return node; }
    function add(parent, tag, attrs) { return parent.appendChild(set(document.createElementNS(NS, tag), attrs)); }
    set(f, { id: id, x: 0, y: 0, width: w, height: h, filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });
    add(f, "feTurbulence", { type: "fractalNoise", baseFrequency: o.freq, numOctaves: o.octaves, seed: o.seed, result: "noise" });
    add(f, "feDisplacementMap", { in: "SourceGraphic", in2: "noise", scale: o.scale, xChannelSelector: "R", yChannelSelector: "G", result: "warped" });
    add(f, "feFlood", { x: o.rim, y: o.rimY, width: Math.max(0, w - 2 * o.rim), height: Math.max(0, h - 2 * o.rimY), "flood-color": "#fff", result: "inner" });
    add(f, "feGaussianBlur", { in: "inner", x: 0, y: 0, width: w, height: h, stdDeviation: o.soft, result: "innerSoft" });
    add(f, "feComposite", { in: "SourceGraphic", in2: "innerSoft", operator: "in", result: "middle" });
    add(f, "feComposite", { in: "warped", in2: "innerSoft", operator: "out", result: "rim" });
    var merge = add(f, "feMerge", {});
    add(merge, "feMergeNode", { in: "middle" });
    add(merge, "feMergeNode", { in: "rim" });
    host.appendChild(f);
  };

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
    }
    // Which company said this is in doubt (the speaker works elsewhere, the file is named for another
    // partner, or two people share the speaker's name). Listed on the control panel. Shown on a company's
    // own page too, where the company is not named on the card: that is where it would pass as fact.
    if (i.checkCompany) {
      by.push('<span class="pill medium" title="Which company said this is uncertain. Staff can settle it on the control panel, under Statements to check.">Check company</span>');
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
      .then(function (me) { if (target) target.textContent = "Signed in as " + (me.name || me.email); })
      .catch(PI.signOut);
  };
})();
