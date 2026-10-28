/* The Ask box: a pill that floats at the bottom of every Partner Intelligence page except Ask. A
   question opens it upward into a conversation about the notes as a whole, with the page blurred
   behind it. History (the person's past conversations) is a button, off until pressed; New starts
   again. Also the pieces the Ask page shares with it: the answer, its sources (listed under it,
   closed until opened) and the history list. */
(function () {
  "use strict";
  var PI = window.PI;
  if (!PI) return;
  var esc = PI.esc;
  var A = PI.AskUI = {};
  var KIND_TONE = { problem: "k-issue", solution: "k-solution", win: "k-win" };

  var svg = function (body, size, vb, width) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="' + (vb || "0 0 16 16") + '" fill="none" stroke="currentColor" stroke-width="' +
      (width || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  };
  var ICON = A.ICON = {
    clock: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/>', 20, "0 0 24 24", 1.8),
    up: svg('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>', 18),
    arrow: svg('<path d="M2 8h11M9 3.5 13.5 8 9 12.5"/>', 18),
    down: svg('<path d="M3.5 6 8 10.5 12.5 6"/>', 18),
    open: svg('<path d="M3.5 10 8 5.5 12.5 10"/>', 18),
    plus: svg('<path d="M8 3v10M3 8h10"/>', 14),
    back: svg('<path d="M14 8H3M7 3.5 2.5 8 7 12.5"/>', 16, null, 2.2),
    rail: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 2.5v11"/>', 15, null, 1.6),
    bin: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>', 15, null, 1.6),
  };

  /** The History button, which shows or hides the list of past conversations. */
  A.toggle = function (on) {
    return '<button type="button" class="ax-tg" data-tg="rail" aria-pressed="' + (on ? "true" : "false") + '">' + ICON.rail + "History</button>";
  };
  /** The New button, which starts a new conversation. */
  A.newButton = function () { return '<button type="button" class="ax-new" data-new>' + ICON.plus + "New</button>"; };

  // Numbers from a stored answer are made numbers before they go into HTML.
  function num(n) { n = parseInt(n, 10); return isFinite(n) && n >= 0 ? n : 0; }
  function cite(n, tid) {
    n = num(n);
    return '<button type="button" class="cite" data-ref="' + n + '" data-turn="' + esc(tid) + '" aria-label="Source ' + n + '">' + n + "</button>";
  }
  A.cites = function (refs, tid) { return (refs || []).map(function (n) { return " " + cite(n, tid); }).join(""); };

  /** The model's Markdown, made safe: everything is escaped first, then a small set of forms is
   * turned back on (headings, lists, bold, italics). [3] becomes a citation for turn tid. */
  A.md = function (src, tid) {
    var inline = function (s) {
      return esc(s)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\[(\d{1,2})\]/g, function (m, n) { return cite(n, tid); });
    };
    var out = [], para = [], list = null;
    var flushPara = function () { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
    var flushList = function () {
      if (!list) return;
      out.push("<" + list.tag + (list.start > 1 ? ' start="' + list.start + '"' : "") + ">" +
        list.items.map(function (i) { return "<li>" + inline(i) + "</li>"; }).join("") + "</" + list.tag + ">");
      list = null;
    };
    String(src || "").split(/\r?\n/).forEach(function (line) {
      var t = line.trim(), m;
      if (!t) { flushPara(); flushList(); return; }
      if ((m = t.match(/^#{1,6}\s+(.*)$/))) { flushPara(); flushList(); out.push("<h4>" + inline(m[1].replace(/[*#]+/g, "")) + "</h4>"); return; }
      if ((m = t.match(/^[-*•]\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
        list.items.push(m[1]); return;
      }
      if ((m = t.match(/^(\d{1,2})[.)]\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [], start: Number(m[1]) }; }
        list.items.push(m[2]); return;
      }
      if (list) { list.items[list.items.length - 1] += " " + t; return; }
      para.push(t);
    });
    flushPara(); flushList();
    return out.join("");
  };

  function kindHtml(k) {
    return '<span class="sk' + (KIND_TONE[k] ? " " + KIND_TONE[k] : "") + '">' + esc(PI.kindLabel[k] || k || "") + "</span>";
  }
  function companyLine(c) {
    if (!c || !c.name) return "";
    return esc(c.name) + (c.id ? " · " + esc(PI.memberLabel(c.status)) : "");
  }
  function sourceFoot(s) {
    var bits = [];
    if (s.company && s.company.id) {
      bits.push('<a href="/partner-intel/#/company/' + encodeURIComponent(s.company.id) + '">Open ' + esc(s.company.name) + "</a>");
    }
    var files = PI.fileLinks(s.files);
    if (files) bits.push(files);
    return bits.length ? '<div class="sfoot">' + bits.join(" · ") + "</div>" : "";
  }

  /** The notes an answer cites, listed under it, closed until opened (or until a citation is clicked):
   * a line each, opened for the note itself. */
  A.sourcesInline = function (turn) {
    var list = turn.sources || [];
    if (!list.length) return "";
    return '<details class="srcs"><summary>' + ICON.down + list.length + (list.length === 1 ? " source" : " sources") + "</summary>" +
      list.map(function (s) {
        return '<details class="srow" data-ref="' + num(s.ref) + '"><summary><span class="sref">' + num(s.ref) + "</span>" + kindHtml(s.kind) +
          '<span class="stitle">' + esc(s.title) + '</span><span class="sby">' + esc((s.company && s.company.name) || "") +
          (s.checkCompany ? " (company uncertain)" : "") + (s.date ? " · " + esc(PI.fmtDate(s.date)) + (s.estimated ? " (estimated)" : "") : "") + "</span></summary>" +
          '<div class="sbody">' + esc(s.detail) + sourceFoot(s) + "</div></details>";
      }).join("") + "</details>";
  };

  /** A partner search kept in history, shown briefly: who matched, why, and the notes behind it. */
  A.matchesCompact = function (turn) {
    var strength = { high: "High match", medium: "Medium match", low: "Low match" };
    var html = turn.answer ? '<div class="ans"><p>' + esc(turn.answer) + "</p></div>" : "";
    if (!turn.matches.length) html += '<div class="ans"><p>No partner in the notes clearly does this.</p></div>';
    else {
      html += '<ol class="mlist">' + turn.matches.map(function (m) {
        return "<li><b>" + (m.company.id ? '<a href="/partner-intel/#/company/' + encodeURIComponent(m.company.id) + '">' + esc(m.company.name) + "</a>"
          : esc(m.company.name)) + '</b> <span class="mstr">' + esc(strength[m.strength] || "") + "</span><div>" + esc(m.why) + A.cites(m.refs, turn.id) + "</div></li>";
      }).join("") + "</ol>";
    }
    if (turn.gaps) html += '<p class="gaps"><b>Not covered:</b> ' + esc(turn.gaps) + "</p>";
    return html;
  };

  /** One turn's answer. opts.last adds what to ask next; opts.matchLink adds "Find partners who can help". */
  A.answerHtml = function (turn, opts) {
    opts = opts || {};
    var html = turn.kind === "matches" ? A.matchesCompact(turn) : '<div class="ans">' + A.md(turn.answer, turn.id) + "</div>";
    // From a saved answer: say so, and when it was written. Saved answers are shared by all staff, so the
    // question someone else asked is not shown.
    if (turn.memory) {
      var m = turn.memory, when = esc(PI.fmtDate(String(m.from || "").slice(0, 10)));
      var added = num(m.newNotes);
      html += '<p class="memo">' + (m.mode === "updated" ? "A saved answer from " + when + ", updated with " + added + " new note" +
        (added === 1 ? "" : "s") + "." : "A saved answer from " + when + ". No notes have been added since.") + "</p>";
    }
    html += A.sourcesInline(turn);
    if (opts.last) {
      var chips = (turn.followUps || []).map(function (q) { return '<button type="button" class="fu" data-q="' + esc(q) + '">' + esc(q) + "</button>"; });
      if (turn.memory) chips.push('<button type="button" class="fu" data-fresh="' + esc(turn.q) + '">Answer fresh</button>');
      if (opts.matchLink && turn.offerMatch) {
        chips.push('<button type="button" class="fu go" data-match="' + esc(turn.q) + '">Find partners who can help' + ICON.arrow + "</button>");
      }
      if (chips.length) html += '<div class="fus">' + chips.join("") + "</div>";
    }
    return html;
  };

  /* ---- history: each person's own conversations, kept in Box */

  A.history = null;   // the list, once loaded
  A.boxFolder = false;
  A.loadHistory = function () {
    return PI.api("assistant/history").then(function (r) {
      A.history = r.conversations;
      A.boxFolder = r.boxFolder;
      return r.conversations;
    });
  };
  A.remember = function (summary) {
    if (!A.history) return;
    A.history = [summary].concat(A.history.filter(function (c) { return c.id !== summary.id; }));
  };
  A.forget = function (id) {
    return PI.post("assistant/delete", { id: id }).then(function () {
      if (A.history) A.history = A.history.filter(function (c) { return c.id !== id; });
    });
  };
  A.railHtml = function (activeId) {
    var list = A.history;
    if (!list) return '<p class="rl-note"><span class="spinner"></span>Loading…</p>';
    if (!list.length) return '<p class="rl-note">Your questions will be listed here.</p>';
    var now = new Date(), day = 86400000, groups = [["Today", []], ["This week", []], ["Earlier", []]];
    list.forEach(function (c) {
      var d = new Date(c.updatedAt);
      var g = d.toDateString() === now.toDateString() ? 0 : now - d < 7 * day ? 1 : 2;
      groups[g][1].push(c);
    });
    return groups.filter(function (g) { return g[1].length; }).map(function (g) {
      return '<div class="rl-group">' + g[0] + "</div>" + g[1].map(function (c) {
        return '<div class="rl-row"><button type="button" class="rl-item' + (c.id === activeId ? " on" : "") + '" data-conv="' + esc(c.id) + '">' + esc(c.title) +
          '</button><button type="button" class="rl-del" data-del="' + esc(c.id) + '" aria-label="Delete this conversation">' + ICON.bin + "</button></div>";
      }).join("");
    }).join("");
  };
  A.railNote = function () {
    return "Only you see these." + (A.boxFolder ? " A copy is kept in Box." : "");
  };

  /** Point to one cited note: the citation lights up, and the note is opened in the list under the answer. */
  A.showSource = function (scope, turn, ref) {
    Array.prototype.forEach.call(scope.querySelectorAll(".cite.on"), function (c) { c.classList.remove("on"); });
    Array.prototype.forEach.call(scope.querySelectorAll('.cite[data-turn="' + turn.id + '"][data-ref="' + ref + '"]'),
      function (c) { c.classList.add("on"); });
    var t = scope.querySelector('.turn[data-tid="' + turn.id + '"]');
    var all = t && t.querySelector("details.srcs");
    if (all) all.open = true;
    var target = t && t.querySelector('details.srow[data-ref="' + ref + '"]');
    if (target) target.open = true;
    if (target) {
      target.classList.remove("flash"); void target.offsetWidth; target.classList.add("flash");
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };

  /**
   * Several questions can be in flight at once, on one device or several. Each belongs to the
   * conversation object that was on screen when it was asked, and its answer is added to that object,
   * wherever the person has gone since. A new conversation has no id until its first answer comes
   * back (conv.temp), so a follow-up asked before then waits for it and joins the same conversation.
   */
  A.send = function (conv, body) {
    var send = function () {
      return PI.post("assistant", Object.assign({}, body, { conversationId: body.fresh || conv.temp ? "" : conv.id })).then(function (r) {
        if (conv.temp) {
          conv.temp = false; conv.id = r.conversation.id; conv.title = r.conversation.title;
          conv.companyId = r.conversation.companyId || conv.companyId || "";
        }
        return r;
      });
    };
    var p = conv.temp && conv.first ? conv.first.then(send, send) : send();
    if (conv.temp && !conv.first) conv.first = p;
    return p;
  };
  var newIds = 0;
  /** A conversation that exists only on this screen until its first answer gives it an id. */
  /** A name for a question while it is being answered, so its turn can be found to play the mark's ending. */
  A.pendingId = function () { return "p" + (++newIds); };
  A.newConv = function (companyId) { return { id: "new-" + (++newIds), temp: true, turns: [], companyId: companyId || "" }; };
  /** Is this pending question (or turn) for the conversation on screen? The same conversation may have been
   * opened again from history since, as another object with the same id. */
  A.sameConv = function (a, b) { return Boolean(a && b) && (a === b || (!a.temp && !b.temp && a.id === b.id)); };
  /** A failed question, kept in its conversation on screen only, with the error under it. */
  A.errorTurn = function (q, message) { return { id: "err-" + (++newIds), q: q, error: message || "Something went wrong." }; };
  A.errorHtml = function (t) {
    return '<div class="turn"><div class="qb">' + esc(t.q) + '</div><div class="msg err">' + esc(t.error) + "</div></div>";
  };
  /* While a question is being answered: the Conexus mark, its amber diamond riding the figure 8, beside a
   * shop-floor phrase that changes every few seconds. A screen reader hears "Reading the notes" once. */
  A.PHRASES = [
    "Chamfering the edges",
    "Calibrating the gauges",
    "Aligning the fixtures",
    "Deburring the details",
    "Torquing the bolts",
    "Tempering the steel",
    "Milling the notes",
    "Machining the answer",
    "Welding the seams",
    "Polishing the surfaces",
    "Shimming the gaps",
    "Squaring the corners",
    "Tapping the threads",
    "Forging the links",
    "Checking the tolerances",
    "Greasing the bearings",
    "Tightening the specs",
    "Zeroing the axes",
    "Soldering the joints",
    "Wiring the harness",
    "Kitting the components",
    "Staging the pallets",
    "Routing the shipments",
    "Sequencing the jobs",
    "Walking the gemba",
    "Pulling the kanban",
    "Asking the five whys",
    "Mapping the value stream",
    "Cutting the muda",
    "Mistake-proofing the process",
    "Finding the next kaizen",
  ];
  var MARK_LAP = 2600; // ms for one figure 8 (pm-ride in pi.css); the diamond crosses the center twice a lap
  var MARK_LOOPS = "M316.1 0C291.6 0 269.4 9.9 253.2 25.9C249.6 29.5 242.5 36.6 242.5 36.6L277.9 72C277.9 72 284.7 65.2 288.2 61.6C295.3 54.5 305.2 50 316.1 50C337.7 50 355.4 67.6 355.4 89.2C355.4 110.8 337.7 128.4 316.1 128.4C305.2 128.4 295.3 123.9 288.2 116.7C284.7 113.2 277.9 106.4 277.9 106.4L242.5 141.7C242.5 141.7 249.6 148.9 253.2 152.5C269.4 168.5 291.6 178.4 316.1 178.4C365.4 178.4 405.4 138.5 405.4 89.2C405.4 39.9 365.4 0 316.1 0ZM137.1 0C161.6 0 183.8 9.9 200 25.9C203.6 29.5 210.7 36.6 210.7 36.6L175.3 72C175.3 72 168.5 65.2 165 61.6C157.8 54.5 148 50 137.1 50C115.4 50 97.8 67.6 97.8 89.2C97.8 110.8 115.4 128.4 137.1 128.4C148 128.4 157.8 123.9 165 116.7C168.5 113.2 175.3 106.4 175.3 106.4L210.7 141.7C210.7 141.7 203.6 148.9 200 152.5C183.8 168.5 161.6 178.4 137.1 178.4C87.8 178.4 47.8 138.5 47.8 89.2C47.8 39.9 87.8 0 137.1 0Z";
  var markClock = Date.now();
  var phraseBag = [], phraseNow = "", phraseTimer = 0;
  /** The next phrase. Every one shows once, in a random order, before any shows again, and none twice running. */
  A.nextPhrase = function () {
    if (!phraseBag.length) {
      phraseBag = A.PHRASES.slice();
      for (var i = phraseBag.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1)), x = phraseBag[i];
        phraseBag[i] = phraseBag[j]; phraseBag[j] = x;
      }
      if (phraseBag[phraseBag.length - 1] === phraseNow) phraseBag.unshift(phraseBag.pop());
    }
    phraseNow = phraseBag.pop();
    return phraseNow;
  };
  function turnPhrase() {
    // A mark playing its ending keeps the phrase it had; the answer is about to replace both.
    var shown = document.querySelectorAll(".pi-mark:not(.settled) + .pi-phrase");
    if (!shown.length) { clearInterval(phraseTimer); phraseTimer = 0; return; }
    var next = A.nextPhrase() + "…";
    Array.prototype.forEach.call(shown, function (el) { el.textContent = next; });
  }
  /** The mark. Every mark on the page rides in step, and one drawn again carries on from where the last was. */
  A.markHtml = function () {
    var at = ((Date.now() - markClock) % MARK_LAP) / 1000;
    return '<span class="pi-mark" aria-hidden="true"><svg viewBox="46 -1 361 180.4" width="64" height="32"><path d="' + MARK_LOOPS + '"/></svg>' +
      '<span class="pm-ride" style="animation-delay:-' + at.toFixed(2) + 's"></span></span>';
  };
  A.pendingHtml = function (q, id) {
    if (!phraseNow) A.nextPhrase();
    if (!phraseTimer) phraseTimer = setInterval(turnPhrase, MARK_LAP * 4); // one phrase every four laps, about 10 seconds
    return '<div class="turn pending"' + (id ? ' data-pid="' + esc(id) + '"' : "") + '><div class="qb">' + esc(q) + "</div>" +
      '<div class="thinking" role="status">' + A.markHtml() + '<span class="pi-phrase" aria-hidden="true">' + esc(phraseNow) + "…</span>" +
      '<span class="sr-only">Reading the notes…</span></div></div>';
  };
  var MARK_SWELL = [{ transform: "rotate(45deg) scale(1)" }, { transform: "rotate(45deg) scale(1.6)", offset: 0.4 }, { transform: "rotate(45deg) scale(1)" }];
  /** The mark's ending, played in pending turn `id` inside `scope` once its answer has come: the diamond runs on
   * to its next pass through the center and stops there, swells, and the mark fades. Resolves when that is done,
   * or at once when the turn is not on screen or motion is reduced, so an answer is never held for nothing. */
  A.settle = function (scope, id) {
    var mark = scope && id ? scope.querySelector('.turn.pending[data-pid="' + id + '"] .pi-mark') : null;
    var ride = mark && mark.querySelector(".pm-ride");
    var anim = ride && ride.getAnimations ? ride.getAnimations()[0] : null;
    if (!anim || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
    var at = anim.effect.getComputedTiming();
    var laps = (at.currentIteration || 0) + (at.progress || 0);
    var stop = (Math.floor(laps * 2) + 1) / 2; // the next crossing: the center is at each half lap
    anim.effect.updateTiming({ iterations: stop, fill: "forwards" });
    return new Promise(function (resolve) {
      setTimeout(function () {
        mark.classList.add("settled");
        // The swell and fade are played from here. Swapping the ride for a CSS swell animation, after its
        // timing had been changed above, left the swell finished at zero length, so the diamond never swelled.
        anim.cancel();
        var swell = ride.animate(MARK_SWELL, { duration: 500, easing: "cubic-bezier(.45,0,.25,1)" });
        var fade = mark.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, delay: 420, easing: "ease-in", fill: "forwards" });
        // A mark taken off the page mid-ending may never finish, so the answer waits at most a second.
        Promise.race([Promise.all([swell.finished, fade.finished]), new Promise(function (r) { setTimeout(r, 1000); })])
          .then(resolve, resolve);
      }, Math.max(0, (stop - laps) * MARK_LAP));
    });
  };

  /** The longer prompt when it fits on one line, else the shorter one. On a phone "Ask anything about the
   * partner notes" ran onto a second line the one-line pill cut in half. Measured at one line's height,
   * so it works whatever the font and the width. */
  A.fitPlaceholder = function (t, long, short) {
    if (t.value) return;
    var h = t.style.height;
    t.style.height = "auto";
    t.placeholder = long;
    if (t.scrollHeight > t.clientHeight + 2) t.placeholder = short;
    t.style.height = h;
  };

  /* ---- the floating box */

  var EXAMPLES = ["What are the top issues to discuss at the next quarterly meeting?",
    "What have members said about hiring this year?", "Which topics have grown in the last 90 days?"];
  var box = { open: false, rail: false, conv: null, sel: null, pending: [], error: null };
  var root, veil, q, thread, railEl, noteEl;

  function onAskPage() { return /^#\/?ask(\/|$)/.test(location.hash); }
  function companyHere() {
    var m = location.hash.match(/^#\/company\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function narrow() { return window.matchMedia("(max-width: 700px)").matches; }

  function setWidth() {
    if (!box.open || narrow()) { root.style.width = ""; return; }
    var w = 820 + (box.rail ? 270 : 0);
    root.style.width = "min(" + w + "px, calc(100vw - 32px))";
  }
  function fitPrompt() { A.fitPlaceholder(q, "Ask anything about the partner notes", "Ask about the notes"); autosize(); }
  function autosize() {
    q.style.height = "auto";
    q.style.height = Math.min(q.scrollHeight, box.open ? 140 : 40) + "px";
  }
  function findTurn(id) {
    var turns = (box.conv && box.conv.turns) || [];
    for (var i = 0; i < turns.length; i++) if (turns[i].id === id) return turns[i];
    return null;
  }

  function render() {
    root.classList.toggle("has-conv", Boolean(box.conv));
    var html = "";
    if (!box.conv && !box.error) {
      var co = companyHere();
      var ex = EXAMPLES.slice();
      if (co) ex.unshift("Summarize what we have heard from this company.");
      html = '<div class="ax-empty"><p>Ask anything about the partner notes: what members are raising, what has changed, ' +
        "what to put on an agenda, or what one company has said.</p>" +
        '<div class="fus">' + ex.map(function (e) { return '<button type="button" class="fu" data-q="' + esc(e) + '">' + esc(e) + "</button>"; }).join("") + "</div></div>";
    }
    var turns = (box.conv && box.conv.turns) || [];
    // Questions still being answered show in the conversation they were asked in, in the order asked.
    var here = box.pending.filter(function (p) { return A.sameConv(p.conv, box.conv); });
    html += turns.map(function (t, i) {
      if (t.error) return A.errorHtml(t);
      return '<div class="turn" data-tid="' + esc(t.id) + '"><div class="qb">' + esc(t.q) + "</div>" +
        A.answerHtml(t, { last: i === turns.length - 1 && !here.length, matchLink: true }) + "</div>";
    }).join("");
    html += here.map(function (p) { return A.pendingHtml(p.q, p.id); }).join("");
    if (box.error) {
      html += '<div class="turn"><div class="qb">' + esc(box.error.q) + '</div><div class="msg err">' + esc(box.error.message) + "</div></div>";
    }
    thread.innerHTML = html;
    if (box.rail) railEl.innerHTML = A.railHtml(box.conv && box.conv.id);
    noteEl.textContent = A.railNote();
  }

  function scrollToLast() {
    var turns = thread.querySelectorAll(".turn");
    var last = turns[turns.length - 1];
    if (last) thread.scrollTop = Math.max(0, last.offsetTop - 12);
  }

  function openBox() {
    if (box.open) return;
    box.open = true;
    root.classList.add("show");
    void root.offsetWidth; // the contents are laid out before the box grows, so they fade in
    root.classList.add("open");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    veil.classList.add("on");
    document.documentElement.classList.add("ax-lock");
    setWidth();
    render();
    autosize();
    setTimeout(fitPrompt, 500); // once the box has grown to its width
  }
  function shrink(instant) {
    if (!box.open) return;
    box.open = false;
    root.classList.remove("open");
    root.removeAttribute("role");
    root.removeAttribute("aria-modal");
    veil.classList.remove("on");
    document.documentElement.classList.remove("ax-lock");
    setWidth();
    autosize();
    setTimeout(fitPrompt, 500);
    var done = function () { if (!box.open) root.classList.remove("show"); };
    if (instant) done(); else setTimeout(done, 480);
  }
  function setToggle(which, on) {
    box[which] = on;
    root.classList.toggle(which, on);
    Array.prototype.forEach.call(root.querySelectorAll('[data-tg="' + which + '"]'), function (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); });
    setWidth();
    if (which === "rail" && on) {
      railEl.innerHTML = A.railHtml(box.conv && box.conv.id);
      if (!A.history) A.loadHistory().then(function () { railEl.innerHTML = A.railHtml(box.conv && box.conv.id); noteEl.textContent = A.railNote(); })
        .catch(function (e) { railEl.innerHTML = '<p class="rl-note">' + esc(e.message) + "</p>"; });
    }
  }

  function submit(text, fresh) {
    text = String(text || "").trim();
    if (!text) return;
    openBox();
    box.error = null;
    // A conversation keeps the company it started on: a follow-up, or Answer fresh, asked from another
    // company's page is still about the first company. Answer fresh starts a new conversation.
    if (!box.conv || fresh) box.conv = A.newConv(box.conv ? box.conv.companyId : companyHere());
    var conv = box.conv, item = { q: text, conv: conv, id: A.pendingId() };
    box.pending.push(item);
    q.value = "";
    autosize();
    render();
    scrollToLast();
    var done = function () { box.pending = box.pending.filter(function (p) { return p !== item; }); };
    A.send(conv, { question: text, mode: "answer", companyId: conv.companyId || "", fresh: Boolean(fresh) }).then(function (r) {
      return A.settle(thread, item.id).then(function () { return r; });
    }).then(function (r) {
      done();
      conv.turns.push(r.turn);
      // The same conversation opened again from history since is another object: it gets the answer too.
      if (box.conv && box.conv !== conv && A.sameConv(box.conv, conv) && !findTurn(r.turn.id)) box.conv.turns.push(r.turn);
      A.remember(r.conversation);
      var shown = A.sameConv(box.conv, conv);
      if (shown) box.sel = r.turn.id;
      render();
      if (shown) scrollToLast();
    }).catch(function (err) {
      done();
      conv.turns.push(A.errorTurn(text, err.message));
      render();
      if (A.sameConv(box.conv, conv)) scrollToLast();
      if (!q.value) { q.value = text; autosize(); }
    });
  }

  function openConversation(id) {
    if (narrow()) setToggle("rail", false);
    PI.api("assistant/conversation?id=" + encodeURIComponent(id)).then(function (r) {
      box.conv = r.conversation;
      box.sel = null;
      box.error = null;
      openBox();
      render();
      scrollToLast();
    }).catch(function (err) { box.error = { q: "", message: err.message }; render(); });
  }
  A.resume = function (id) { if (root && !onAskPage()) openConversation(id); else A.pendingResume = id; };

  function startNew() {
    box.conv = null; box.sel = null; box.error = null;
    render();
    q.focus();
  }

  /** "Find partners who can help": the question goes to the Ask page's partner search. */
  function toAskPage(question) {
    PI.askPrefill = { question: question, mode: "match", from: box.conv && !box.conv.temp ? { id: box.conv.id, title: box.conv.title } : null };
    shrink(true);
    location.hash = "#/ask";
  }

  function mount() {
    document.body.insertAdjacentHTML("beforeend",
      '<div class="ax-veil" aria-hidden="true"></div>' +
      '<section class="abx" aria-label="Ask">' +
        '<aside class="abx-rail" aria-label="Past questions"><div class="rl-top"><button type="button" class="ax-back" data-off="rail">' + ICON.back + "Back</button></div>" +
          '<div class="rl-list"></div><p class="rl-note"></p></aside>' +
        '<div class="abx-main">' +
          // The title, with History and New under it on the left (as in Claude), and Shrink on the right.
          '<header class="abx-head"><div class="abx-hl"><h2 class="abx-title">Ask Partner Intelligence</h2>' +
            '<div class="abx-hb">' + A.toggle(false) + A.newButton() + "</div></div>" +
            '<button type="button" class="ax-shrink" aria-label="Shrink">' + ICON.down + "</button></header>" +
          '<div class="abx-body"><div class="abx-thread"></div></div>' +
          '<form class="abx-bar">' +
            '<button type="button" class="ax-hist" aria-label="Past questions">' + ICON.clock + "</button>" +
            '<label class="sr-only" for="abxq">Ask anything about the partner notes</label>' +
            '<textarea id="abxq" rows="1" maxlength="1500" placeholder="Ask anything about the partner notes"></textarea>' +
            '<button type="button" class="ax-up" aria-label="Open the conversation">' + ICON.open + "</button>" +
            '<button type="submit" class="ax-send" aria-label="Ask">' + ICON.up + "</button></form>" +
        "</div></section>");
    root = document.querySelector(".abx");
    veil = document.querySelector(".ax-veil");
    q = root.querySelector("textarea");
    thread = root.querySelector(".abx-thread");
    railEl = root.querySelector(".rl-list");
    noteEl = root.querySelector(".abx-rail .rl-note");
    // Collapsed, the bar is clear glass whose rim bends what is under it in Chrome and Edge (pi.css).
    // The filter is drawn to the bar's size, so it follows the bar as it resizes.
    function sizeGlass() { if (!root.classList.contains("open")) PI.glassFilter("pi-ask-glass", root.offsetWidth, root.offsetHeight, PI.ASK_GLASS); }
    sizeGlass();
    window.addEventListener("resize", sizeGlass);
    root.addEventListener("transitionend", sizeGlass);

    root.querySelector("form").addEventListener("submit", function (e) { e.preventDefault(); submit(q.value); });
    q.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(q.value); }
    });
    q.addEventListener("input", autosize);
    veil.addEventListener("click", function () { shrink(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && box.open) shrink(); });
    root.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target : null;
      if (!t) return;
      var b;
      if ((b = t.closest("[data-tg]"))) { setToggle(b.getAttribute("data-tg"), b.getAttribute("aria-pressed") !== "true"); return; }
      if ((b = t.closest("[data-off]"))) { setToggle(b.getAttribute("data-off"), false); return; }
      if ((b = t.closest(".cite"))) {
        var turn = findTurn(b.getAttribute("data-turn"));
        if (!turn) return;
        box.sel = turn.id;
        A.showSource(thread, turn, b.getAttribute("data-ref"));
        return;
      }
      if ((b = t.closest(".fu[data-q]"))) { submit(b.getAttribute("data-q")); return; }
      if ((b = t.closest(".fu[data-fresh]"))) { submit(b.getAttribute("data-fresh"), true); return; }
      if ((b = t.closest(".fu[data-match]"))) { toAskPage(b.getAttribute("data-match")); return; }
      if ((b = t.closest(".rl-del"))) {
        var id = b.getAttribute("data-del");
        if (!window.confirm("Delete this conversation from your history?")) return;
        A.forget(id).then(function () {
          if (box.conv && box.conv.id === id) box.conv = null;
          render();
        }).catch(function (err) { window.alert(err.message); });
        return;
      }
      if ((b = t.closest(".rl-item"))) { openConversation(b.getAttribute("data-conv")); return; }
      if (t.closest("[data-new]")) { startNew(); return; }
      if (t.closest(".ax-shrink")) { shrink(); return; }
      if (t.closest(".ax-up")) { openBox(); scrollToLast(); return; }
      if (t.closest(".ax-hist")) { openBox(); setToggle("rail", true); }
    });
    window.addEventListener("resize", setWidth);
    window.addEventListener("resize", fitPrompt);
    window.addEventListener("hashchange", place);
    place();
    fitPrompt();
  }

  /** Not on the Ask page, which has its own search. A conversation sent there can come back. */
  function place() {
    var hide = onAskPage();
    if (hide) shrink(true);
    root.hidden = hide;
    document.body.classList.toggle("ax-on", !hide);
    if (!hide && A.pendingResume) { var id = A.pendingResume; A.pendingResume = null; openConversation(id); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
