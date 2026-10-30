/* Shared helpers for Salary Allocation pages: sign-in, API calls, escaping and month names. */
(function () {
  "use strict";
  var token = null;
  try { token = sessionStorage.getItem("beta-token"); } catch (e) {}
  // Staff only: the same sign-in as Partner Intelligence.
  if (!token) { window.location.replace("/admin/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash)); return; }
  var SA = window.SA = {};

  SA.esc = function (s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  SA.signOut = function () {
    try { sessionStorage.removeItem("beta-token"); } catch (e) {}
    window.location.href = "/admin/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
  };
  /** A call to /api/salary-allocation/<path>. Resolves with the JSON body; rejects with its error. */
  SA.api = function (path, options) {
    options = options || {};
    var headers = Object.assign({ authorization: "Bearer " + token }, options.headers || {});
    if (options.json !== undefined) { headers["content-type"] = "application/json"; options.body = JSON.stringify(options.json); }
    return fetch("/api/salary-allocation/" + path, { method: options.method || (options.body ? "POST" : "GET"), headers: headers, body: options.body })
      .then(function (res) {
        if (res.status === 401) { SA.signOut(); throw new Error("Sign in again."); }
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) { var err = new Error(body.error || "Something went wrong (" + res.status + ")."); err.status = res.status; err.body = body; throw err; }
          return body;
        });
      });
  };
  SA.post = function (path, body) { return SA.api(path, { json: body }); };

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  /** "2026-10" as "October 2026". */
  SA.monthName = function (month) { return MONTHS[Number(month.slice(5, 7)) - 1] + " " + month.slice(0, 4); };
  SA.monthOnly = function (month) { return MONTHS[Number(month.slice(5, 7)) - 1]; };
  /** "2026-11-26" as "Thu, Nov 26". */
  SA.shortDate = function (iso) {
    var p = iso.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };
  SA.thisMonth = function () { var t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0"); };
  SA.r2 = function (n) { return Math.round(n * 100) / 100; };
})();
