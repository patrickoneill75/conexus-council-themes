/* Salary Allocation's arithmetic, shared by the staff page and the tests: the split of a month's worked
 * hours across projects, how hours read as days, the month the page opens on, and a possible schedule.
 * No page access here, so tests/worker_test.mjs runs this file as it ships. */
(function (root) {
  "use strict";
  var C = {};
  var HALF = 4, DAY = 8;

  /** Whole hours per project from percents. Each share is rounded down, then the hours left over go to the
   * shares with the largest remainders (ties to the earlier project), so the hours add up to the hours
   * worked: round(total) when the percents make 100, else round(total x their sum / 100). */
  C.split = function (total, pcts) {
    var raw = pcts.map(function (p) { return total * p / 100; });
    var out = raw.map(function (r) { return Math.floor(r + 1e-9); });
    var target = Math.round(raw.reduce(function (s, r) { return s + r; }, 0));
    var left = target - out.reduce(function (s, x) { return s + x; }, 0);
    raw.map(function (r, i) { return { i: i, f: r - out[i] }; })
      .sort(function (a, b) { return b.f - a.f || a.i - b.i; })
      .forEach(function (x) { if (left > 0) { out[x.i]++; left--; } });
    return out;
  };

  function count(n, one, many) { return n + " " + (n === 1 ? one : many); }

  /** Hours as full days, a half day and hours: 14 is "1 day, 1 half day, 2 hours"; 16 is "2 days". */
  C.inDays = function (h) {
    if (!(h > 0)) return "None";
    var days = Math.floor(h / DAY), rest = h - days * DAY, half = rest >= HALF ? 1 : 0, hours = rest - half * HALF;
    var parts = [];
    if (days) parts.push(count(days, "day", "days"));
    if (half) parts.push("1 half day");
    if (hours) parts.push(count(hours, "hour", "hours"));
    return parts.join(", ");
  };

  /** Hours as days and hours, for the month's total: 176 is "22 days", 172 is "21 days 4 hours". */
  C.daysAndHours = function (h) {
    var days = Math.floor(h / DAY), hours = h - days * DAY;
    return [days ? count(days, "day", "days") : "", hours ? count(hours, "hour", "hours") : ""].filter(Boolean).join(" ") || "0 hours";
  };

  /** "YYYY-MM" a month on or back. */
  C.addMonths = function (month, by) {
    var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - 1 + by;
    var d = new Date(Date.UTC(y, m, 1));
    return d.toISOString().slice(0, 7);
  };

  /** The month the page opens on. People enter time at the end of a month or the start of the next, so
   * through the 15th it is last month, after that this month. */
  C.defaultMonth = function (today) {
    var month = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");
    return today.getDate() <= 15 ? C.addMonths(month, -1) : month;
  };

  /** The weekdays of a month, as day numbers. */
  C.weekdays = function (month) {
    var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - 1, out = [];
    for (var d = 1; d <= new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); d++) {
      var w = new Date(Date.UTC(y, m, d)).getUTCDay();
      if (w > 0 && w < 6) out.push(d);
    }
    return out;
  };

  /**
   * A possible schedule: which projects to record on which days. days is [{ day, worked }] in date order;
   * hours is each project's hours, adding up to the hours worked. Each worked day is cut into half days
   * of 4 hours (a shorter day, or what is left of one, is one smaller slot). Each project gets as many
   * whole half days as its hours allow, placed at evenly spaced points through the month; the hours under
   * a half day then share the slots left, each kept whole where it fits, on a day that project is not
   * already on where there is one. Returns { <day>: [{ i, h }] },
   * i being the project's index in hours.
   */
  C.schedule = function (days, hours) {
    var slots = [];
    days.forEach(function (d) {
      var h = d.worked;
      while (h > 0) { var size = Math.min(HALF, h); slots.push({ day: d.day, size: size, parts: [] }); h -= size; }
    });
    var full = slots.filter(function (s) { return s.size === HALF; });
    var chunks = hours.map(function (h) { return Math.floor(h / HALF); });
    var total = function () { return chunks.reduce(function (s, x) { return s + x; }, 0); };
    while (total() > full.length) chunks[chunks.indexOf(Math.max.apply(null, chunks))]--;
    var items = [];
    chunks.forEach(function (k, i) { for (var j = 0; j < k; j++) items.push({ i: i, at: (j + 0.5) / k }); });
    items.sort(function (a, b) { return a.at - b.at || hours[b.i] - hours[a.i] || a.i - b.i; });
    var used = [];
    items.forEach(function (it, n) {
      var s = full[Math.floor((n + 0.5) * full.length / items.length)];
      used.push(s); s.parts.push({ i: it.i, h: HALF });
    });
    var open = slots.filter(function (s) { return used.indexOf(s) < 0; }).map(function (s) { return { s: s, room: s.size }; });
    hours.map(function (h, i) { return { i: i, h: h - chunks[i] * HALF }; })
      .filter(function (x) { return x.h > 0; })
      .sort(function (a, b) { return b.h - a.h || a.i - b.i; })
      .forEach(function (x) {
        var rest = x.h;
        // A slot that fits it whole, on a day the project is not already on, so it stays spread out.
        var fits = open.filter(function (o) { return o.room >= rest; });
        var away = function (o) { return !slots.some(function (s) { return s.day === o.s.day && s.parts.some(function (p) { return p.i === x.i; }); }); };
        var fit = fits.filter(away)[0] || fits[0];
        if (fit && !away(fit) && fit.room === HALF) {
          // Every slot that fits is on one of its days: trade this empty half day for another project's
          // half day on a day this one is not on, nearest first, so both stay spread.
          var at = slots.indexOf(fit.s);
          var trade = full.filter(function (s) {
            var j = s.parts.length === 1 && s.parts[0].h === HALF ? s.parts[0].i : -1;
            return j >= 0 && j !== x.i && away({ s: s }) && !slots.some(function (t) { return t.day === fit.s.day && t.parts.some(function (p) { return p.i === j; }); });
          }).sort(function (a, b) { return Math.abs(slots.indexOf(a) - at) - Math.abs(slots.indexOf(b) - at); })[0];
          if (trade) { fit.s.parts = trade.parts; trade.parts = []; fit.s = trade; }
        }
        if (fit) { fit.s.parts.push({ i: x.i, h: rest }); fit.room -= rest; return; }
        open.forEach(function (o) {
          if (rest > 0 && o.room > 0) { var t = Math.min(o.room, rest); o.s.parts.push({ i: x.i, h: t }); o.room -= t; rest -= t; }
        });
      });
    var out = {};
    slots.forEach(function (s) {
      var list = out[s.day] || (out[s.day] = []);
      s.parts.forEach(function (p) {
        var have = list.filter(function (x) { return x.i === p.i; })[0];
        if (have) have.h += p.h; else list.push({ i: p.i, h: p.h });
      });
    });
    Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return a.i - b.i; }); });
    return out;
  };

  root.SACalc = C;
})(typeof window !== "undefined" ? window : globalThis);
