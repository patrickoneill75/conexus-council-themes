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

  /* ---- the floating box */

  var EXAMPLES = ["What are the top issues to discuss at the next quarterly meeting?",
    "What have members said about hiring this year?", "Which topics have grown in the last 90 days?"];
  var box = { open: false, rail: false, conv: null, sel: null, busy: null, error: null };
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
    if (!box.conv && !box.busy && !box.error) {
      var co = companyHere();
      var ex = EXAMPLES.slice();
      if (co) ex.unshift("Summarize what we have heard from this company.");
      html = '<div class="ax-empty"><p>Ask anything about the partner notes: what members are raising, what has changed, ' +
        "what to put on an agenda, or what one company has said.</p>" +
        '<div class="fus">' + ex.map(function (e) { return '<button type="button" class="fu" data-q="' + esc(e) + '">' + esc(e) + "</button>"; }).join("") + "</div></div>";
    }
    var turns = (box.conv && box.conv.turns) || [];
    html += turns.map(function (t, i) {
      return '<div class="turn" data-tid="' + esc(t.id) + '"><div class="qb">' + esc(t.q) + "</div>" +
        A.answerHtml(t, { last: i === turns.length - 1 && !box.busy, matchLink: true }) + "</div>";
    }).join("");
    // The question being answered shows only in the conversation it was asked in.
    if (box.busy && (box.conv ? box.conv.id : "") === box.busyIn) {
      html += '<div class="turn pending"><div class="qb">' + esc(box.busy) + '</div><div class="thinking"><span class="spinner"></span>Reading the notes…</div></div>';
    } else if (box.busy) {
      html += '<p class="memo">Still answering your question in another conversation.</p>';
    }
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
    if (!text || box.busy) return;
    openBox();
    box.busy = text;
    box.error = null;
    q.value = "";
    autosize();
    render();
    scrollToLast();
    var convId = box.conv ? box.conv.id : "";
    box.busyIn = convId;
    // A conversation keeps the company it started on: a follow-up, or Answer fresh, asked from another
    // company's page is still about the first company.
    var company = box.conv ? box.conv.companyId || "" : companyHere();
    PI.post("assistant", { question: text, conversationId: fresh ? "" : convId, mode: "answer", companyId: company, fresh: Boolean(fresh) }).then(function (r) {
      // Another conversation was opened while this one was being answered: the answer is in the
      // history under its own conversation, and the screen stays where the person went.
      if ((box.conv ? box.conv.id : "") !== convId) {
        A.remember(r.conversation); box.busy = null; render();
        if (box.rail) railEl.innerHTML = A.railHtml(box.conv && box.conv.id);
        return;
      }
      if (!box.conv || box.conv.id !== r.conversation.id) box.conv = { id: r.conversation.id, title: r.conversation.title, turns: [], companyId: r.conversation.companyId || "" };
      box.conv.turns.push(r.turn);
      box.sel = r.turn.id;
      A.remember(r.conversation);
      box.busy = null;
      render();
      scrollToLast();
    }).catch(function (err) {
      box.busy = null;
      box.error = { q: text, message: err.message || "Something went wrong." };
      render();
      scrollToLast();
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
    PI.askPrefill = { question: question, mode: "match", from: box.conv ? { id: box.conv.id, title: box.conv.title } : null };
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
    window.addEventListener("hashchange", place);
    place();
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
