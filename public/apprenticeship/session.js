/**
 * The respondent's own sign-in state, shared by every page an employer sees in the
 * Apprenticeship Readiness Toolbox.
 *
 * The token lives in localStorage, not sessionStorage. Conexus staff sign in for one
 * sitting, which is what sessionStorage is for; an employer works through three
 * assessments over days and comes back for the dashboard afterwards, and being signed out
 * by closing a tab would defeat the point of having accounts at all. The cost is the
 * usual one: a token in localStorage is readable by any script that gets onto the page.
 * It carries an account id and nothing else, and it is only good against this one app's
 * respondent routes -- it is not a Conexus admin session and cannot become one (see
 * src/apprenticeship_accounts.js).
 *
 * This is deliberately separate from the "beta-token" key the control panels use. The two
 * never mix: a page reads one or the other, never both.
 */
(function () {
  "use strict";
  var KEY = "apprenticeship-token";

  function read() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function write(token) {
    try { window.localStorage.setItem(KEY, token); } catch (e) { /* private mode -- the
      session simply won't survive a reload, which is better than failing to sign in */ }
  }
  function clear() {
    try { window.localStorage.removeItem(KEY); } catch (e) {}
  }

  function signInUrl(next) {
    return "/apprenticeship/account.html?next=" + encodeURIComponent(
      next || (window.location.pathname + window.location.search));
  }

  window.ApprenticeshipSession = {
    token: read,
    setToken: write,
    clear: clear,
    signInUrl: signInUrl,

    /** Send the browser to sign in, remembering where it was going. */
    requireSignIn: function (next) {
      window.location.replace(signInUrl(next));
    },

    /**
     * Call the app's API as the signed-in respondent. A 401 means the token has expired
     * or been cleared server-side, so it drops it and sends them to sign in rather than
     * leaving a page showing an error it cannot recover from.
     */
    api: function (path, options) {
      options = options || {};
      var token = read();
      options.headers = Object.assign(
        { "content-type": "application/json" },
        token ? { authorization: "Bearer " + token } : {},
        options.headers || {});
      return fetch("/api/apprenticeship/" + path, options).then(function (r) {
        if (r.status === 401) {
          clear();
          window.location.replace(signInUrl());
          throw new Error("Not signed in");
        }
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body.error || ("HTTP " + r.status));
          return body;
        });
      });
    },
  };
})();
