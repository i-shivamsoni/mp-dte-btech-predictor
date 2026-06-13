/* MP-DTE B.Tech predictor — client engine.
 * Deterministic cut-off lookup (NO machine learning): compare the student's rank
 * to historical closing ranks. Shared by the JEE & 12th-% predictors + explorer. */
(function () {
  "use strict";
  var BASE = window.BASEURL || "";
  var cache = {};

  /* ---------- data loading ---------- */
  function load(name) {
    if (cache[name]) return cache[name];
    cache[name] = fetch(BASE + "/assets/data/" + name + ".json")
      .then(function (r) {
        if (!r.ok) throw new Error("Failed to load " + name + " (" + r.status + ")");
        return r.json();
      });
    return cache[name];
  }
  function loadAll(names) { return Promise.all(names.map(load)); }

  /* ---------- small utils ---------- */
  function fmt(n) { return (n == null) ? "—" : n.toLocaleString("en-IN"); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function qsParams() {
    var p = {}; new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; });
    return p;
  }
  function setParams(obj) {
    var u = new URLSearchParams();
    Object.keys(obj).forEach(function (k) { if (obj[k] !== "" && obj[k] != null) u.set(k, obj[k]); });
    history.replaceState(null, "", location.pathname + (u.toString() ? "?" + u : ""));
  }

  /* ---------- prediction engine ---------- */
  function colIndex(pred) { var ci = {}; pred.columns.forEach(function (c, i) { ci[c] = i; }); return ci; }

  // 12th % -> estimated qualifying-exam merit rank, for a given year.
  function meritRankForPct(qe, year, pct) {
    var p = qe.percentile[String(year)];
    if (!p) return null;
    for (var i = 0; i < p.pct.length; i++) { if (p.pct[i] <= pct) return p.rank[i]; }   // pct sorted desc
    return p.rank[p.rank.length - 1];
  }

  function band(rank, closing) {
    if (rank <= closing * 0.8) return "Safe";
    if (rank <= closing) return "Moderate";
    if (rank <= closing * 1.15) return "Reach";
    return "Unreachable";
  }

  /* ===================== Probable Counselling Simulator ===================== *
   * Round-aware: which seat-pool you can probably get, and in which round.
   * FR(2023)/RF(2024+) = Round 1 (entry); FU = first-round UPGRADE (folds into R1,
   * never a fresh-entry round); SR = Round 2 (fresh + upgrade). Non-monotonic across
   * rounds, so we read the actual per-round closings. QE route uses QR/TR.            */
  var JEE_ROUND_MAP = { FR: "r1", RF: "r1", FU: "r1u", SR: "r2" };
  var QE_ROUND_MAP = { QR: "r1", TR: "r2" };
  var SECURING_ORDER = ["r1", "r1u", "r2"];          // Round 1 -> First-Round Upgrade -> Round 2
  var BUCKET_SHORT = { r1: "Round 1", r1u: "First-Round Upgrade", r2: "Round 2" };
  var POOL_RANK = { FW: 0, UR: 1, EWS: 2, OBC: 3, SC: 4, ST: 5 };
  var GEN_RANK = { OP: 0, F: 1 };
  function poolRank(cat, gen) {
    return (POOL_RANK[cat] != null ? POOL_RANK[cat] : 9) * 10 + (GEN_RANK[gen] != null ? GEN_RANK[gen] : 9);
  }
  // (social, gender) pools a profile may occupy. JKM/JKR/NTPC excluded by omission.
  function eligiblePools(p) {
    var cats = { UR: 1 };
    if (p.social && p.social !== "UR") cats[p.social] = 1;
    if (p.tfw && p.domicile !== "other") cats.FW = 1;          // TFW: MP-domicile only
    var gens = (p.gender === "F") ? { OP: 1, F: 1 } : { OP: 1, M: 1 };
    return { cats: cats, gens: gens };
  }
  // earliest enterable round (r1 then r2) whose closing >= rank
  function assignRound(rounds, rank) {
    for (var i = 0; i < SECURING_ORDER.length; i++) {
      var b = SECURING_ORDER[i], r = rounds[b];
      if (r && rank <= r.cl) return { bucket: b, closing: r.cl, opening: r.op, viaUpgrade: !!r.viaUpgrade, outOfReach: false };
    }
    return { bucket: null, closing: null, outOfReach: true };
  }
  var BANDS = ["Safe", "Moderate", "Reach", "Unreachable"];
  function bandFor(rank, closing, bucket, cleared, total) {
    if (closing == null) return "Unreachable";
    var idx = (rank <= 0.80 * closing) ? 0 : (rank <= closing) ? 1 : (rank <= 1.15 * closing) ? 2 : 3;
    if (bucket === "r2" && idx < 2) idx = 2;                   // 2nd-round availability is volatile
    if (total >= 2) { if (cleared === total) idx -= 1; else if (cleared === 0) idx += 1; }
    return BANDS[idx < 0 ? 0 : idx > 3 ? 3 : idx];
  }

  function simulate(ctx, pred, opts) {
    var ci = colIndex(pred);
    var rmap = pred._roundMap || JEE_ROUND_MAP;
    var basis = opts.year || pred.years[pred.years.length - 1];
    var elig = eligiblePools(opts);
    var has = function (set, v) { return !set || set.size === 0 || set.has(v); };
    var pools = {}, clears = {}, seenYear = {}, rows = pred.rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], cat = r[ci.cat], gen = r[ci.gen];
      if (!elig.cats[cat] || !elig.gens[gen]) continue;
      if (opts.domicile === "other" && r[ci.home] === 1) continue;
      var cid = r[ci.c], bid = r[ci.b];
      if (!has(opts.branchSet, bid)) continue;
      if (opts.collegeSet && opts.collegeSet.size && !opts.collegeSet.has(cid)) continue;
      var col = ctx.colleges[cid]; if (!col) continue;
      if (!has(opts.citySet, col.city)) continue;
      if (!has(opts.typeSet, col.type)) continue;
      var bucketRaw = rmap[r[ci.rd]]; if (!bucketRaw) continue;
      var key = cid + "|" + bid + "|" + cat + "|" + gen;
      if (bucketRaw === "r1" || bucketRaw === "r1u") {
        var yk = key + "|" + r[ci.yr];
        if (!seenYear[yk]) { seenYear[yk] = 1; var c0 = clears[key] || (clears[key] = { tot: 0, ok: 0 }); c0.tot += 1; if (opts.rank <= r[ci.cl]) c0.ok += 1; }
      }
      if (r[ci.yr] !== basis) continue;
      var p = pools[key] || (pools[key] = { cid: cid, bid: bid, cat: cat, gen: gen, dom: r[ci.dom], rounds: {} });
      var tgt = bucketRaw, cell = p.rounds[tgt];      // r1 / r1u (upgrade) / r2 kept as distinct rounds
      if (!cell) { p.rounds[tgt] = { cl: r[ci.cl], op: r[ci.op], al: r[ci.al] || 0 }; }
      else { cell.al += (r[ci.al] || 0); if (r[ci.cl] > cell.cl) { cell.cl = r[ci.cl]; cell.op = r[ci.op]; } }
      p.dom = r[ci.dom];
    }
    var out = [];
    Object.keys(pools).forEach(function (k) {
      var p = pools[k], asg = assignRound(p.rounds, opts.rank), best = null;
      SECURING_ORDER.forEach(function (b) { var c = p.rounds[b]; if (c && (best == null || c.cl < best)) best = c.cl; });
      var cl = clears[k] || { tot: 0, ok: 0 }, col = ctx.colleges[p.cid] || {};
      out.push({
        cid: p.cid, bid: p.bid, college: col.name || ("College " + p.cid), city: col.city || "—", type: col.type || "—",
        branch: ctx.branchLabel[p.bid] || p.bid, social: p.cat, gender: p.gen, domicile: p.dom, year: basis,
        bucket: asg.bucket || "out", outOfReach: asg.outOfReach, closing: asg.closing, opening: asg.opening,
        viaUpgrade: asg.viaUpgrade, seats: (ctx.intake[p.cid] || {})[p.bid] || null,
        bestClosing: best != null ? best : Infinity, tfw: p.cat === "FW",
        pool: (p.cat === "FW") ? "tfw" : (p.gen === "F" ? "female" : ((p.cat === opts.social && opts.social !== "UR") ? "reserved" : "general")),
        poolRank: poolRank(p.cat, p.gen), historical: !!col.historical,
        band: bandFor(opts.rank, asg.closing, asg.bucket, cl.ok, cl.tot),
      });
    });
    return rankChoices(out, opts);
  }

  function rankChoices(arr, opts) {
    opts = opts || {};
    if (opts.groupByCollegeBranch) {
      var gbest = {};
      arr.forEach(function (u) { var g = u.cid + "|" + u.bid, c = u.outOfReach ? Infinity : u.bestClosing; if (gbest[g] == null || c < gbest[g]) gbest[g] = c; });
      arr.sort(function (a, b) {
        if (a.outOfReach !== b.outOfReach) return a.outOfReach ? 1 : -1;
        var ga = a.cid + "|" + a.bid, gb = b.cid + "|" + b.bid;
        if (gbest[ga] !== gbest[gb]) return gbest[ga] - gbest[gb];
        if (ga !== gb) return ga < gb ? -1 : 1;
        return a.poolRank - b.poolRank;
      });
    } else {
      arr.sort(function (a, b) {
        if (a.outOfReach !== b.outOfReach) return a.outOfReach ? 1 : -1;
        var BO = { r1: 0, r1u: 1, r2: 2 };
        var ar = BO[a.bucket] != null ? BO[a.bucket] : 3, br = BO[b.bucket] != null ? BO[b.bucket] : 3;
        if (ar !== br) return ar - br;                 // Round 1 < Upgrade < Round 2
        if (a.bestClosing !== b.bestClosing) return a.bestClosing - b.bestClosing;
        if (a.poolRank !== b.poolRank) return a.poolRank - b.poolRank;
        if (a.college !== b.college) return a.college < b.college ? -1 : 1;
        return a.branch < b.branch ? -1 : (a.branch > b.branch ? 1 : 0);
      });
    }
    var n = 0;
    arr.forEach(function (u) { u.choiceNo = u.outOfReach ? null : (++n); });
    return arr;
  }

  /* ---- accessible dependency-free multi-select (collapsible checkbox panel) ---- */
  function MultiSelect(container, opts) {
    var selected = Object.create(null), idp = "ms-" + opts.key;
    var root = el("div", "f-group ms");
    var lbl = el("span", "ms-label", esc(opts.label)); lbl.id = idp + "-lbl";
    var btn = el("button", "ms-toggle"); btn.type = "button";
    btn.setAttribute("aria-haspopup", "true"); btn.setAttribute("aria-expanded", "false");
    var sum = el("span", "ms-summary"); sum.id = idp + "-sum";
    btn.setAttribute("aria-labelledby", lbl.id + " " + sum.id);
    var caret = el("span", "ms-caret", "&#9662;"); caret.setAttribute("aria-hidden", "true");
    btn.appendChild(sum); btn.appendChild(caret);
    var pop = el("div", "ms-pop"); pop.setAttribute("role", "group"); pop.setAttribute("aria-labelledby", lbl.id); pop.hidden = true;
    var list = el("ul", "ms-list");
    if (opts.options.length > 8) {
      var sw = el("div", "ms-search-wrap"), search = el("input", "ms-search");
      search.type = "text"; search.placeholder = "Search " + opts.label.toLowerCase() + "…"; search.setAttribute("aria-label", "Search " + opts.label);
      sw.appendChild(search); pop.appendChild(sw);
      search.addEventListener("input", function () {
        var q = search.value.toLowerCase();
        Array.prototype.forEach.call(list.querySelectorAll("li"), function (li) { li.style.display = li.textContent.toLowerCase().indexOf(q) > -1 ? "" : "none"; });
      });
    }
    var actions = el("div", "ms-actions"), allBtn = el("button", "ms-all", "All"), clrBtn = el("button", "ms-clear", "Clear");
    allBtn.type = "button"; clrBtn.type = "button"; actions.appendChild(allBtn); actions.appendChild(clrBtn); pop.appendChild(actions);
    opts.options.forEach(function (o) {
      var li = el("li"), l = el("label"), cb = el("input"); cb.type = "checkbox"; cb.value = o.value;
      cb.addEventListener("change", function () { if (cb.checked) selected[o.value] = true; else delete selected[o.value]; refresh(); opts.onChange && opts.onChange(); });
      l.appendChild(cb); l.appendChild(document.createTextNode(" " + o.text)); li.appendChild(l); list.appendChild(li);
    });
    pop.appendChild(list);
    function refresh() {
      var keys = Object.keys(selected);
      if (!keys.length) { sum.textContent = "All " + opts.summaryNoun; root.classList.remove("ms-active"); return; }
      root.classList.add("ms-active");
      if (keys.length <= 2) sum.textContent = keys.map(function (v) { var o = opts.options.filter(function (x) { return x.value === v; })[0]; return o ? o.text : v; }).join(", ");
      else sum.textContent = keys.length + " " + opts.summaryNoun + " selected";
    }
    function open() { pop.hidden = false; btn.setAttribute("aria-expanded", "true"); root.classList.add("ms-open"); }
    function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); root.classList.remove("ms-open"); }
    btn.addEventListener("click", function () { pop.hidden ? open() : close(); });
    function liOf(node) { while (node && node.tagName !== "LI") node = node.parentNode; return node || {}; }
    allBtn.addEventListener("click", function () { Array.prototype.forEach.call(list.querySelectorAll("input"), function (cb) { if (liOf(cb).style.display !== "none") { cb.checked = true; selected[cb.value] = true; } }); refresh(); opts.onChange && opts.onChange(); });
    clrBtn.addEventListener("click", function () { Array.prototype.forEach.call(list.querySelectorAll("input"), function (cb) { cb.checked = false; }); selected = Object.create(null); refresh(); opts.onChange && opts.onChange(); });
    document.addEventListener("click", function (e) { if (!root.contains(e.target)) close(); });
    pop.addEventListener("keydown", function (e) { if (e.key === "Escape") { close(); btn.focus(); } });
    root.appendChild(lbl); root.appendChild(btn); root.appendChild(pop); container.appendChild(root); refresh();
    return {
      values: function () { return new Set(Object.keys(selected)); },
      set: function (a) { selected = Object.create(null); (a || []).forEach(function (v) { selected[v] = true; }); Array.prototype.forEach.call(list.querySelectorAll("input"), function (cb) { cb.checked = !!selected[cb.value]; }); refresh(); },
    };
  }
  function buildMultiFilters(ctx, container, onChange) {
    container.innerHTML = "";
    var ms = {};
    ms.city = MultiSelect(container, { key: "city", label: "Cities", summaryNoun: "cities", onChange: onChange, options: ctx.cities.map(function (c) { return { value: c, text: c }; }) });
    ms.branch = MultiSelect(container, { key: "branch", label: "Branches", summaryNoun: "branches", onChange: onChange, options: ctx.branches.map(function (b) { return { value: b.id, text: b.label }; }) });
    ms.type = MultiSelect(container, { key: "type", label: "Institute types", summaryNoun: "types", onChange: onChange, options: (ctx.types || []).map(function (t) { return { value: t, text: t }; }) });
    var colOpts = Object.keys(ctx.colleges).map(function (id) { return ctx.colleges[id]; }).filter(function (c) { return c && !c.historical; })
      .sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); }).map(function (c) { return { value: c.id, text: c.name + " — " + (c.city || "") }; });
    ms.college = MultiSelect(container, { key: "college", label: "Specific colleges (optional)", summaryNoun: "colleges", onChange: onChange, options: colOpts });
    return ms;
  }

  /* ---- simulator rendering ---- */
  function poolTag(r) {
    if (r.tfw) return "<span class='pool pool-tfw' title='Tuition Fee Waiver — zero tuition (family income ≤ ₹8L), MP-domicile only, no branch/college change after admission'>TFW</span>";
    if (r.pool === "reserved") return "<span class='pool' title='your reserved-category pool'>" + esc(r.social) + "</span>";
    if (r.pool === "female") return "<span class='pool pool-f' title='female pool — easier cut-off'>Female</span>";
    return "<span class='pool muted' title='general / open pool'>General</span>";
  }
  function domTag(r) {
    if (r.domicile === "AI") return " <span class='pool muted' title='All-India / open seat'>AI</span>";
    if (r.domicile === "MP") return " <span class='pool muted' title='MP home-state seat'>MP</span>";
    return "";
  }
  function poolLabel(r) { return r.tfw ? "TFW" : (r.pool === "female" ? r.social + " Female" : (r.pool === "reserved" ? r.social : "General")); }
  var CHOICE_CAP = 50;

  // Three choice-list strategies. reachable is pre-sorted toughest-first; oor = out-of-reach pools.
  var STRATS = [
    { k: "safe", t: "Safe", d: "Only seats you&rsquo;re very likely to get &mdash; fill these to guarantee a good allotment." },
    { k: "balanced", t: "Balanced", d: "A realistic spread &mdash; a few dream picks, several likely, a couple of safe anchors." },
    { k: "greedy", t: "Greedy", d: "Aspirational &mdash; ~25 dream/tough picks you might land as cut-offs loosen across rounds, with a few safe anchors at the end so you&rsquo;re never left unallotted." },
  ];
  function dedupePools(arr) {
    var seen = {}, out = [];
    arr.forEach(function (r) { var k = r.cid + "|" + r.bid + "|" + r.social + "|" + r.gender; if (!seen[k]) { seen[k] = 1; out.push(r); } });
    return out;
  }
  function strategyPicks(reachable, oor, strategy) {
    var byClose = function (a, b) { return a.bestClosing - b.bestClosing; };   // toughest/best first
    var reach = reachable.filter(function (r) { return r.band === "Reach"; });
    var mod = reachable.filter(function (r) { return r.band === "Moderate"; });
    var safe = reachable.filter(function (r) { return r.band === "Safe"; });
    if (strategy === "safe") return safe.slice().sort(byClose).slice(0, CHOICE_CAP);
    if (strategy === "balanced") return reach.slice(0, 3).concat(mod.slice(0, 5)).concat(safe.slice(0, 2)).sort(byClose);
    // greedy: ~25 aspirational (closest out-of-reach + reach + moderate), dream-first, + 3 safe anchors
    var stretch = oor.slice().sort(function (a, b) { return b.bestClosing - a.bestClosing; }).slice(0, 15); // nearest-miss first
    var top = dedupePools(stretch.concat(reach).concat(mod)).sort(byClose).slice(0, 25);
    return top.concat(safe.slice().sort(byClose).slice(0, 3));
  }

  function renderSimulation(results, container, opts) {
    container.innerHTML = "";
    var reachable = results.filter(function (r) { return !r.outOfReach; });
    var unreachable = results.filter(function (r) { return r.outOfReach; });
    if (!reachable.length && !unreachable.length) { container.appendChild(el("p", "empty", "No matching seat-pools. Try widening your filters.")); return; }
    var dnote = domicileNote(opts); if (dnote) container.insertAdjacentHTML("beforeend", dnote);
    container.appendChild(el("p", "result-summary",
      "<strong>" + reachable.length + "</strong> seat-pool option" + (reachable.length === 1 ? "" : "s") +
      " you qualify for at rank " + fmt(opts.rank) + (unreachable.length ? " &middot; " + unreachable.length + " out of reach" : "")));

    if (reachable.length || unreachable.length) {
      var sug = el("div", "choice-suggest");
      // strategy segmented control
      var pick = el("div", "strat-pick");
      pick.appendChild(el("span", "strat-lbl", "Choice-list strategy:"));
      STRATS.forEach(function (s) {
        var btn = el("button", "strat-btn", s.t); btn.type = "button"; btn.setAttribute("data-strat", s.k);
        pick.appendChild(btn);
      });
      sug.appendChild(pick);
      var head = el("div", "choice-head");
      head.innerHTML = "<h2>Your choice-filling list <span class='round-count' id='cl-count'>0</span></h2>";
      var copyBtn = el("button", "btn-copy", "Copy list"); copyBtn.type = "button";
      head.appendChild(copyBtn); sug.appendChild(head);
      var desc = el("p", "muted strat-desc");
      var ol = el("ol", "choice-order");
      sug.appendChild(desc); sug.appendChild(ol);
      container.appendChild(sug);

      var lines = [];
      function renderList(strategy) {
        var picks = strategyPicks(reachable, unreachable, strategy);
        ol.innerHTML = ""; lines = [];
        picks.forEach(function (r, i) {
          var li = el("li"); var oor = r.outOfReach;
          li.innerHTML = "<span class='co-name'>" + esc(r.college) + "</span> &mdash; " + esc(r.branch) + " " + poolTag(r) +
            " <span class='co-rd sub'>" + (oor ? "stretch &middot; closed ~" + fmt(r.bestClosing) : BUCKET_SHORT[r.bucket] + " &middot; ~" + fmt(r.closing)) +
            " &middot; " + (oor ? "Reach+" : r.band) + "</span>";
          ol.appendChild(li);
          lines.push((i + 1) + ". " + r.college + " — " + r.branch + " [" + poolLabel(r) + "]  (" +
            (oor ? "stretch" : BUCKET_SHORT[r.bucket] + ", " + r.band) + ")");
        });
        document.getElementById("cl-count").textContent = picks.length;
        desc.innerHTML = (STRATS.filter(function (s) { return s.k === strategy; })[0] || {}).d +
          " Fill them on the DTE portal <strong>in this order</strong> (best first); you&rsquo;re allotted one seat per round, by merit.";
        Array.prototype.forEach.call(pick.querySelectorAll(".strat-btn"), function (b) {
          b.classList.toggle("active", b.getAttribute("data-strat") === strategy);
        });
      }
      pick.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest(".strat-btn");
        if (b) { var s = b.getAttribute("data-strat"); renderList(s); if (opts.onStrat) opts.onStrat(s); }
      });
      renderList(opts.strategy || "balanced");
      copyBtn.addEventListener("click", function () {
        var text = lines.join("\n");
        var done = function () { copyBtn.textContent = "Copied ✓"; setTimeout(function () { copyBtn.textContent = "Copy list"; }, 1800); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
        else { var ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e2) {} document.body.removeChild(ta); done(); }
      });
    }

    var counter = { v: 0 };
    SECURING_ORDER.forEach(function (b) {
      var rows = reachable.filter(function (r) { return r.bucket === b; });
      if (rows.length) container.appendChild(simRoundSection(b, rows, counter));
    });
    if (unreachable.length) {
      var det = el("details", "unreachable");
      det.appendChild(el("summary", null, "Show " + unreachable.length + " out-of-reach seat-pools"));
      det.appendChild(simRoundSection("out", unreachable, { v: 0 }));
      container.appendChild(det);
    }
  }

  function simRoundSection(bucket, rows, counter) {
    var sec = el("section", "round-block round-" + bucket);
    var head = (bucket === "r1") ? "Likely in Round 1"
      : (bucket === "r1u") ? "Likely in the First-Round Upgrade"
      : (bucket === "r2") ? "Likely securable by Round 2" : "Out of reach";
    sec.appendChild(el("h2", "round-title", esc(head) + " <span class='round-count'>" + rows.length + "</span>"));
    var wrap = el("div", "table-wrap"), t = el("table", "results sim-results");
    t.innerHTML = "<thead><tr><th class='num'>#</th><th>College &middot; Branch</th><th>Pool</th>" +
      "<th>City / Type</th><th class='num'>Closing rank<br><span class='sub'>basis</span></th>" +
      "<th class='num'>Seats<br><span class='sub'>(TFW)</span></th><th>Chance</th></tr></thead>";
    var tb = el("tbody");
    rows.forEach(function (r) {
      counter.v += 1;
      var seats = r.seats ? (fmt(r.seats.total) + (r.seats.tfw ? " <span class='tfw'>(" + r.seats.tfw + " TFW)</span>" : "")) : "<span class='muted' title='no current intake row matched'>n/a</span>";
      var hist = r.historical ? " <span class='muted' title='historical college — not in current intake'>&middot; historical</span>" : "";
      var up = r.viaUpgrade ? " <span class='sub-note' title='reachable in Round 1 only after the first-round upgrade'>incl. upgrade</span>" : "";
      var closeSub = (bucket === "out") ? "out of reach" : (r.year + " " + esc(BUCKET_SHORT[bucket]) + up);
      var tr = el("tr", "row-" + r.band.toLowerCase());
      tr.innerHTML =
        "<td class='num pref-no'>" + (r.choiceNo == null ? "&mdash;" : r.choiceNo) + "</td>" +
        "<td><span class='co-name'>" + esc(r.college) + hist + "</span><span class='sub'>" + esc(r.branch) + "</span></td>" +
        "<td>" + poolTag(r) + domTag(r) + "</td>" +
        "<td>" + esc(r.city) + "<span class='sub'>" + esc(r.type) + "</span></td>" +
        "<td class='num'>" + fmt(r.closing == null ? r.bestClosing : r.closing) + " <span class='sub'>" + closeSub + "</span></td>" +
        "<td class='num'>" + seats + "</td>" +
        "<td><span class='tag tag-" + r.band.toLowerCase() + "'>" + r.band + "</span></td>";
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); sec.appendChild(wrap); return sec;
  }

  function initSimulator() {
    var form = document.getElementById("sim-form");
    var results = document.getElementById("results");
    var filtersBox = document.getElementById("filters");
    loadAll(["colleges", "branches", "cities", "intake", "config", "predictor_jee"]).then(function (a) {
      var ctx = buildContext(a[0], a[1], a[2], a[3], a[4]);
      var pred = a[5]; pred._roundMap = JEE_ROUND_MAP;
      var ms, curStrat = qsParams().strat || "balanced";
      function setStrat(s) { curStrat = s; var u = new URLSearchParams(location.search); u.set("strat", s); history.replaceState(null, "", location.pathname + "?" + u); }
      function run(e) {
        if (e) e.preventDefault();
        var rank = parseInt(document.getElementById("in-rank").value, 10);
        if (isNaN(rank)) { results.innerHTML = "<p class='empty'>Enter your JEE rank to simulate.</p>"; return; }
        var opts = {
          rank: rank, social: document.getElementById("in-cat").value, gender: document.getElementById("in-gender").value,
          domicile: document.getElementById("in-dom").value, tfw: document.getElementById("in-tfw").checked,
          citySet: ms.city.values(), branchSet: ms.branch.values(), typeSet: ms.type.values(), collegeSet: ms.college.values(),
          groupByCollegeBranch: document.getElementById("in-group").checked,
          strategy: curStrat, onStrat: setStrat,
        };
        renderSimulation(simulate(ctx, pred, opts), results, opts);
        setParams({ rank: rank, cat: opts.social, gender: opts.gender, dom: opts.domicile, tfw: opts.tfw ? 1 : "", grp: opts.groupByCollegeBranch ? 1 : "",
          city: Array.from(opts.citySet).join(","), branch: Array.from(opts.branchSet).join(","), type: Array.from(opts.typeSet).join(","), college: Array.from(opts.collegeSet).join(",") });
      }
      ms = buildMultiFilters(ctx, filtersBox, run);
      var p = qsParams(), split = function (s) { return s ? s.split(",") : []; };
      function setVal(id, v) { var e = document.getElementById(id); if (e && v != null && v !== "") e.value = v; }
      setVal("in-rank", p.rank); setVal("in-cat", p.cat); setVal("in-gender", p.gender); setVal("in-dom", p.dom);
      if (p.tfw) document.getElementById("in-tfw").checked = true;
      if (p.grp) document.getElementById("in-group").checked = true;
      ms.city.set(split(p.city)); ms.branch.set(split(p.branch)); ms.type.set(split(p.type)); ms.college.set(split(p.college));
      form.addEventListener("submit", run);
      form.addEventListener("change", function (e) { if (e.target.closest && e.target.closest(".ms")) return; run(); });
      if (p.rank) run();
    }).catch(function (e) { showError(results, e); });
  }

  /* opts: {rank, social, fwOnly, city, branchSet|null, type, year|null} */
  function predict(ctx, pred, opts) {
    var ci = colIndex(pred);
    // category pool(s): your category + the open/general pool as fallback.
    var eligible = (opts.social === "UR") ? { UR: 1 }
      : (function () { var s = {}; s[opts.social] = 1; s.UR = 1; return s; })();
    // TFW (Tuition Fee Waiver) is NOT a category — it is a supernumerary fee-waiver pool
    // open to ANY category. If the student is TFW-eligible, also include those seats.
    if (opts.tfw && opts.domicile !== "other") eligible.FW = 1;   // TFW is MP-domicile only
    // gender pools: female may take open + female seats; male may take open + male seats
    var egender = (opts.gender === "F") ? { OP: 1, F: 1 } : { OP: 1, M: 1 };
    var groups = {};
    for (var i = 0; i < pred.rows.length; i++) {
      var r = pred.rows[i];
      var social = r[ci.cat];
      if (!eligible[social]) continue;
      if (!egender[r[ci.gen]]) continue;
      // non-MP-domicile students can't take MP home-state-only seats
      // non-MP-domicile students can only take "open" seats (home=0): All-India seats at any
      // college, and UR/general seats at PRIVATE colleges. All MP-only seats (home=1) are dropped.
      if (opts.domicile === "other" && r[ci.home] === 1) continue;
      if (opts.year && r[ci.yr] !== opts.year) continue;
      var cid = r[ci.c], bid = r[ci.b];
      if (opts.branchSet && !opts.branchSet[bid]) continue;
      var col = ctx.colleges[cid];
      if (opts.city && (!col || col.city !== opts.city)) continue;
      if (opts.type && (!col || col.type !== opts.type)) continue;
      // TFW seats are a SEPARATE pool — keep them as their own row so the student sees
      // both their regular (paid) chance and their zero-tuition (TFW) chance per college.
      var key = cid + "|" + bid + "|" + (social === "FW" ? "T" : "C");
      var cur = groups[key];
      // year-first, then most lenient (highest closing) within that year
      if (!cur || r[ci.yr] > cur._yr || (r[ci.yr] === cur._yr && r[ci.cl] > cur._cl)) {
        groups[key] = { _cid: cid, _bid: bid, _yr: r[ci.yr], _rd: r[ci.rd], _social: social,
          _gen: r[ci.gen], _dom: r[ci.dom], _op: r[ci.op], _cl: r[ci.cl], _al: r[ci.al] };
      }
    }
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var col = ctx.colleges[g._cid] || {};
      var seats = (ctx.intake[g._cid] || {})[g._bid] || null;
      var b = band(opts.rank, g._cl);
      out.push({
        college: col.name || ("College " + g._cid), city: col.city || "—",
        type: col.type || "—", branch: ctx.branchLabel[g._bid] || g._bid,
        closing: g._cl, opening: g._op, year: g._yr, round: g._rd,
        tfw: g._social === "FW",
        pool: (g._social === "FW") ? "tfw"
          : ((g._social === opts.social && opts.social !== "UR") ? "reserved" : "general"),
        social: g._social, gender: g._gen, domicile: g._dom,
        historical: !!col.historical, seats: seats, band: b, margin: g._cl - opts.rank,
      });
    });
    var order = { Safe: 0, Moderate: 1, Reach: 2, Unreachable: 3 };
    out.sort(function (a, b2) {
      return (order[a.band] - order[b2.band]) || (b2.margin - a.margin) ||
        ((b2.seats ? b2.seats.total : 0) - (a.seats ? a.seats.total : 0));
    });
    return out;
  }

  /* ---------- shared UI: filter controls ---------- */
  function buildFilters(ctx, container, opts) {
    opts = opts || {};
    container.innerHTML = "";
    function group(labelText, control) {
      var g = el("div", "f-group");
      var l = el("label", null, labelText); l.setAttribute("for", control.id);
      g.appendChild(l); g.appendChild(control); container.appendChild(g);
    }
    // City
    var city = el("select"); city.id = "f-city";
    city.appendChild(new Option("Any city", ""));
    ctx.cities.forEach(function (c) { city.appendChild(new Option(c, c)); });
    group("City", city);
    // Branch
    var branch = el("select"); branch.id = "f-branch";
    branch.appendChild(new Option("Any branch", ""));
    ctx.branches.forEach(function (b) { branch.appendChild(new Option(b.label, b.id)); });
    group("Branch", branch);
    // Institute type (official MP-DTE categories, from data)
    var type = el("select"); type.id = "f-type";
    type.appendChild(new Option("Any institute type", ""));
    (ctx.types || []).forEach(function (t) { type.appendChild(new Option(t, t)); });
    group("Institute type", type);
    // Tuition Fee Waiver (label differs per page: predictor = "include", explorer = "only")
    var fwWrap = el("label", "f-check");
    var fw = el("input"); fw.type = "checkbox"; fw.id = "f-fw";
    fwWrap.appendChild(fw);
    fwWrap.appendChild(document.createTextNode(" " + (opts.fwLabel || "Tuition Fee Waiver (TFW) seats")));
    var fwGroup = el("div", "f-group f-group-check"); fwGroup.appendChild(fwWrap);
    container.appendChild(fwGroup);
    return { city: city, branch: branch, type: type, fw: fw };
  }

  /* ---------- shared UI: results table ---------- */
  function renderResults(results, container, opts) {
    opts = opts || {};
    container.innerHTML = "";
    if (!results.length) {
      container.appendChild(el("p", "empty", "No matching colleges. Try widening your filters."));
      return;
    }
    var reachable = results.filter(function (r) { return r.band !== "Unreachable"; });
    var unreachable = results.filter(function (r) { return r.band === "Unreachable"; });

    var summary = el("p", "result-summary",
      "<strong>" + reachable.length + "</strong> reachable college&times;branch options" +
      (unreachable.length ? " &middot; " + unreachable.length + " out of reach" : ""));
    container.appendChild(summary);

    container.appendChild(tableFor(reachable.length ? reachable : results, opts));
    if (unreachable.length) {
      var det = el("details", "unreachable");
      det.appendChild(el("summary", null, "Show " + unreachable.length + " out-of-reach options"));
      det.appendChild(tableFor(unreachable, opts));
      container.appendChild(det);
    }
  }

  function bandTag(b) { return '<span class="tag tag-' + b.toLowerCase() + '">' + b + "</span>"; }

  function tableFor(rows, opts) {
    var wrap = el("div", "table-wrap");
    var t = el("table", "results");
    t.innerHTML = "<thead><tr>" +
      "<th>College</th><th>City</th><th>Branch</th><th>Type</th>" +
      "<th class='num'>Closing rank<br><span class='sub'>basis</span></th>" +
      "<th class='num'>Seats<br><span class='sub'>(TFW)</span></th>" +
      "<th>Chance</th></tr></thead>";
    var tb = el("tbody");
    rows.forEach(function (r) {
      var seats = r.seats ? (fmt(r.seats.total) + (r.seats.tfw ? " <span class='tfw'>(" + r.seats.tfw + " TFW)</span>" : ""))
        : "<span class='muted' title='no 2026-27 intake row matched'>n/a</span>";
      var pool = r.tfw
        ? " <span class='pool pool-tfw' title='Tuition Fee Waiver — zero tuition (income ≤ ₹8L); more competitive'>TFW</span>"
        : (r.pool === "reserved"
          ? " <span class='pool' title='matched your reserved category pool'>" + esc(r.social) + "</span>"
          : " <span class='pool muted' title='general/open pool'>" + esc(r.social) + "</span>");
      if (r.gender === "F") pool += " <span class='pool pool-f' title='female pool — easier cut-off'>Female</span>";
      if (r.domicile === "MP") pool += " <span class='pool muted' title='MP home-state seat'>MP</span>";
      else if (r.domicile === "AI") pool += " <span class='pool muted' title='All-India / open seat'>AI</span>";
      var hist = r.historical ? " <span class='muted' title='historical college — not in 2026-27 intake'>&middot; historical</span>" : "";
      var tr = el("tr", "row-" + r.band.toLowerCase());
      tr.innerHTML =
        "<td>" + esc(r.college) + hist + "</td>" +
        "<td>" + esc(r.city) + "</td>" +
        "<td>" + esc(r.branch) + pool + "</td>" +
        "<td>" + esc(r.type) + "</td>" +
        "<td class='num'>" + fmt(r.closing) + " <span class='sub'>" + r.year + " " + esc(r.round) + "</span></td>" +
        "<td class='num'>" + seats + "</td>" +
        "<td>" + bandTag(r.band) + "</td>";
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); return wrap;
  }

  function showError(container, e) {
    container.innerHTML = "";
    var d = el("div", "data-error",
      "<strong>Couldn&rsquo;t load the data.</strong> Please refresh. " +
      "<span class='muted'>(" + esc(e && e.message) + ")</span>");
    container.appendChild(d);
  }

  // Tell a non-MP-domicile student why their reserved category / female / TFW selections
  // don't change the result (those pools are MP-domicile only).
  function domicileNote(opts) {
    if (opts.domicile !== "other") return "";
    var drops = [];
    if (opts.social && opts.social !== "UR") drops.push("your <strong>" + esc(opts.social) + "</strong> reservation");
    if (opts.gender === "F") drops.push("the <strong>female-only pool</strong>");
    if (opts.tfw) drops.push("<strong>Tuition Fee Waiver (TFW)</strong>");
    if (!drops.length) return "";
    var list = drops.length === 1 ? drops[0]
      : drops.slice(0, -1).join(", ") + " and " + drops[drops.length - 1];
    return "<div class='banner banner-info'><strong>Non-MP-domicile:</strong> " + list +
      " do not apply in MP counselling &mdash; reservation, fee-waiver and the female pool are for " +
      "MP-domicile candidates only. You&rsquo;re shown the <strong>open / general pool</strong> plus the " +
      "5% <strong>All-India</strong> seats: UR seats at private colleges are open to you, but home-state " +
      "seats at government colleges are not. Verify with DTE.</div>";
  }

  /* ---------- context assembly ---------- */
  function buildContext(colleges, branches, cities, intake, config) {
    var byId = {}; colleges.colleges.forEach(function (c) { byId[c.id] = c; });
    var label = {}; branches.branches.forEach(function (b) { label[b.id] = b.label; });
    return {
      colleges: byId, branchLabel: label, branches: branches.branches,
      cities: cities.cities, intake: intake.seats, config: config,
      types: colleges.types || [],
    };
  }

  /* ---------- page: predictor (JEE or QE) ---------- */
  function initPredictor(mode) {
    var form = document.getElementById("predict-form");
    var results = document.getElementById("results");
    var filtersBox = document.getElementById("filters");
    var assets = ["colleges", "branches", "cities", "intake", "config",
      mode === "qe" ? "predictor_qe" : "predictor_jee"];
    loadAll(assets).then(function (a) {
      var ctx = buildContext(a[0], a[1], a[2], a[3], a[4]);
      var pred = a[5];
      var fc = buildFilters(ctx, filtersBox, { fwLabel: "Include Tuition Fee Waiver (TFW) seats (family income ≤ ₹8 L)" });
      // QE: populate year selector with available years; show banner
      if (mode === "qe") {
        var ysel = document.getElementById("f-year");
        pred.years.forEach(function (y) { ysel.appendChild(new Option(y, y)); });
        ysel.value = pred.years[pred.years.length - 1];
      }
      var p = qsParams();
      function setVal(id, v) { var e = document.getElementById(id); if (e && v != null && v !== "") e.value = v; }
      setVal("in-rank", p.rank); setVal("in-pct", p.pct); setVal("in-cat", p.cat);
      setVal("in-gender", p.gender); setVal("in-dom", p.dom);
      if (p.city) fc.city.value = p.city;
      if (p.branch) fc.branch.value = p.branch;
      if (p.type) fc.type.value = p.type;
      if (p.tfw) fc.fw.checked = true;

      function run(e) {
        if (e) e.preventDefault();
        var social = document.getElementById("in-cat").value;
        var gEl = document.getElementById("in-gender"), dEl = document.getElementById("in-dom");
        var opts = {
          social: social, gender: gEl ? gEl.value : "M", domicile: dEl ? dEl.value : "other",
          tfw: fc.fw.checked, city: fc.city.value || null, type: fc.type.value || null,
          branchSet: fc.branch.value ? (function () { var s = {}; s[fc.branch.value] = 1; return s; })() : null,
        };
        var stateP = { cat: social, gender: opts.gender, dom: opts.domicile, tfw: opts.tfw ? 1 : "",
          city: fc.city.value, branch: fc.branch.value, type: fc.type.value };
        if (mode === "qe") {
          var pct = parseFloat(document.getElementById("in-pct").value);
          var yr = parseInt(document.getElementById("f-year").value, 10);
          if (isNaN(pct)) { results.innerHTML = "<p class='empty'>Enter your 12th %.</p>"; return; }
          opts.year = yr;
          opts.rank = meritRankForPct(pred, yr, pct);
          stateP.pct = pct; stateP.year = yr;
          var est = el("p", "rank-est", "Your estimated qualifying-exam merit rank for " + yr +
            ": <strong>" + fmt(opts.rank) + "</strong> (from " + pct + "%).");
          results.innerHTML = ""; results.appendChild(est);
          var r1 = predict(ctx, pred, opts);
          var holder = el("div"); renderResults(r1, holder, opts); results.appendChild(holder);
        } else {
          var rank = parseInt(document.getElementById("in-rank").value, 10);
          if (isNaN(rank)) { results.innerHTML = "<p class='empty'>Enter your JEE rank.</p>"; return; }
          opts.rank = rank; stateP.rank = rank;
          renderResults(predict(ctx, pred, opts), results, opts);
        }
        var dnote = domicileNote(opts);
        if (dnote) results.insertAdjacentHTML("afterbegin", dnote);
        setParams(stateP);
      }
      form.addEventListener("submit", run);
      form.addEventListener("change", run);     // category / gender / domicile selects
      filtersBox.addEventListener("change", run);
      var yEl = document.getElementById("f-year"); if (yEl) yEl.addEventListener("change", run);
      if (p.rank || p.pct) run();
    }).catch(function (e) { showError(results, e); });
  }

  /* ---------- page: college explorer ---------- */
  function initExplorer() {
    var results = document.getElementById("results");
    var filtersBox = document.getElementById("filters");
    loadAll(["colleges", "branches", "cities", "intake"]).then(function (a) {
      var ctx = buildContext(a[0], a[1], a[2], a[3], {});
      var fc = buildFilters(ctx, filtersBox, { fwLabel: "Only colleges offering TFW (fee-waiver) seats" });
      function run() {
        var city = fc.city.value, type = fc.type.value, bid = fc.branch.value, fwOnly = fc.fw.checked;
        var list = a[0].colleges.filter(function (c) {
          if (c.historical) return false;           // explorer shows current 2026-27 colleges only
          if (city && c.city !== city) return false;
          if (type && c.type !== type) return false;
          var seats = ctx.intake[c.id] || {};
          if (bid && !seats[bid]) return false;
          if (fwOnly) {
            var anyTfw = Object.keys(seats).some(function (b) { return seats[b].tfw > 0; });
            if (!anyTfw) return false;
          }
          return true;
        });
        results.innerHTML = "";
        results.appendChild(el("p", "result-summary", "<strong>" + list.length + "</strong> colleges"));
        list.sort(function (x, y) { return (x.name || "").localeCompare(y.name || ""); });
        list.forEach(function (c) {
          var seats = ctx.intake[c.id] || {};
          var card = el("div", "college-card");
          var totalSeats = Object.keys(seats).reduce(function (s, b) { return s + (seats[b].total || 0); }, 0);
          var branchChips = Object.keys(seats).map(function (b) {
            var s = seats[b];
            return "<span class='chip'>" + esc(ctx.branchLabel[b] || b) + " <em>" + s.total +
              (s.tfw ? "/" + s.tfw + " TFW" : "") + "</em></span>";
          }).join("");
          card.innerHTML = "<h3>" + esc(c.name) + "</h3>" +
            "<p class='muted'>" + esc(c.city || "") + " &middot; " + esc(c.type || "") +
            (c.university ? " &middot; " + esc(c.university) : "") +
            " &middot; " + totalSeats + " seats</p><div class='chips'>" + branchChips + "</div>";
          results.appendChild(card);
        });
      }
      buildFilters && filtersBox.addEventListener("change", run);
      run();
    }).catch(function (e) { showError(results, e); });
  }

  /* ---------- home quick form ---------- */
  function initHome() {
    var dv = document.getElementById("data-version");
    load("config").then(function (c) { if (dv) dv.textContent = "data " + c.data_version; }).catch(function () {});
  }

  /* ---------- page: model accuracy (backtest) ---------- */
  function initAccuracy() {
    var box = document.getElementById("accuracy");
    if (!box) return;
    load("backtest").then(function (b) {
      function pct(x) { return x == null ? "—" : x + "%"; }
      // a numeric cell with a proportional tinted fill bar behind the percentage
      function pc(x) {
        var v = x == null ? 0 : x;
        return "<td class='num pctcell' style='background:linear-gradient(90deg,rgba(31,79,191,.12) " +
          v + "%, transparent " + v + "%)'>" + pct(x) + "</td>";
      }
      function tile(n, l, accent) {
        return "<div class='stat" + (accent ? " accent" : "") + "'><div class='n'>" + n +
          "</div><div class='l'>" + l + "</div></div>";
      }
      var statsHtml = "<div class='stats'>" +
        tile(b.jee.overall.pct_within_20 + "%", "JEE cut-off within ±20%") +
        tile(b.qe.overall.pct_within_20 + "%", "12th-% cut-off within ±20%") +
        tile(b.jee.coverage_seat_pct + "%", "seat coverage", true) +
        tile("2018&ndash;25", "years back-tested", true) + "</div>";
      var bandRows = ["Safe (<=0.80x)", "Moderate (<=1.00x)", "Reach (<=1.15x)"].map(function (k) {
        var j = b.jee.calibration[k], q = b.qe.calibration[k];
        var label = k.split(" ")[0], thr = k.match(/\(([^)]+)\)/)[1];
        return "<tr><td><span class='tag tag-" + label.toLowerCase() + "'>" + label + "</span> " +
          "<span class='sub'>rank " + thr + " of last cut-off</span></td>" +
          pc(j.lenient_admit_rate) + pc(j.strict_admit_rate) + pc(q.lenient_admit_rate) + pc(q.strict_admit_rate) + "</tr>";
      }).join("");
      var bandsHtml =
        "<div class='table-wrap'><table class='results'><thead><tr><th>Band</th>" +
        "<th class='num'>JEE<br><span class='sub'>by end of rounds</span></th><th class='num'>JEE<br><span class='sub'>round&nbsp;1</span></th>" +
        "<th class='num'>12th%<br><span class='sub'>by end</span></th><th class='num'>12th%<br><span class='sub'>round&nbsp;1</span></th>" +
        "</tr></thead><tbody>" + bandRows + "</tbody></table></div>" +
        "<p class='muted'>Read: of seats the tool calls e.g. <em>Safe</em> for your rank, this share actually admitted that rank. " +
        "&ldquo;By end of rounds&rdquo; counts late mop-up rounds; &ldquo;round&nbsp;1&rdquo; is the tighter early boundary.</p>";

      function errRow(name, e, cov) {
        return "<tr><td>" + name + "</td><td class='num'>" + e.pct_within_20 + "%</td><td class='num'>" +
          e.pct_within_10 + "%</td><td class='num'>" + Math.round(e.median_abs_rel_err * 100) + "%</td>" +
          "<td class='num'>" + cov + "%</td></tr>";
      }
      var errHtml = "<div class='table-wrap'><table class='results'><thead><tr><th>Route</th>" +
        "<th class='num'>within ±20%</th><th class='num'>within ±10%</th><th class='num'>median error</th>" +
        "<th class='num'>seat coverage</th></tr></thead><tbody>" +
        errRow("JEE rank", b.jee.overall, b.jee.coverage_seat_pct) +
        errRow("12th %", b.qe.overall, b.qe.coverage_seat_pct) + "</tbody></table></div>";

      function yearsHtml(route, label) {
        var py = route.per_year;
        var cells = Object.keys(py).sort().map(function (y) {
          var w = py[y].pct_within_20, cls = w >= 55 ? "tag-safe" : (w >= 40 ? "tag-moderate" : "tag-reach");
          return "<span class='yr-chip " + cls + "'>" + y + "<b>" + w + "%</b></span>";
        }).join("");
        return "<p><strong>" + label + "</strong> (within ±20%, predicting each year from the one before):</p>" +
          "<div class='yr-row'>" + cells + "</div>";
      }

      box.innerHTML = statsHtml +
        "<div id='acc-bands'><h2>What the chance bands really mean</h2>" + bandsHtml + "</div>" +
        "<div id='acc-error'><h2>How close are the cut-off estimates?</h2>" +
        "<p class='muted'>How often last year's cut-off lands near this year's actual cut-off.</p>" + errHtml + "</div>" +
        "<div id='acc-years'><h2>Year-by-year</h2>" + yearsHtml(b.jee, "JEE route") + yearsHtml(b.qe, "12th-% route") +
        "<p class='muted'>Accuracy drops in years when cut-offs shift sharply (e.g. the 2021 COVID-era 12th-% jump, " +
        "and the 2024 JEE inflation).</p></div>";
    }).catch(function (e) { showError(box, e); });
  }

  /* ---------- footer version on all pages ---------- */
  function footerVersion() {
    var dv = document.getElementById("data-version");
    if (dv) load("config").then(function (c) { dv.textContent = "data " + c.data_version; }).catch(function () {});
  }

  /* ---------- boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    footerVersion();
    var page = document.body.getAttribute("data-page");
    if (page === "jee") initSimulator();
    else if (page === "qe") initPredictor("qe");
    else if (page === "explorer") initExplorer();
    else if (page === "accuracy") initAccuracy();
    else if (page === "home") initHome();
    // nav toggle (mobile)
    var tg = document.querySelector(".nav-toggle"), links = document.querySelector(".nav-links");
    if (tg) tg.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      tg.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });

  // expose for dashboard.js
  window.MP = { load: load, loadAll: loadAll, fmt: fmt, el: el, esc: esc };
})();
