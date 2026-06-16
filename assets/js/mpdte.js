/* MP-DTE B.Tech predictor — client engine.
 * Deterministic cut-off lookup (NO machine learning): compare the student's rank
 * to historical closing ranks. Shared by the JEE & 12th-% predictors + explorer. */
(function () {
  "use strict";
  var BASE = window.BASEURL || "";
  var cache = {};
  var CSE_FAMILY = ["cse", "it", "cs-it", "cse-ai", "cse-aiml", "cse-ds", "cse-cyber", "cse-iot", "cse-bc", "cse-bs", "cse-design", "cse-ai-ds", "cse-iot-cyber", "it-ai-robotics", "comp-sci", "cs-tech", "cyber-security", "ai", "ai-ds", "aiml", "data-science", "math-comp"];

  /* ---------- data loading ---------- */
  function load(name) {
    if (cache[name]) return cache[name];
    cache[name] = fetch(BASE + "/assets/data/" + name + ".json" + (window.DATA_V ? "?v=" + window.DATA_V : ""))   // cache-bust on each build
      .then(function (r) {
        if (!r.ok) throw new Error("Failed to load " + name + " (" + r.status + ")");
        return r.json();
      });
    return cache[name];
  }
  function loadAll(names) { return Promise.all(names.map(load)); }

  /* ---------- small utils ---------- */
  function fmt(n) { return (n == null) ? "—" : n.toLocaleString("en-IN"); }
  function fmtFee(n, period) { return (n == null) ? "—" : "₹" + fmt(n) + "/" + (period || "sem"); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
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
  function cseFamilyPresent(ctx) {
    var ids = {};
    (ctx.branches || []).forEach(function (b) { ids[b.id] = true; });
    return CSE_FAMILY.filter(function (id) { return ids[id]; });
  }
  function setFormMsg(node, msg, isError) {
    if (!node) return;
    node.innerHTML = msg || "";
    node.classList.toggle("is-error", !!isError);
  }
  var FEE_RANGES = [
    { v: "", t: "Any fee" },
    { v: "na", t: "Fee unavailable" },
    { v: "lte25", t: "≤ ₹25k", min: 0, max: 25000 },
    { v: "25-50", t: "₹25k–50k", min: 25000, max: 50000 },
    { v: "50-75", t: "₹50k–75k", min: 50000, max: 75000 },
    { v: "gte75", t: "₹75k+", min: 75000 },
  ];
  function feeAmount(fee) { return fee && fee.semester_fee_rs != null ? fee.semester_fee_rs : null; }
  function feePeriod(fee) { return fee && fee.fee_period === "annual" ? "yr" : "sem"; }
  function feePeriodLong(fee) { return fee && fee.fee_period === "annual" ? "per year" : "per semester"; }
  function feeKind(fee) { return fee && fee.fee_period === "annual" ? "annual fee" : "semester-wise fee"; }
  function fmtFeeRecord(fee) { return fmtFee(feeAmount(fee), feePeriod(fee)); }
  function feeFor(ctx, cid, bid) {
    var byCollege = ctx && ctx.fees && ctx.fees.colleges;
    var c = byCollege && byCollege[cid];
    if (!c) return null;
    if (bid && c.branches && c.branches[bid] && c.branches[bid].latest) return c.branches[bid].latest;
    return c.latest || null;
  }
  function feeInRange(fee, key) {
    if (!key) return true;
    var v = feeAmount(fee);
    if (key === "na") return v == null;
    if (v == null) return false;
    var r = FEE_RANGES.filter(function (x) { return x.v === key; })[0];
    if (!r) return true;
    return (r.min == null || v >= r.min) && (r.max == null || v <= r.max);
  }
  function feeHtml(fee) {
    var v = feeAmount(fee);
    if (v == null) return "<span class='muted'>n/a</span>";
    var raw = String(fee.raw_fee_text || "");
    var tip = (fee.session || fee.year || "") + " " + feeKind(fee);
    if (raw && raw !== String(v)) tip += ": " + raw;
    if (fee.source_label || fee.source) tip += " · Source: " + (fee.source_label || fee.source);
    var inner = "₹" + fmt(v) + "<span class='sub'>/" + feePeriod(fee) + "</span>";
    if (fee.source_url) {
      return "<a class='fee-v' href='" + esc(fee.source_url) + "' rel='noopener' target='_blank' title='" + esc(tip) + "'>" + inner + "</a>";
    }
    return "<span class='fee-v' title='" + esc(tip) + "'>" + inner + "</span>";
  }
  function makeFeeSelect(id) {
    var sel = el("select"); sel.id = id || "f-fee";
    FEE_RANGES.forEach(function (r) { sel.appendChild(new Option(r.t, r.v)); });
    return sel;
  }
  function makeSortSelect(id, opts) {
    var sel = el("select"); sel.id = id || "f-sort";
    opts.forEach(function (o) { sel.appendChild(new Option(o.t, o.v)); });
    return sel;
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
    if (rank * 5 <= closing * 4) return "Safe";        // rank <= 0.80*closing (integer-exact)
    if (rank <= closing) return "Moderate";
    if (rank * 20 <= closing * 23) return "Reach";     // rank <= 1.15*closing (integer-exact)
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
  // exact (social, class, gender) codes a profile may be allotted under. We match each EXACT
  // SOCIAL/CLASS/GENDER code separately — never merge e.g. UR/X/OP with UR/D/OP. JKM/JKR/NTPC omitted.
  var QUOTA_LABEL = { D: "Divyang (PwD)", S: "Defence / Ex-serviceman", FF: "Freedom Fighter", NCC: "NCC", H: "Special (H)", TS: "Special (TS)" };
  function eligiblePools(p) {
    var cats = { UR: 1 };
    if (p.social && p.social !== "UR") cats[p.social] = 1;     // your reserved category + open merit
    if (p.tfw && p.domicile !== "other") cats.FW = 1;          // TFW: MP-domicile only
    var gens = (p.gender === "F") ? { OP: 1, F: 1 } : { OP: 1, M: 1 };
    var classes = { "": 1, "X": 1 };                            // general / class-less (EWS, FW)
    if (p.quota && QUOTA_LABEL[p.quota]) classes[p.quota] = 1;  // a claimed special horizontal quota
    return { cats: cats, gens: gens, classes: classes };
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
    var idx = (rank * 5 <= closing * 4) ? 0 : (rank <= closing) ? 1 : (rank * 20 <= closing * 23) ? 2 : 3;
    if (total >= 2) { if (cleared === total) idx -= 1; else if (cleared === 0) idx += 1; }
    if (bucket === "r2" && idx < 2) idx = 2;   // 2nd-round availability is volatile — floor AFTER the multi-year nudge, else a pool that cleared every prior year gets un-floored back below Reach
    if (idx > 2) idx = 2;        // a pool WITH a securing round is reachable -> never "Unreachable"
    return BANDS[idx < 0 ? 0 : idx];
  }

  function median(a) {
    if (!a || !a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
  }
  function simulate(ctx, pred, opts) {
    var ci = colIndex(pred);
    var rmap = pred._roundMap || JEE_ROUND_MAP;
    var basis = opts.year || pred.years[pred.years.length - 1];
    var elig = eligiblePools(opts);
    var has = function (set, v) { return !set || set.size === 0 || set.has(v); };
    var pools = {}, clears = {}, clearsYr = {}, rows = pred.rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], cat = r[ci.cat], gen = r[ci.gen];
      var cls = (ci.cls != null) ? (r[ci.cls] || "") : "X";          // CLASS field (back-compat default X)
      if (!elig.cats[cat] || !elig.gens[gen] || !elig.classes[cls]) continue;
      if (opts.domicile === "other" && r[ci.home] === 1) continue;
      var cid = r[ci.c], bid = r[ci.b];
      if (!has(opts.branchSet, bid)) continue;
      if (opts.collegeSet && opts.collegeSet.size && !opts.collegeSet.has(cid)) continue;
      var col = ctx.colleges[cid]; if (!col || col.historical) continue;   // skip defunct (no 2026-27 intake)
      if (!has(opts.citySet, col.city)) continue;
      if (!has(opts.typeSet, col.type)) continue;
      var bucketRaw = rmap[r[ci.rd]]; if (!bucketRaw) continue;
      var key = cid + "|" + bid + "|" + cat + "|" + cls + "|" + gen;   // EXACT code — never merge codes
      if (bucketRaw === "r1" || bucketRaw === "r1u") {        // collect r1/r1u closings per (key,year) for the multi-year nudge
        var yk = key + "|" + r[ci.yr];
        (clearsYr[yk] || (clearsYr[yk] = { key: key, cls: [] })).cls.push(r[ci.cl]);
      }
      if (r[ci.yr] !== basis) continue;
      var p = pools[key] || (pools[key] = { cid: cid, bid: bid, cat: cat, cls: cls, gen: gen, dom: r[ci.dom], rounds: {} });
      // r1 / r1u (upgrade) / r2 kept as distinct rounds; collect all sub-seat closings per round
      var tgt = bucketRaw, cell = p.rounds[tgt] || (p.rounds[tgt] = { cls: [], ops: [], al: 0 });
      cell.cls.push(r[ci.cl]); cell.ops.push(r[ci.op]); cell.al += (r[ci.al] || 0);
      p.dom = r[ci.dom];
    }
    // multi-year "cleared" tally: one count per (key,year), using the MEDIAN of that year's r1/r1u
    // sub-seat closings — the SAME aggregation as the displayed round closing (so the band nudge is
    // consistent and not dependent on row order in the data).
    Object.keys(clearsYr).forEach(function (yk) {
      var o = clearsYr[yk], m = median(o.cls), c = clears[o.key] || (clears[o.key] = { tot: 0, ok: 0 });
      c.tot += 1; if (opts.rank <= m) c.ok += 1;
    });
    var out = [];
    Object.keys(pools).forEach(function (k) {
      var p = pools[k];
      // each round's closing = MEDIAN of its sub-seat closings (robust to 1-seat outliers — the
      // rank that pool TYPICALLY closes at); opening = the best (lowest) entry rank seen.
      SECURING_ORDER.forEach(function (b) {
        var c = p.rounds[b]; if (!c) return;
        c.cl = median(c.cls); c.op = c.ops.length ? Math.min.apply(null, c.ops) : c.cl;
      });
      var asg = assignRound(p.rounds, opts.rank), best = null, bestOpening = null;
      SECURING_ORDER.forEach(function (b) { var c = p.rounds[b]; if (c && (best == null || c.cl < best)) best = c.cl; });
      SECURING_ORDER.forEach(function (b) { var c = p.rounds[b]; if (c && c.cl === best) bestOpening = c.op; });
      var cl = clears[k] || { tot: 0, ok: 0 }, col = ctx.colleges[p.cid] || {};
      var fee = feeFor(ctx, p.cid, p.bid);
      if (!feeInRange(fee, opts.feeRange)) return;
      out.push({
        cid: p.cid, bid: p.bid, college: col.name || ("College " + p.cid), city: col.city || "—", type: col.type || "—",
        branch: ctx.branchLabel[p.bid] || p.bid, social: p.cat, gender: p.gen, domicile: p.dom, year: basis,
        bucket: asg.bucket || "out", outOfReach: asg.outOfReach, closing: asg.closing, opening: asg.opening,
        viaUpgrade: asg.viaUpgrade, seats: (ctx.intake[p.cid] || {})[p.bid] || null,
        fee: fee,
        bestClosing: best != null ? best : Infinity, bestOpening: bestOpening, tfw: p.cat === "FW",
        cls: p.cls, quota: (p.cls && p.cls !== "X") ? p.cls : "",
        avail: (ctx.avail && ctx.avail[p.cid]) ? (ctx.avail[p.cid][p.bid] || null) : null,   // seat-availability horizon
        prefRank: (ctx.pref && ctx.pref[p.cid + "|" + p.bid]) || 1e9,   // within-branch desirability rank
        prefScore: (ctx.prefScore && ctx.prefScore[p.cid + "|" + p.bid]) || 1e12,   // comparable demand score across selected branches
        pool: (p.cls && p.cls !== "X") ? "special"
            : (p.cat === "FW") ? "tfw"
            : (p.gen === "F" ? "female" : ((p.cat === opts.social && opts.social !== "UR") ? "reserved" : "general")),
        poolRank: poolRank(p.cat, p.gen), historical: !!col.historical,
        band: bandFor(opts.rank, asg.closing, asg.bucket, cl.ok, cl.tot),
      });
    });
    return rankChoices(out, opts);
  }

  function rankChoices(arr, opts) {
    opts = opts || {};
    // Primary order = historical desirability (a counselling list must be PREFERENCE-ordered:
    // the portal awards the best seat you qualify for, so the most sought-after option goes first
    // regardless of how reachable it is). prefRank is per (college,branch), so a college's pools
    // (FW / general / female) share a rank and naturally cluster, FW first via poolRank.
    arr.sort(function (a, b) {
      if (a.prefScore !== b.prefScore) return a.prefScore - b.prefScore; // most sought-after first, comparable across branches
      if (a.prefRank !== b.prefRank) return a.prefRank - b.prefRank;
      if (a.bestClosing !== b.bestClosing) return a.bestClosing - b.bestClosing;
      if (a.poolRank !== b.poolRank) return a.poolRank - b.poolRank;     // FW above the general seat
      if (a.college !== b.college) return a.college < b.college ? -1 : 1;
      return a.branch < b.branch ? -1 : (a.branch > b.branch ? 1 : 0);
    });
    var n = 0;
    arr.forEach(function (u) { u.choiceNo = u.outOfReach ? null : (++n); });
    return arr;
  }

  /* ---- accessible dependency-free multi-select (collapsible checkbox panel) ---- */
  function MultiSelect(container, opts) {
    opts = opts || {};
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
    allBtn.type = "button"; clrBtn.type = "button"; actions.appendChild(allBtn); actions.appendChild(clrBtn);
    var optionLookup = {};
    opts.options.forEach(function (o) { optionLookup[o.value] = true; });
    (opts.presets || []).forEach(function (preset) {
      var vals = (preset.values || []).filter(function (v) { return optionLookup[v]; });
      if (!vals.length) return;
      var presetBtn = el("button", "ms-preset", esc(preset.label));
      presetBtn.type = "button";
      presetBtn.addEventListener("click", function () {
        vals.forEach(function (v) { selected[v] = true; });
        syncBoxes(); refresh(); opts.onChange && opts.onChange();
      });
      actions.appendChild(presetBtn);
    });
    pop.appendChild(actions);
    opts.options.forEach(function (o) {
      var li = el("li"), l = el("label"), cb = el("input"); cb.type = "checkbox"; cb.value = o.value;
      cb.addEventListener("change", function () { if (cb.checked) selected[o.value] = true; else delete selected[o.value]; refresh(); opts.onChange && opts.onChange(); });
      l.appendChild(cb); l.appendChild(document.createTextNode(" " + o.text)); li.appendChild(l); list.appendChild(li);
    });
    pop.appendChild(list);
    function refresh() {
      var keys = Object.keys(selected);
      if (!keys.length) { sum.textContent = opts.emptySummary || ("All " + opts.summaryNoun); root.classList.remove("ms-active"); return; }
      root.classList.add("ms-active");
      if (keys.length <= 2) sum.textContent = keys.map(function (v) { var o = opts.options.filter(function (x) { return x.value === v; })[0]; return o ? o.text : v; }).join(", ");
      else sum.textContent = keys.length + " " + opts.summaryNoun + " selected";
    }
    function open() { pop.hidden = false; btn.setAttribute("aria-expanded", "true"); root.classList.add("ms-open"); }
    function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); root.classList.remove("ms-open"); }
    function syncBoxes() { Array.prototype.forEach.call(list.querySelectorAll("input"), function (cb) { cb.checked = !!selected[cb.value]; }); }
    btn.addEventListener("click", function () { pop.hidden ? open() : close(); });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !pop.hidden) { e.preventDefault(); close(); }
    });
    function liOf(node) { while (node && node.tagName !== "LI") node = node.parentNode; return node || {}; }
    allBtn.addEventListener("click", function () { Array.prototype.forEach.call(list.querySelectorAll("input"), function (cb) { if (liOf(cb).style.display !== "none") { cb.checked = true; selected[cb.value] = true; } }); refresh(); opts.onChange && opts.onChange(); });
    clrBtn.addEventListener("click", function () { selected = Object.create(null); syncBoxes(); refresh(); opts.onChange && opts.onChange(); });
    document.addEventListener("click", function (e) { if (!root.contains(e.target)) close(); });
    pop.addEventListener("keydown", function (e) { if (e.key === "Escape") { close(); btn.focus(); } });
    root.appendChild(lbl); root.appendChild(btn); root.appendChild(pop); container.appendChild(root); refresh();
    return {
      values: function () { return new Set(Object.keys(selected)); },
      set: function (a) { selected = Object.create(null); (a || []).forEach(function (v) { if (optionLookup[v]) selected[v] = true; }); syncBoxes(); refresh(); },
      open: open,
      focus: function () { btn.focus(); },
    };
  }
  function buildMultiFilters(ctx, branchEl, filtersEl, onChange) {
    if (!branchEl) branchEl = filtersEl;
    if (branchEl) branchEl.innerHTML = "";
    if (filtersEl && filtersEl !== branchEl) filtersEl.innerHTML = "";
    var ms = {};
    // Branch is REQUIRED and listed first — results are compared within a branch, so mixing
    // branches (e.g. an Electrical seat surfacing when you meant CSE) would mislead.
    ms.branch = MultiSelect(branchEl, { key: "branch", label: "Branch(es) — required", summaryNoun: "branches", emptySummary: "Choose branch", onChange: onChange,
      presets: [{ label: "+ CSE family", values: cseFamilyPresent(ctx) }],
      options: ctx.branches.map(function (b) { return { value: b.id, text: b.label }; }) });
    ms.city = MultiSelect(filtersEl, { key: "city", label: "Cities", summaryNoun: "cities", onChange: onChange, options: ctx.cities.map(function (c) { return { value: c, text: c }; }) });
    ms.type = MultiSelect(filtersEl, { key: "type", label: "Institute types", summaryNoun: "types", onChange: onChange, options: (ctx.types || []).map(function (t) { return { value: t, text: t }; }) });
    var colOpts = Object.keys(ctx.colleges).map(function (id) { return ctx.colleges[id]; }).filter(function (c) { return c && !c.historical; })
      .sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); }).map(function (c) { return { value: c.id, text: c.name + " — " + (c.city || "") }; });
    ms.college = MultiSelect(filtersEl, { key: "college", label: "Specific colleges (optional)", summaryNoun: "colleges", onChange: onChange, options: colOpts });
    var fg = el("div", "f-group"), lab = el("label", null, "Fee range");
    var feeSel = makeFeeSelect("f-fee"); lab.setAttribute("for", feeSel.id);
    fg.appendChild(lab); fg.appendChild(feeSel); filtersEl.appendChild(fg);
    feeSel.addEventListener("change", function () { onChange && onChange(); });
    ms.fee = {
      value: function () { return feeSel.value; },
      set: function (v) { feeSel.value = FEE_RANGES.some(function (r) { return r.v === v; }) ? v : ""; },
    };
    return ms;
  }

  function showModal(cfg) {
    var previous = document.activeElement;
    var overlay = el("div", "modal-overlay");
    var card = el("div", "modal-card");
    var titleId = "modal-title-" + Math.random().toString(36).slice(2);
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", titleId);
    var closeBtn = el("button", "modal-close", "Close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close dialog");
    var title = el("h2", "modal-title", esc(cfg.title || "Notice"));
    title.id = titleId;
    var body = el("div", "modal-body");
    body.innerHTML = cfg.body || "";
    var actions = el("div", "modal-actions");
    function close() {
      document.removeEventListener("keydown", onDocKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (previous && previous.focus) previous.focus();
    }
    function focusables() {
      return Array.prototype.slice.call(card.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"))
        .filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
    }
    function onDocKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    closeBtn.addEventListener("click", close);
    (cfg.actions || []).forEach(function (a) {
      var btn = el("button", a.primary ? "btn-primary" : "btn-secondary", esc(a.label));
      btn.type = "button";
      btn.addEventListener("click", function () { if (a.onClick) a.onClick(close); else close(); });
      actions.appendChild(btn);
    });
    card.appendChild(closeBtn); card.appendChild(title); card.appendChild(body); card.appendChild(actions);
    overlay.appendChild(card); document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onDocKey);
    setTimeout(function () {
      var f = focusables();
      (f[0] || card).focus();
    }, 0);
    return { close: close, node: overlay };
  }

  function showBranchPopup(branchMs, ctx, run) {
    if (document.querySelector(".modal-overlay")) return;
    var branchPick = document.getElementById("branch-pick");
    showModal({
      title: "Pick a branch first",
      body: "Results are compared <em>within</em> a branch (so e.g. an Electrical seat won't show where you wanted CSE). Choose your branch to continue.",
      actions: [
        { label: "Choose branch", primary: true, onClick: function (close) {
          close();
          setTimeout(function () {
            if (branchPick && branchPick.scrollIntoView) branchPick.scrollIntoView({ behavior: "smooth", block: "center" });
            if (branchMs && branchMs.open) branchMs.open();
            if (branchMs && branchMs.focus) branchMs.focus();
          }, 0);
        } },
        { label: "Select CSE family", onClick: function (close) {
          if (branchMs && branchMs.set) branchMs.set(cseFamilyPresent(ctx));
          close();
          run();
        } },
        { label: "Close", onClick: function (close) { close(); } },
      ],
    });
  }

  /* ---- simulator rendering ---- */
  function poolTag(r) {
    if (r.quota) {
      var soc = (r.social && r.social !== "UR") ? esc(r.social) + " " : "";
      return "<span class='pool pool-special' title='special horizontal quota — only if you hold this status'>" + soc + esc(QUOTA_LABEL[r.quota] || r.quota) + "</span>";
    }
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
  function poolLabel(r) {
    if (r.quota) return ((r.social && r.social !== "UR") ? r.social + " " : "") + (QUOTA_LABEL[r.quota] || r.quota);
    return r.tfw ? "TFW" : (r.pool === "female" ? r.social + " Female" : (r.pool === "reserved" ? r.social : "General"));
  }
  // Seat-availability HORIZON — the last round a college+branch typically still allots seats.
  // Top colleges run dry in Round 1/Upgrade; low-demand ones last into Round 2 / the 12th-% round.
  var AVAIL_YR = 2024;                                   // set from demand_stats.availability_year on load
  var AVAIL_LABEL = {
    r1: { t: "Round 1 only", d: "seats fill in Round 1 — you must grab it then" },
    up: { t: "gone after Upgrade", d: "seats fill by the First-Round Upgrade" },
    r2: { t: "lasts to Round 2", d: "seats usually remain into Round 2" },
    qe: { t: "open in 12th-% round", d: "seats usually remain even in the Qualifying-Exam (percentage) round" },
  };
  function horizonBadge(av) {
    if (!av || !av.h || !AVAIL_LABEL[av.h]) return "";
    var L = AVAIL_LABEL[av.h], n = av.n || [0, 0, 0, 0];
    var tip = "Seats " + L.d + ". " + AVAIL_YR + " allotments — Round 1: " + n[0] + ", Upgrade: " + n[1] +
      ", Round 2: " + n[2] + ", 12th-% round: " + n[3] + " (shows WHEN seats run out — allotment counts, not exact vacancies).";
    return " <span class='avail-badge badge-" + av.h + "' title='" + esc(tip) + "'>" + esc(L.t) + "</span>";
  }
  var CHOICE_CAP = 50;

  // Three choice-list strategies. reachable is pre-sorted toughest-first; oor = out-of-reach pools.
  var STRATS = [
    { k: "safe", t: "Safe", d: "Only seats you&rsquo;re very likely to get, ordered by historical demand &mdash; locks in the best guaranteed allotment." },
    { k: "balanced", t: "Balanced", d: "A realistic spread, most-wanted first &mdash; a few dream picks, the most sought-after seats you can realistically get, and a couple of safe anchors." },
    { k: "greedy", t: "Greedy", d: "Aspirational &mdash; the most sought-after ~25 picks (including ones you can&rsquo;t get yet but might as cut-offs loosen across rounds), down to a few safe anchors so you&rsquo;re never left unallotted." },
  ];
  function dedupePools(arr) {
    var seen = {}, out = [];
    arr.forEach(function (r) { var k = r.cid + "|" + r.bid + "|" + r.social + "|" + r.gender; if (!seen[k]) { seen[k] = 1; out.push(r); } });
    return out;
  }
  // All three strategies return a list ordered by historical desirability (prefRank: best first);
  // they differ only in BREADTH. Safe-band anchors are always included, and because they are the
  // easiest (highest prefRank) seats they naturally settle at the bottom as your guaranteed net.
  function strategyPicks(reachable, oor, strategy) {
    var byPref = function (a, b) {
      return (a.prefScore - b.prefScore) || (a.prefRank - b.prefRank) || (a.bestClosing - b.bestClosing);
    };
    var nearMiss = function (a, b) { return b.bestClosing - a.bestClosing; };   // out-of-reach closest to rank first
    var pref = function (list) { return list.slice().sort(byPref); };
    var safe = reachable.filter(function (r) { return r.band === "Safe"; }).sort(byPref);
    if (strategy === "safe") return safe.slice(0, CHOICE_CAP);
    if (strategy === "balanced") {
      var dreams = pref(oor).slice(0, 3);                                  // 3 top stretch picks
      var body = dedupePools(dreams.concat(pref(reachable))).slice(0, 11); // + most-desirable reachable
      return dedupePools(body.concat(safe.slice(0, 2))).sort(byPref);      // ~12, guaranteed 2 safe anchors
    }
    // greedy: a long aspirational list — top dreams + nearest misses + everything you can get
    var dreams2 = dedupePools(pref(oor).slice(0, 12).concat(oor.slice().sort(nearMiss).slice(0, 8)));
    var body2 = dedupePools(dreams2.concat(pref(reachable))).sort(byPref).slice(0, 25);
    return dedupePools(body2.concat(safe.slice(0, 3))).sort(byPref);       // ~25-28, dream -> safe anchors
  }

  // college name -> link to its cut-off-history page (/college/?id=). Inline (keeps surrounding markup);
  // falls back to plain text when no id is available.
  function coLink(cid, name) {
    return cid ? "<a class='co-link' href='" + BASE + "/college/?id=" + encodeURIComponent(cid) + "'>" + esc(name) + "</a>" : esc(name);
  }
  // explicit "view history" call-to-action for table rows (where a clickable name isn't obvious)
  function coCta(cid) {
    return cid ? "<a class='row-cta' href='" + BASE + "/college/?id=" + encodeURIComponent(cid) +
      "'>View cut-off history 2017&ndash;2025 &rarr;</a>" : "";
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
    container.appendChild(el("p", "muted avail-legend",
      "Each college shows when its seats typically run out: " +
      "<span class='avail-badge badge-r1'>Round 1 only</span> <span class='avail-badge badge-up'>gone after Upgrade</span> " +
      "<span class='avail-badge badge-r2'>lasts to Round 2</span> <span class='avail-badge badge-qe'>open in 12th-% round</span> " +
      "&mdash; so a tougher college may need an earlier round. (From " + AVAIL_YR + " allotments.)"));

    if (reachable.length || unreachable.length) {
      var sug = el("details", "choice-suggest");
      var sugSummary = el("summary", "choice-summary", "Choice-filling list");
      var sugBody = el("div", "choice-body");
      sug.appendChild(sugSummary);
      // strategy segmented control
      var pick = el("div", "strat-pick");
      pick.appendChild(el("span", "strat-lbl", "Choice-list strategy:"));
      STRATS.forEach(function (s) {
        var btn = el("button", "strat-btn", s.t); btn.type = "button"; btn.setAttribute("data-strat", s.k);
        pick.appendChild(btn);
      });
      sugBody.appendChild(pick);
      var head = el("div", "choice-head");
      head.innerHTML = "<h2>Your choice-filling list <span class='round-count' id='cl-count'>0</span></h2>";
      var copyBtn = el("button", "btn-copy", "Copy list"); copyBtn.type = "button";
      head.appendChild(copyBtn); sugBody.appendChild(head);
      var desc = el("p", "muted strat-desc");
      var ol = el("ol", "choice-order");
      sugBody.appendChild(desc); sugBody.appendChild(ol);
      sug.appendChild(sugBody);
      container.appendChild(sug);

      var lines = [];
      function renderList(strategy) {
        var picks = strategyPicks(reachable, unreachable, strategy);
        ol.innerHTML = ""; lines = [];
        picks.forEach(function (r, i) {
          var li = el("li"); var oor = r.outOfReach;
          li.innerHTML = "<span class='co-name'>" + coLink(r.cid, r.college) + "</span> &mdash; " + esc(r.branch) + " " + poolTag(r) +
            " <span class='co-rd sub'>" + (oor ? "stretch &middot; closed ~" + fmt(r.bestClosing) : BUCKET_SHORT[r.bucket] + " &middot; ~" + fmt(r.closing)) +
            " &middot; " + (oor ? "Reach+" : r.band) + " &middot; " + esc(fmtFeeRecord(r.fee)) + "</span>";
          ol.appendChild(li);
          lines.push((i + 1) + ". " + r.college + " — " + r.branch + " [" + poolLabel(r) + "]  (" +
            (oor ? "stretch" : BUCKET_SHORT[r.bucket] + ", " + r.band) + ", fee " + fmtFeeRecord(r.fee) + ")");
        });
        var stratMeta = (STRATS.filter(function (s) { return s.k === strategy; })[0] || {});
        document.getElementById("cl-count").textContent = picks.length;
        sugSummary.innerHTML = "Choice-filling list <span class='round-count'>" + picks.length + "</span> <span class='sub-inline'>" + esc(stratMeta.t || strategy) + "</span>";
        desc.innerHTML = stratMeta.d +
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

    // ---- Sorting: click a column heading. The round sections (R1 / Upgrade / R2) ALWAYS
    //      stay — sorting only reorders rows WITHIN each round. One (column, direction)
    //      shared across all rounds, persisted in ?sort= (e.g. closing-asc). ----
    var SIM_CAP = 50;
    var BAND_ORDER = { Safe: 0, Moderate: 1, Reach: 2, Unreachable: 3 };
    var COL_KEYS = {}; SIM_COLS.forEach(function (c) { COL_KEYS[c.k] = 1; });
    function parseSort(s) {
      var m = /^(.+)-(asc|desc)$/.exec(s || "");
      if (m && COL_KEYS[m[1]] && m[1] !== "demand") return { col: m[1], dir: m[2] === "desc" ? -1 : 1 };
      return { col: "demand", dir: 1 };
    }
    function encodeSort(st) { return st.col === "demand" ? "demand" : st.col + (st.dir < 0 ? "-desc" : "-asc"); }
    var sortState = parseSort(opts.sort);

    function keyOf(r, col) {
      if (col === "college") return ((r.college || "") + " " + (r.branch || "")).toLowerCase();
      if (col === "pool") return (poolLabel(r) || "").toLowerCase();
      if (col === "city") return ((r.city || "") + " " + (r.type || "")).toLowerCase();
      if (col === "opening") return (r.opening == null ? (r.bestOpening == null ? 9e9 : r.bestOpening) : r.opening);
      if (col === "closing") return (r.closing == null ? r.bestClosing : r.closing);
      if (col === "fee") return feeAmount(r.fee);
      if (col === "seats") return (r.seats && r.seats.total) || 0;
      if (col === "chance") return BAND_ORDER[r.band] || 0;
      return 0;
    }
    function sortRows(rows, st) {
      if (!st || st.col === "demand") return rows;   // the recommended (demand) order
      return rows.slice().sort(function (a, b) {
        var ka = keyOf(a, st.col), kb = keyOf(b, st.col);
        if (st.col === "fee") {
          if (ka == null && kb == null) return 0;
          if (ka == null) return 1;
          if (kb == null) return -1;
        }
        var c = (typeof ka === "string") ? ka.localeCompare(kb) : (ka - kb);
        return c * st.dir;
      });
    }

    if (reachable.length > 1) container.appendChild(el("p", "muted sim-sort-hint",
      "Tip: sort by <strong>Opening rank</strong> to see demand, or <strong>Closing rank</strong> to see how far the seat usually goes. &ldquo;#&rdquo; restores the recommended order."));
    var rounds = el("div", "sim-rounds");
    container.appendChild(rounds);

    // one round's table, capped at SIM_CAP with its own show-all toggle
    function drawCapped(bucket, all) {
      var sec = el("div", "round-wrap"); rounds.appendChild(sec);
      (function draw(showAll) {
        sec.innerHTML = "";
        sec.appendChild(simRoundSection(bucket, showAll ? all : all.slice(0, SIM_CAP), { v: 0 }, all.length, sortState));
        if (all.length > SIM_CAP) {
          var wrap = el("div", "br-more-wrap"), btn = el("button", "br-more"); btn.type = "button";
          btn.innerHTML = showAll ? "Show top " + SIM_CAP + " only &uarr;"
            : "Show all " + all.length + " in this round &darr;";
          btn.addEventListener("click", function () { draw(!showAll); });
          wrap.appendChild(btn); sec.appendChild(wrap);
        }
      })(false);
    }
    function paint() {
      rounds.innerHTML = "";
      SECURING_ORDER.forEach(function (b) {
        var all = reachable.filter(function (r) { return r.bucket === b; });
        if (!all.length) {
          // explain the (common) empty First-Round Upgrade so it doesn't look like a bug
          if (b === "r1u" && reachable.length) rounds.appendChild(el("p", "round-empty muted",
            "<strong>First-Round Upgrade &mdash; no new options at rank " + fmt(opts.rank) + ".</strong> " +
            "Every seat you qualify for is already securable in Round 1, and the rest don&rsquo;t open up until Round 2. " +
            "(The upgrade round mainly lets students already allotted in Round 1 move to a higher choice.)"));
          return;
        }
        drawCapped(b, sortRows(all, sortState));
      });
    }
    // click a column heading -> re-sort every round by it (toggle asc/desc; "#" = recommended order)
    rounds.addEventListener("click", function (e) {
      var th = e.target.closest && e.target.closest("th[data-sort]");
      if (!th) return;
      var col = th.getAttribute("data-sort");
      if (col === "demand") sortState = { col: "demand", dir: 1 };
      else if (col === sortState.col) sortState = { col: col, dir: -sortState.dir };
      else sortState = { col: col, dir: 1 };
      if (opts.onSort) opts.onSort(encodeSort(sortState));
      paint();
    });
    paint();
    if (unreachable.length) {
      var det = el("details", "unreachable");
      det.appendChild(el("summary", null, "Show " + unreachable.length + " out-of-reach seat-pools"));
      det.appendChild(simRoundSection("out", unreachable, { v: 0 }));
      container.appendChild(det);
    }
  }

  // simulator results columns — header label + sort key (drives click-to-sort)
  var SIM_COLS = [
    { k: "demand", h: "#", cls: "num" }, { k: "college", h: "College &middot; Branch" },
    { k: "pool", h: "Pool" }, { k: "city", h: "City / Type" },
    { k: "opening", h: "Opening rank", cls: "num", sub: "demand" },
    { k: "closing", h: "Closing rank", cls: "num", sub: "chance" },
    { k: "fee", h: "Fee", cls: "num", sub: "source unit" },
    { k: "seats", h: "Seats", cls: "num", sub: "(TFW)" }, { k: "chance", h: "Chance" }
  ];
  function simHead(sort) {   // sort = {col,dir} -> clickable headers; falsy -> plain (out-of-reach table)
    return "<thead><tr>" + SIM_COLS.map(function (c) {
      var active = sort && sort.col === c.k;
      var ar = (active && c.k !== "demand") ? " <span class='sort-ar'>" + (sort.dir < 0 ? "&darr;" : "&uarr;") + "</span>" : "";
      var cls = [c.cls || "", sort ? "sortable" : "", active ? "sorted" : ""].filter(Boolean).join(" ");
      return "<th" + (cls ? " class='" + cls + "'" : "") + (sort ? " data-sort='" + c.k + "'" : "") + ">" +
        c.h + (c.sub ? "<br><span class='sub'>" + c.sub + "</span>" : "") + ar + "</th>";
    }).join("") + "</tr></thead>";
  }
  function simRoundSection(bucket, rows, counter, total, sort) {
    var sec = el("section", "round-block round-" + bucket);
    var head = (bucket === "r1") ? "Likely in Round 1"
      : (bucket === "r1u") ? "Likely in the First-Round Upgrade"
      : (bucket === "r2") ? "Likely securable by Round 2" : "Out of reach";
    sec.appendChild(el("h2", "round-title", esc(head) + " <span class='round-count'>" + (total || rows.length) + "</span>"));
    var wrap = el("div", "table-wrap"), t = el("table", "results sim-results");
    t.innerHTML = simHead(sort);
    var tb = el("tbody");
    rows.forEach(function (r) {
      counter.v += 1;
      var seats = r.seats ? (fmt(r.seats.total) + (r.seats.tfw ? " <span class='tfw'>(" + r.seats.tfw + " TFW)</span>" : "")) : "<span class='muted' title='no current intake row matched'>n/a</span>";
      var hist = r.historical ? " <span class='muted' title='historical college — not in current intake'>&middot; historical</span>" : "";
      var up = r.viaUpgrade ? " <span class='sub-note' title='reachable in Round 1 only after the first-round upgrade'>incl. upgrade</span>" : "";
      var closeSub = (bucket === "out") ? "out of reach" : (r.year + " " + esc(BUCKET_SHORT[bucket]) + up);
      var opening = r.opening == null ? r.bestOpening : r.opening;
      var tr = el("tr", "row-" + r.band.toLowerCase());
      tr.innerHTML =
        "<td class='num pref-no'>" + (bucket === "out" ? "&mdash;" : counter.v) + "</td>" +   // per-round position (best-first)
        "<td><span class='co-name'>" + esc(r.college) + hist + "</span><span class='sub'>" + esc(r.branch) + horizonBadge(r.avail) + "</span>" + coCta(r.cid) + "</td>" +
        "<td>" + poolTag(r) + domTag(r) + "</td>" +
        "<td>" + esc(r.city) + "<span class='sub'>" + esc(r.type) + "</span></td>" +
        "<td class='num'>" + fmt(opening) + " <span class='sub'>" + (opening == null ? "opening unavailable" : "first admitted") + "</span></td>" +
        "<td class='num'>" + fmt(r.closing == null ? r.bestClosing : r.closing) + " <span class='sub'>" + closeSub + "</span></td>" +
        "<td class='num'>" + feeHtml(r.fee) + "</td>" +
        "<td class='num'>" + seats + "</td>" +
        "<td><span class='tag tag-" + r.band.toLowerCase() + "'>" + r.band + "</span></td>";
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); sec.appendChild(wrap); return sec;
  }

  // branch_priority { bid: [[collegeId, demandClosing], ...] }  ->  { "cid|bid": withinBranchRank }
  function prefFromBranchPriority(bp) {
    var pref = {};
    if (bp) Object.keys(bp).forEach(function (bid) {
      bp[bid].forEach(function (pair, i) { pref[pair[0] + "|" + bid] = i + 1; });
    });
    return pref;
  }
  function prefScoreFromBranchPriority(bp) {
    var pref = {};
    if (bp) Object.keys(bp).forEach(function (bid) {
      bp[bid].forEach(function (pair) { pref[pair[0] + "|" + bid] = pair[1]; });
    });
    return pref;
  }

  /* ---- "Top colleges by branch" browsable priority view ---- */
  function initBranchRankings() {
    var sel = document.getElementById("br-branch"), typeSel = document.getElementById("br-type"),
      citySel = document.getElementById("br-city"), availSel = document.getElementById("br-avail"),
      feeSel = document.getElementById("br-fee"),
      sortSel = document.getElementById("br-sort"), metricSel = document.getElementById("br-metric"),
      out = document.getElementById("br-list");
    if (!sel || !out) return;
    loadAll(["colleges", "branches", "demand_stats", "fees"]).then(function (a) {
      var cols = {}; (a[0].colleges || []).forEach(function (c) { cols[c.id] = c; });
      var blab = {}; (a[1].branches || []).forEach(function (b) { blab[b.id] = b.label; });
      var bp = (a[2] && a[2].branch_priority) || {};
      var avail = (a[2] && a[2].availability) || {};
      var feeCtx = { fees: a[3] || null };
      AVAIL_YR = (a[2] && a[2].availability_year) || AVAIL_YR;
      var types = (a[0].types || []).slice().sort();
      var cityMap = {};
      (a[0].colleges || []).forEach(function (c) { if (c.city) cityMap[c.city] = 1; });
      var cities = Object.keys(cityMap).sort();
      // count only colleges that still have 2026-27 intake — the page drops historical/defunct colleges
      // before ranking, so the dropdown count must match (else a branch whose only college is historical
      // shows "(1)" but renders empty), and branches with zero live colleges are excluded entirely.
      function liveCount(b) {
        return (bp[b] || []).filter(function (pair) { var c = cols[pair[0]]; return c && !c.historical; }).length;
      }
      var bids = Object.keys(bp).filter(function (b) { return liveCount(b) > 0; })
        .sort(function (x, y) { return (blab[x] || x).localeCompare(blab[y] || y); });
      sel.innerHTML = bids.map(function (b) {
        return "<option value='" + esc(b) + "'>" + esc(blab[b] || b) + " (" + liveCount(b) + ")</option>";
      }).join("");
      if (typeSel) {
        typeSel.innerHTML = "<option value=''>All institute types</option>" + types.map(function (t) {
          return "<option value='" + esc(t) + "'>" + esc(t) + "</option>";
        }).join("");
      }
      if (citySel) {
        citySel.innerHTML = "<option value=''>All cities</option>" + cities.map(function (c) {
          return "<option value='" + esc(c) + "'>" + esc(c) + "</option>";
        }).join("");
      }
      var RLAB = { 1: "mid", 2: "open", 3: "close" };   // index into [cid, mid, opening, closing]
      function rowHtml(item, bid, seq, mi, sort) {
        var pair = item.pair;
        var c = cols[pair[0]] || {}, t = c.type || "—";
        var govt = /government|university/i.test(t);
        // # = sequential position in the CURRENT (filtered/sorted) view. Show the overall demand rank
        // as a sub-label whenever the view is reordered (name / demand-desc) OR a filter has shifted seq
        // off the demand rank — but NOT in the default demand view where seq already IS the demand rank.
        var numCell = "<span class='br-rank'>" + seq + "</span>" +
          ((sort || seq !== item.rank) ? "<span class='sub'>demand&nbsp;#" + item.rank + "</span>" : "");
        // headline = the active metric; underneath, the other two of opening/mid/closing so the full
        // admitted-rank range is always visible regardless of which metric you rank by.
        var others = [2, 1, 3].filter(function (k) { return k !== mi; })
          .map(function (k) { return RLAB[k] + "&nbsp;" + fmt(pair[k]); }).join(" &middot; ");
        return "<tr" + (seq === 1 ? " class='br-top'" : "") + ">" +
          "<td class='num'>" + numCell + "</td>" +
          "<td><span class='co-name'>" + esc(c.name || pair[0]) + "</span><span class='sub'>" + esc(c.city || "") + "</span>" + coCta(pair[0]) + "</td>" +
          "<td><span class='pool " + (govt ? "" : "muted") + "'>" + esc(t) + "</span></td>" +
          "<td class='num'><span class='demand-v'>" + fmt(item.val) + "</span><span class='sub'>" + others + "</span></td>" +
          "<td class='num'>" + feeHtml(item.fee) + "</td>" +
          "<td>" + (horizonBadge((avail[pair[0]] || {})[bid]) || "<span class='muted sub'>&mdash;</span>") + "</td></tr>";
      }
      var CAP = 50;
      // each branch_priority entry is [cid, mid, opening, closing]; pick the column to rank/show by.
      var METRIC = {
        "":     { idx: 1, lab: "admitted-rank midpoint (opening&ndash;closing)", sub: "admit-rank mid" },
        open:   { idx: 2, lab: "opening rank (the best/first rank admitted)", sub: "opening rank" },
        close:  { idx: 3, lab: "closing rank (the last rank admitted)", sub: "closing rank" },
      };
      function render(bid, expanded) {
        var all = bp[bid] || [], type = typeSel ? typeSel.value : "", city = citySel ? citySel.value : "",
          avh = availSel ? availSel.value : "", sort = sortSel ? sortSel.value : "",
          feeRange = feeSel ? feeSel.value : "",
          M = METRIC[metricSel ? metricSel.value : ""] || METRIC[""], mi = M.idx;
        // overall demand `rank` = position among ADMITTABLE (2026-27 intake) colleges, re-ordered by the
        // chosen metric (lower = better). Historical/defunct colleges (no current intake) are dropped BEFORE
        // ranking, so the unfiltered list is a contiguous 1..N (no phantom gaps); `demand #N` only appears
        // once a real type/city/avail filter hides rows.
        var ordered = all.slice().filter(function (pair) { var c = cols[pair[0]]; return c && !c.historical; })
          .sort(function (a, b) { return (a[mi] - b[mi]) || (a[0] < b[0] ? -1 : 1); });
        var lst = [];
        ordered.forEach(function (pair, i) {
          var c = cols[pair[0]];
          var fee = feeFor(feeCtx, pair[0], bid);
          if ((!type || c.type === type) && (!city || c.city === city) &&
              (!avh || ((avail[pair[0]] || {})[bid] || {}).h === avh) &&
              feeInRange(fee, feeRange)) lst.push({ pair: pair, rank: i + 1, val: pair[mi], fee: fee });
        });
        if (sort === "demand-desc") lst.reverse();                                  // least sought-after first
        else if (sort === "fee-asc" || sort === "fee-desc") lst.sort(function (a, b) {
          var av = feeAmount(a.fee), bv = feeAmount(b.fee);
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return sort === "fee-asc" ? av - bv : bv - av;
        });
        else if (sort === "name") lst.sort(function (a, b) {
          return (cols[a.pair[0]].name || "").localeCompare(cols[b.pair[0]].name || "");
        });
        var matchTotal = lst.length, capped = matchTotal > CAP && !expanded;
        var rows = (capped ? lst.slice(0, CAP) : lst).map(function (item, idx) { return rowHtml(item, bid, idx + 1, mi, sort); }).join("");
        var locBits = [];
        if (type) locBits.push("<strong>" + esc(type) + "</strong>");
        if (city) locBits.push("<strong>" + esc(city) + "</strong>");
        var crit = [];
        if (locBits.length) crit.push(locBits.join(" in "));
        if (avh && AVAIL_LABEL[avh]) crit.push("<strong>" + esc(AVAIL_LABEL[avh].t) + "</strong> seats");   // surface the avail filter in the count note
        if (feeRange) {
          var fr = FEE_RANGES.filter(function (r) { return r.v === feeRange; })[0];
          if (fr) crit.push("<strong>" + esc(fr.t) + "</strong>");
        }
        var filterNote = crit.length ? " Filtered to " + crit.join(", ") + ": <strong>" + matchTotal + "</strong> match." : "";
        out.innerHTML =
          "<p class='muted'>Colleges offering <strong>" + esc(blab[bid] || bid) + "</strong>, ranked by the open/general (UR) " +
          "Round-1 seat&rsquo;s <strong>" + M.lab + "</strong> over 2023&ndash;25; <strong>lower = more in demand</strong>. " +
          (mi === 1 ? "Same order the simulator fills your choice list in. " : "") +
          filterNote + (capped ? " <strong>Showing " + CAP + " of " + matchTotal + ".</strong>" : "") + "</p>" +
          (matchTotal ? "<div class='table-wrap'><table class='results'><thead><tr><th class='num'>#</th><th>College</th>" +
          "<th>Type</th><th class='num'>Typical demand<br><span class='sub'>" + M.sub + "</span></th>" +
          "<th class='num'>Fee<br><span class='sub'>source unit</span></th>" +
          "<th>Seats last to<br><span class='sub'>" + AVAIL_YR + "</span></th></tr></thead><tbody>" +
          rows + "</tbody></table></div>" : "<p class='empty'>No colleges match this branch and filters.</p>") +
          (matchTotal > CAP ? "<div class='br-more-wrap'><button type='button' class='br-more'>" +
            (expanded ? "Show top " + CAP + " only &uarr;" : "Show all " + matchTotal + " colleges &darr;") + "</button></div>" : "");
        var mb = out.querySelector(".br-more");
        if (mb) mb.addEventListener("click", function () { render(bid, !expanded); });
      }
      function syncUrl() { setParams({ b: sel.value, type: typeSel && typeSel.value, city: citySel && citySel.value, avail: availSel && availSel.value, fee: feeSel && feeSel.value, sort: sortSel && sortSel.value, metric: metricSel && metricSel.value }); }
      var params = qsParams(), want = params.b;
      if (want && bids.indexOf(want) > -1) sel.value = want; else if (bids.indexOf("cse") > -1) sel.value = "cse";
      if (typeSel && params.type && types.indexOf(params.type) > -1) typeSel.value = params.type;
      if (citySel && params.city && cities.indexOf(params.city) > -1) citySel.value = params.city;
      if (availSel && params.avail && AVAIL_LABEL[params.avail]) availSel.value = params.avail;
      if (feeSel && params.fee && FEE_RANGES.some(function (r) { return r.v === params.fee; })) feeSel.value = params.fee;
      if (sortSel && params.sort) sortSel.value = params.sort;
      if (metricSel && (params.metric === "open" || params.metric === "close")) metricSel.value = params.metric;
      render(sel.value);
      [sel, typeSel, citySel, availSel, feeSel, sortSel, metricSel].forEach(function (s) {
        if (s) s.addEventListener("change", function () { render(sel.value); syncUrl(); });
      });
    }).catch(function (e) { showError(out, e); });
  }

  function initSimulator() {
    var form = document.getElementById("sim-form");
    var results = document.getElementById("results");
    var filtersBox = document.getElementById("filters");
    var branchEl = document.getElementById("branch-pick");
    var formMsg = document.getElementById("form-msg");
    loadAll(["colleges", "branches", "cities", "intake", "config", "predictor_jee", "demand_stats", "fees"]).then(function (a) {
      var ctx = buildContext(a[0], a[1], a[2], a[3], a[4]);
      ctx.pref = prefFromBranchPriority(a[6] && a[6].branch_priority);   // (college|branch) -> within-branch demand rank
      ctx.prefScore = prefScoreFromBranchPriority(a[6] && a[6].branch_priority);   // (college|branch) -> comparable demand score
      ctx.avail = (a[6] && a[6].availability) || {};                     // (college -> branch -> availability horizon)
      ctx.fees = a[7] || null;
      AVAIL_YR = (a[6] && a[6].availability_year) || AVAIL_YR;
      var pred = a[5]; pred._roundMap = JEE_ROUND_MAP;
      var initialParams = qsParams();
      var ms, curStrat = initialParams.strat || "balanced", curSort = initialParams.sort || "demand";
      var keepStratParam = initialParams.strat != null, keepSortParam = initialParams.sort != null;
      function setStrat(s) { keepStratParam = true; curStrat = s; var u = new URLSearchParams(location.search); u.set("strat", s); history.replaceState(null, "", location.pathname + "?" + u); }
      function setSort(s) { keepSortParam = true; curSort = s; var u = new URLSearchParams(location.search); u.set("sort", s); history.replaceState(null, "", location.pathname + "?" + u); }
      function run(e) {
        if (e) e.preventDefault();
        var rankEl = document.getElementById("in-rank");
        var rawRank = (rankEl.value || "").trim();
        var rank = parseInt(rawRank, 10);
        if (!/^\d+$/.test(rawRank) || isNaN(rank) || rank < 1) {
          setFormMsg(formMsg, "Enter a valid JEE rank &mdash; a whole number 1 or higher.", true);
          results.innerHTML = "";
          rankEl.focus();
          if (rankEl.scrollIntoView) rankEl.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        if (!ms.branch.values().size) {
          showBranchPopup(ms.branch, ctx, run);
          return;
        }
        setFormMsg(formMsg, "", false);
        var opts = {
          rank: rank, social: document.getElementById("in-cat").value, gender: document.getElementById("in-gender").value,
          domicile: document.getElementById("in-dom").value, tfw: document.getElementById("in-tfw").checked,
          quota: document.getElementById("in-quota").value,
          citySet: ms.city.values(), branchSet: ms.branch.values(), typeSet: ms.type.values(), collegeSet: ms.college.values(),
          feeRange: ms.fee.value(), strategy: curStrat, onStrat: setStrat, sort: curSort, onSort: setSort,
        };
        renderSimulation(simulate(ctx, pred, opts), results, opts);
        setParams({ rank: rank, cat: opts.social, gender: opts.gender, dom: opts.domicile, tfw: opts.tfw ? 1 : "", quota: opts.quota,
          city: Array.from(opts.citySet).join(","), branch: Array.from(opts.branchSet).join(","), type: Array.from(opts.typeSet).join(","), college: Array.from(opts.collegeSet).join(","),
          fee: opts.feeRange,
          strat: keepStratParam || curStrat !== "balanced" ? curStrat : "", sort: keepSortParam || curSort !== "demand" ? curSort : "" });
      }
      ms = buildMultiFilters(ctx, branchEl, filtersBox, run);
      var p = qsParams(), split = function (s) { return s ? s.split(",") : []; };
      function setVal(id, v) { var e = document.getElementById(id); if (e && v != null && v !== "") e.value = v; }
      setVal("in-rank", p.rank); setVal("in-cat", p.cat); setVal("in-gender", p.gender); setVal("in-dom", p.dom); setVal("in-quota", p.quota);
      if (p.tfw) document.getElementById("in-tfw").checked = true;
      lockTfwByDomicile(document.getElementById("in-dom"), document.getElementById("in-tfw"));  // TFW is MP-domicile only
      ms.city.set(split(p.city)); ms.branch.set(split(p.branch)); ms.type.set(split(p.type)); ms.college.set(split(p.college));
      ms.fee.set(p.fee);
      form.addEventListener("submit", run);
      form.addEventListener("change", function (e) { if (e.target.closest && e.target.closest(".ms")) return; run(); });
      if (p.rank) run();
      else setFormMsg(formMsg, "Enter your JEE rank, pick a branch, then Simulate.", false);
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
      var cls = (ci.cls != null) ? (r[ci.cls] || "") : "";
      if (cls && cls !== "X") continue;              // special-quota seats not modelled on the % route
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
      // EXACT SOCIAL/CLASS/GENDER code — never merge (UR and EWS stay as separate rows, each with
      // its own closing), mirroring simulate(). TFW (FW) is its own pool too.
      var key = cid + "|" + bid + "|" + social + "|" + cls + "|" + r[ci.gen];
      var cur = groups[key];
      // year-first, then most lenient (highest closing) within that year
      if (!cur || r[ci.yr] > cur._yr || (r[ci.yr] === cur._yr && r[ci.cl] > cur._cl)) {
        groups[key] = { _cid: cid, _bid: bid, _yr: r[ci.yr], _rd: r[ci.rd], _social: social,
          _cls: cls, _gen: r[ci.gen], _dom: r[ci.dom], _op: r[ci.op], _cl: r[ci.cl], _al: r[ci.al] };
      }
    }
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var col = ctx.colleges[g._cid] || {};
      var seats = (ctx.intake[g._cid] || {})[g._bid] || null;
      var fee = feeFor(ctx, g._cid, g._bid);
      if (!feeInRange(fee, opts.feeRange)) return;
      var b = band(opts.rank, g._cl);
      out.push({
        cid: g._cid,
        college: col.name || ("College " + g._cid), city: col.city || "—",
        type: col.type || "—", branch: ctx.branchLabel[g._bid] || g._bid,
        closing: g._cl, opening: g._op, year: g._yr, round: g._rd,
        fee: fee,
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
    function group(labelText, control, extraClass) {
      var g = el("div", "f-group" + (extraClass ? " " + extraClass : ""));
      var l = el("label", null, labelText); l.setAttribute("for", control.id);
      g.appendChild(l); g.appendChild(control); container.appendChild(g);
    }
    // Search by college name / city (explorer only — opts.search)
    var search = null;
    if (opts.search) {
      search = el("input"); search.type = "search"; search.id = "f-search";
      search.placeholder = opts.searchPlaceholder || "Type a college name or city…";
      search.setAttribute("aria-label", "Search colleges by name or city");
      search.autocomplete = "off";
      group("Search college", search, "f-group-search");
    }
    // City
    var city = el("select"); city.id = "f-city";
    city.appendChild(new Option("Any city", ""));
    ctx.cities.forEach(function (c) { city.appendChild(new Option(c, c)); });
    group("City", city);
    // Branch — only branches actually offered by a current (2026-27 intake) college
    var offered = {};
    Object.keys(ctx.intake || {}).forEach(function (cid) {
      Object.keys(ctx.intake[cid] || {}).forEach(function (bid) { offered[bid] = 1; });
    });
    var branch = el("select"); branch.id = "f-branch";
    branch.appendChild(new Option("Any branch", ""));
    ctx.branches.forEach(function (b) { if (offered[b.id]) branch.appendChild(new Option(b.label, b.id)); });
    group("Branch", branch);
    // Institute type (official MP-DTE categories, from data)
    var type = el("select"); type.id = "f-type";
    type.appendChild(new Option("Any institute type", ""));
    (ctx.types || []).forEach(function (t) { type.appendChild(new Option(t, t)); });
    group("Institute type", type);
    var fee = makeFeeSelect("f-fee");
    group("Fee range", fee);
    var sort = null;
    if (opts.sort) {
      sort = makeSortSelect("f-sort", opts.sortOptions || [
        { v: "name", t: "College name (A–Z)" },
        { v: "fee-asc", t: "Fee: low to high" },
        { v: "fee-desc", t: "Fee: high to low" },
        { v: "seats-desc", t: "Seats: high to low" },
      ]);
      group("Sort", sort);
    }
    // Domicile (only when opts.domicile) — changes which seats are open to the student (rulebook).
    var dom = null;
    if (opts.domicile) {
      dom = el("select"); dom.id = "f-dom";
      dom.appendChild(new Option("MP (domicile)", "mp"));
      dom.appendChild(new Option("Other state (non-domicile)", "other"));
      group("Domicile", dom);
    }
    // Tuition Fee Waiver (label differs per page: predictor = "include", explorer = "only")
    var fwWrap = el("label", "f-check f-check-tfw");
    var fw = el("input"); fw.type = "checkbox"; fw.id = "f-fw";
    fwWrap.appendChild(fw);
    fwWrap.appendChild(el("span", "f-check-text", opts.fwLabelHtml || esc(opts.fwLabel || "Tuition Fee Waiver (TFW) seats")));
    fwWrap.appendChild(el("span", "pool pool-tfw", "TFW"));
    var fwGroup = el("div", "f-group f-group-check f-group-tfw"); fwGroup.appendChild(fwWrap);
    container.appendChild(fwGroup);
    return { city: city, branch: branch, type: type, fee: fee, sort: sort, fw: fw, search: search, dom: dom };
  }

  // Rulebook: a non-MP-domicile student can take the general/UR seats at PRIVATE (self-financing)
  // colleges, but only the 5% All-India seats at government / aided / university institutes.
  function nonMpOpen(type) { return /private|self.?financ/i.test(type || ""); }

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

    container.appendChild(el("p", "result-summary",
      "<strong>" + reachable.length + "</strong> reachable college&times;branch option" + (reachable.length === 1 ? "" : "s") +
      (unreachable.length ? " &middot; " + unreachable.length + " out of reach" : "")));

    var sortState = resParseSort(opts.sort);
    if (opts.choiceList) renderQeChoiceList(reachable, unreachable, container, opts);
    if (reachable.length > 1) container.appendChild(el("p", "muted sim-sort-hint",
      "Tip: sort by <strong>Opening rank</strong> to see demand, or <strong>Closing rank</strong> to see how far the seat usually goes. &ldquo;#&rdquo; restores the recommended order."));
    var body = el("div"); container.appendChild(body);
    function paint() {
      body.innerHTML = "";
      body.appendChild(tableFor(resSort(reachable.length ? reachable : results, sortState), opts, sortState));
      if (unreachable.length) {
        var det = el("details", "unreachable");
        det.appendChild(el("summary", null, "Show " + unreachable.length + " out-of-reach options"));
        det.appendChild(tableFor(unreachable, opts));   // out-of-reach: plain (non-sortable) table
        body.appendChild(det);
      }
    }
    body.addEventListener("click", function (e) {
      var th = e.target.closest && e.target.closest("th[data-sort]");
      if (!th) return;
      var col = th.getAttribute("data-sort");
      if (col === "rec") sortState = { col: "rec", dir: 1 };
      else if (col === sortState.col) sortState = { col: col, dir: -sortState.dir };
      else sortState = { col: col, dir: 1 };
      if (opts.onSort) opts.onSort(resEncodeSort(sortState));
      paint();
    });
    paint();
  }

  function bandTag(b) { return '<span class="tag tag-' + b.toLowerCase() + '">' + b + "</span>"; }

  var QE_STRATS = [
    { k: "safe", t: "Safe", d: "Only the seats you can comfortably get, most sought-after first &mdash; your reliable list (no stretch picks)." },
    { k: "balanced", t: "Balanced", d: "A realistic spread: a few stretch picks (popular colleges that rarely reach this round) up top, then the strongest seats you can comfortably get." },
    { k: "greedy", t: "Greedy", d: "Aspirational: a long list led by the most sought-after colleges (incl. ones that rarely leave seats for this round), down to comfortable anchors so you&rsquo;re never unallotted." },
  ];
  function qeByDemand(a, b) {
    var ao = a.opening == null ? 9e9 : a.opening, bo = b.opening == null ? 9e9 : b.opening;
    return (ao - bo) || ((a.closing || 9e9) - (b.closing || 9e9)) ||
      (a.college || "").localeCompare(b.college || "") || (a.branch || "").localeCompare(b.branch || "");
  }
  function qeNearMiss(a, b) { return (b.margin || -9e9) - (a.margin || -9e9); }
  function dedupeQe(arr) {   // QE rows have no bid; key on (college, branch, pool, gender)
    var seen = {}, out = [];
    arr.forEach(function (r) {
      var k = r.cid + "|" + r.branch + "|" + r.social + "|" + r.gender;
      if (!seen[k]) { seen[k] = 1; out.push(r); }
    });
    return out;
  }
  // Three choice-list strategies. The Qualifying-Exam round runs on LEFTOVER seats, so the band
  // metric collapses (a decent rank clears almost everything -> nearly all "Safe"). What actually
  // separates the strategies is BREADTH and whether you lead with STRETCH picks (popular colleges
  // that usually fill before this round). Stretch picks are PINNED at the top (most-sought-after
  // first) and NOT re-sorted into the body, so the three lists read as visibly different.
  function qeChoicePicks(reachable, unreachable, strategy) {
    var pref = function (list) { return list.slice().sort(qeByDemand); };
    var safe = reachable.filter(function (r) { return r.band === "Safe"; }).sort(qeByDemand);
    // "comfortable" pool: Safe-band seats, or (for a weaker rank with none) the surest reachable ones.
    var comfy = safe.length ? safe
      : pref(reachable.slice().sort(qeNearMiss).slice(0, 15));
    if (strategy === "safe") return dedupeQe(comfy).slice(0, CHOICE_CAP);
    if (strategy === "balanced") {
      var dreams = pref(unreachable).slice(0, 3);                       // stretch picks, pinned on top
      var body = dedupeQe(dreams.concat(pref(reachable))).slice(0, 13); // + most-sought-after reachable
      return dedupeQe(body.concat(comfy.slice(0, 2)));                  // + comfortable anchors (no re-sort)
    }
    // greedy: a long aspirational list — top dreams + nearest misses pinned, then everything reachable
    var dreams2 = dedupeQe(pref(unreachable).slice(0, 10).concat(unreachable.slice().sort(qeNearMiss).slice(0, 6)));
    var body2 = dedupeQe(dreams2.concat(pref(reachable))).slice(0, 28);
    return dedupeQe(body2.concat(comfy.slice(0, 3)));
  }
  function qeChoicePool(r) {
    var p = r.tfw ? "TFW" : (r.social || "UR");
    return r.gender === "F" ? p + " Female" : p;
  }
  function renderQeChoiceList(reachable, unreachable, container, opts) {
    var sug = el("details", "choice-suggest");
    var sugSummary = el("summary", "choice-summary", "Choice-filling list");
    var sugBody = el("div", "choice-body");
    sug.appendChild(sugSummary);
    var pick = el("div", "strat-pick");
    pick.appendChild(el("span", "strat-lbl", "Choice-list strategy:"));
    QE_STRATS.forEach(function (s) {
      var btn = el("button", "strat-btn", s.t); btn.type = "button"; btn.setAttribute("data-strat", s.k);
      pick.appendChild(btn);
    });
    sugBody.appendChild(pick);
    var head = el("div", "choice-head");
    var countEl = el("span", "round-count", "0");
    var title = el("h2", null, "Your choice-filling list ");
    title.appendChild(countEl);
    var copyBtn = el("button", "btn-copy", "Copy list"); copyBtn.type = "button";
    head.appendChild(title);
    head.appendChild(copyBtn); sugBody.appendChild(head);
    var desc = el("p", "muted strat-desc");
    var ol = el("ol", "choice-order");
    sugBody.appendChild(desc); sugBody.appendChild(ol);
    sug.appendChild(sugBody); container.appendChild(sug);

    var lines = [];
    function renderList(strategy) {
      var picks = qeChoicePicks(reachable, unreachable, strategy);
      var stratMeta = (QE_STRATS.filter(function (s) { return s.k === strategy; })[0] || {});
      ol.innerHTML = ""; lines = [];
      picks.forEach(function (r, i) {
        var li = el("li");
        li.innerHTML = "<span class='co-name'>" + coLink(r.cid, r.college) + "</span> &mdash; " + esc(r.branch) +
          " <span class='pool muted'>" + esc(qeChoicePool(r)) + "</span>" +
          " <span class='co-rd sub'>" + (r.band === "Unreachable" ? "stretch" : r.band) +
          " &middot; opens ~" + fmt(r.opening) + " &middot; closes ~" + fmt(r.closing) +
          " &middot; " + esc(fmtFeeRecord(r.fee)) + "</span>";
        ol.appendChild(li);
        lines.push((i + 1) + ". " + r.college + " — " + r.branch + " [" + qeChoicePool(r) + "]  (" +
          (r.band === "Unreachable" ? "stretch" : r.band) + ", opens ~" + fmt(r.opening) +
          ", closes ~" + fmt(r.closing) + ", fee " + fmtFeeRecord(r.fee) + ")");
      });
      countEl.textContent = picks.length;
      sugSummary.innerHTML = "Choice-filling list <span class='round-count'>" + picks.length + "</span> <span class='sub-inline'>" + esc(stratMeta.t || strategy) + "</span>";
      desc.innerHTML = stratMeta.d + " Fill them on the DTE portal <strong>in this order</strong> (best first).";
      Array.prototype.forEach.call(pick.querySelectorAll(".strat-btn"), function (b) {
        b.classList.toggle("active", b.getAttribute("data-strat") === strategy);
      });
    }
    pick.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".strat-btn");
      if (b) { var s = b.getAttribute("data-strat"); renderList(s); if (opts.onChoiceStrategy) opts.onChoiceStrategy(s); }
    });
    renderList(opts.choiceStrategy || "balanced");
    copyBtn.addEventListener("click", function () {
      var text = lines.join("\n");
      var done = function () { copyBtn.textContent = "Copied ✓"; setTimeout(function () { copyBtn.textContent = "Copy list"; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else { var ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e2) {} document.body.removeChild(ta); done(); }
    });
  }

  // ---- 12th-% predictor results table: columns + click-to-sort (one flat table) ----
  var RES_COLS = [
    { k: "rec", h: "#", cls: "num" }, { k: "college", h: "College" }, { k: "city", h: "City" },
    { k: "branch", h: "Branch" }, { k: "type", h: "Type" },
    { k: "opening", h: "Opening rank", cls: "num", sub: "demand" },
    { k: "closing", h: "Closing rank", cls: "num", sub: "chance" },
    { k: "fee", h: "Fee", cls: "num", sub: "source unit" },
    { k: "seats", h: "Seats", cls: "num", sub: "(TFW)" }, { k: "chance", h: "Chance" }
  ];
  var RES_KEYS = {}; RES_COLS.forEach(function (c) { RES_KEYS[c.k] = 1; });
  var RES_BAND = { Safe: 0, Moderate: 1, Reach: 2, Unreachable: 3 };
  function resHead(sort) {   // sort = {col,dir} -> clickable headers; falsy -> plain (out-of-reach table)
    return "<thead><tr>" + RES_COLS.map(function (c) {
      var active = sort && sort.col === c.k;
      var ar = (active && c.k !== "rec") ? " <span class='sort-ar'>" + (sort.dir < 0 ? "&darr;" : "&uarr;") + "</span>" : "";
      var cls = [c.cls || "", sort ? "sortable" : "", active ? "sorted" : ""].filter(Boolean).join(" ");
      return "<th" + (cls ? " class='" + cls + "'" : "") + (sort ? " data-sort='" + c.k + "'" : "") + ">" +
        c.h + (c.sub ? "<br><span class='sub'>" + c.sub + "</span>" : "") + ar + "</th>";
    }).join("") + "</tr></thead>";
  }
  function resKey(r, col) {
    if (col === "opening") return (r.opening == null ? 9e9 : r.opening);
    if (col === "closing") return (r.closing == null ? 9e9 : r.closing);
    if (col === "fee") return feeAmount(r.fee);
    if (col === "seats") return (r.seats && r.seats.total) || 0;
    if (col === "chance") return RES_BAND[r.band] || 0;
    return (r[col] || "").toString().toLowerCase();   // college / city / branch / type
  }
  function resSort(rows, st) {
    if (!st || st.col === "rec") return rows;          // "rec" = the recommended order (band, then margin)
      return rows.slice().sort(function (a, b) {
        var ka = resKey(a, st.col), kb = resKey(b, st.col);
        if (st.col === "fee") {
          if (ka == null && kb == null) return 0;
          if (ka == null) return 1;
          if (kb == null) return -1;
        }
        var c = (typeof ka === "string") ? ka.localeCompare(kb) : (ka - kb);
      return c * st.dir;
    });
  }
  function resParseSort(s) {
    var m = /^(.+)-(asc|desc)$/.exec(s || "");
    return (m && RES_KEYS[m[1]] && m[1] !== "rec") ? { col: m[1], dir: m[2] === "desc" ? -1 : 1 } : { col: "rec", dir: 1 };
  }
  function resEncodeSort(st) { return st.col === "rec" ? "rec" : st.col + (st.dir < 0 ? "-desc" : "-asc"); }

  function tableFor(rows, opts, sort) {
    var wrap = el("div", "table-wrap");
    var t = el("table", "results");
    t.innerHTML = resHead(sort);
    var tb = el("tbody"), n = 0;
    rows.forEach(function (r) {
      n += 1;
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
        "<td class='num pref-no'>" + n + "</td>" +
        "<td>" + esc(r.college) + hist + coCta(r.cid) + "</td>" +
        "<td>" + esc(r.city) + "</td>" +
        "<td>" + esc(r.branch) + pool + "</td>" +
        "<td>" + esc(r.type) + "</td>" +
        "<td class='num'>" + fmt(r.opening) + " <span class='sub'>first admitted</span></td>" +
        "<td class='num'>" + fmt(r.closing) + " <span class='sub'>" + r.year + " " + esc(r.round) + "</span></td>" +
        "<td class='num'>" + feeHtml(r.fee) + "</td>" +
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

  // TFW is MP-domicile only: disable + uncheck the TFW box whenever domicile = Other state.
  function lockTfwByDomicile(domEl, tfwEl) {
    if (!domEl || !tfwEl) return;
    function sync() {
      var other = domEl.value === "other";
      if (other) tfwEl.checked = false;
      tfwEl.disabled = other;
      var lab = tfwEl.closest ? tfwEl.closest("label") : null;
      if (lab) { lab.classList.toggle("disabled", other); lab.title = other ? "Tuition Fee Waiver is for MP-domicile candidates only" : ""; }
    }
    domEl.addEventListener("change", sync); sync();
  }

  /* ---------- context assembly ---------- */
  function buildContext(colleges, branches, cities, intake, config) {
    var byId = {}; colleges.colleges.forEach(function (c) { byId[c.id] = c; });
    var label = {}; branches.branches.forEach(function (b) { label[b.id] = b.label; });
    return {
      colleges: byId, branchLabel: label, branches: branches.branches,
      cities: cities.cities, intake: intake.seats, config: config,
      types: colleges.types || [], fees: null,
    };
  }

  /* ---------- page: predictor (JEE or QE) ---------- */
  function initPredictor(mode) {
    var form = document.getElementById("predict-form");
    var results = document.getElementById("results");
    var filtersBox = document.getElementById("filters");
    var formMsg = document.getElementById("form-msg");
    var assets = ["colleges", "branches", "cities", "intake", "config",
      mode === "qe" ? "predictor_qe" : "predictor_jee", "fees"];
    loadAll(assets).then(function (a) {
      var ctx = buildContext(a[0], a[1], a[2], a[3], a[4]);
      var pred = a[5];
      ctx.fees = a[6] || null;
      var fc = buildFilters(ctx, filtersBox, {
        fwLabelHtml: "Include Tuition Fee Waiver (TFW) seats (family income ≤ ₹8 L)"
      });
      // QE: populate year selector with available years; show banner
      if (mode === "qe") {
        var ysel = document.getElementById("f-year");
        pred.years.forEach(function (y) { ysel.appendChild(new Option(y, y)); });
        var wantY = parseInt(qsParams().year, 10);                       // honor ?year=, snapping to nearest available
        ysel.value = (!isNaN(wantY) && pred.years.indexOf(wantY) > -1) ? wantY
          : (!isNaN(wantY) ? pred.years.reduce(function (b, y) { return Math.abs(y - wantY) < Math.abs(b - wantY) ? y : b; }, pred.years[0])
            : pred.years[pred.years.length - 1]);
      }
      var p = qsParams();
      var curSort = p.sort || "rec";
      var curChoiceStrat = p.strat || "balanced";
      function setSort(s) { curSort = s; var u = new URLSearchParams(location.search); u.set("sort", s); history.replaceState(null, "", location.pathname + "?" + u); }
      function setChoiceStrat(s) { curChoiceStrat = s; var u = new URLSearchParams(location.search); u.set("strat", s); history.replaceState(null, "", location.pathname + "?" + u); }
      function setVal(id, v) { var e = document.getElementById(id); if (e && v != null && v !== "") e.value = v; }
      setVal("in-rank", p.rank); setVal("in-pct", p.pct); setVal("in-cat", p.cat);
      setVal("in-gender", p.gender); setVal("in-dom", p.dom);
      if (p.city) fc.city.value = p.city;
      if (p.branch) fc.branch.value = p.branch;
      if (p.type) fc.type.value = p.type;
      if (p.fee) fc.fee.value = p.fee;
      if (p.tfw) fc.fw.checked = true;
      lockTfwByDomicile(document.getElementById("in-dom"), fc.fw);   // TFW is MP-domicile only

      function run(e) {
        if (e) e.preventDefault();
        var social = document.getElementById("in-cat").value;
        var gEl = document.getElementById("in-gender"), dEl = document.getElementById("in-dom");
        var opts = {
          social: social, gender: gEl ? gEl.value : "M", domicile: dEl ? dEl.value : "other",
          tfw: fc.fw.checked, city: fc.city.value || null, type: fc.type.value || null,
          feeRange: fc.fee.value || "",
          branchSet: fc.branch.value ? (function () { var s = {}; s[fc.branch.value] = 1; return s; })() : null,
          sort: curSort, onSort: setSort,
        };
        var stateP = { cat: social, gender: opts.gender, dom: opts.domicile, tfw: opts.tfw ? 1 : "",
          city: fc.city.value, branch: fc.branch.value, type: fc.type.value, fee: opts.feeRange,
          sort: curSort === "rec" ? "" : curSort };
        if (mode === "qe") {
          var pctEl = document.getElementById("in-pct");
          var pct = parseFloat(pctEl.value);
          var yr = parseInt(document.getElementById("f-year").value, 10);
          if (isNaN(pct) || pct < 0 || pct > 100) {
            setFormMsg(formMsg, "Enter a valid Class-XII % between 0 and 100.", true);
            results.innerHTML = "";
            pctEl.focus();
            if (pctEl.scrollIntoView) pctEl.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
          }
          setFormMsg(formMsg, "", false);
          opts.choiceList = true;
          opts.choiceStrategy = curChoiceStrat;
          opts.onChoiceStrategy = setChoiceStrat;
          opts.year = yr;
          opts.rank = meritRankForPct(pred, yr, pct);
          stateP.pct = pct; stateP.year = yr; stateP.strat = curChoiceStrat === "balanced" ? "" : curChoiceStrat;
          var est = el("p", "rank-est", "Your estimated qualifying-exam merit rank for " + yr +
            ": <strong>" + fmt(opts.rank) + "</strong> (from " + pct + "%).");
          results.innerHTML = ""; results.appendChild(est);
          var r1 = predict(ctx, pred, opts);
          var holder = el("div"); renderResults(r1, holder, opts); results.appendChild(holder);
        } else {
          var rankEl = document.getElementById("in-rank");
          var rawRank = (rankEl.value || "").trim();
          var rank = parseInt(rawRank, 10);
          if (!/^\d+$/.test(rawRank) || isNaN(rank) || rank < 1) {
            setFormMsg(formMsg, "Enter your JEE rank &mdash; a whole number 1 or higher.", true);
            results.innerHTML = "";
            rankEl.focus();
            if (rankEl.scrollIntoView) rankEl.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
          }
          setFormMsg(formMsg, "", false);
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
      else setFormMsg(formMsg, mode === "qe" ? "Enter your Class-XII percentage, then Show my colleges." : "Enter your JEE rank, then Show colleges.", false);
    }).catch(function (e) { showError(results, e); });
  }

  /* ---------- page: college explorer ---------- */
  function initExplorer() {
    var results = document.getElementById("results");
    var filtersBox = document.getElementById("filters");
    loadAll(["colleges", "branches", "cities", "intake", "fees"]).then(function (a) {
      var ctx = buildContext(a[0], a[1], a[2], a[3], {});
      ctx.fees = a[4] || null;
      var fc = buildFilters(ctx, filtersBox, {
        fwLabelHtml: "Only colleges offering Tuition Fee Waiver (TFW) seats",
        search: true, searchPlaceholder: "Type a college name or city…", domicile: true, sort: true });
      lockTfwByDomicile(fc.dom, fc.fw);   // TFW is MP-domicile only — disable the filter for non-MP
      function run() {
        var city = fc.city.value, type = fc.type.value, bid = fc.branch.value;
        var dom = fc.dom ? fc.dom.value : "mp";
        var fwOnly = fc.fw.checked && dom !== "other";   // non-MP students can't get TFW seats
        var feeRange = fc.fee.value || "", sort = fc.sort ? fc.sort.value : "name";
        var q = (fc.search && fc.search.value || "").trim().toLowerCase();
        var list = a[0].colleges.filter(function (c) {
          if (c.historical) return false;           // explorer shows current 2026-27 colleges only
          if (q && (c.name || "").toLowerCase().indexOf(q) < 0 && (c.city || "").toLowerCase().indexOf(q) < 0) return false;
          if (city && c.city !== city) return false;
          if (type && c.type !== type) return false;
          var seats = ctx.intake[c.id] || {};
          if (bid && !seats[bid]) return false;
          if (!feeInRange(feeFor(ctx, c.id, bid || null), feeRange)) return false;
          if (fwOnly) {
            var anyTfw = Object.keys(seats).some(function (b) { return seats[b].tfw > 0; });
            if (!anyTfw) return false;
          }
          return true;
        });
        results.innerHTML = "";
        if (dom === "other") {
          var openN = list.filter(function (c) { return nonMpOpen(c.type); }).length;
          results.appendChild(el("div", "banner banner-info",
            "<strong>Non-MP domicile:</strong> MP counselling keeps ~85&ndash;90% of seats for MP-domicile candidates, " +
            "and reservation, fee-waiver and the female pool don&rsquo;t apply to you. You can take the " +
            "<strong>general (UR) seats at private / self-financing colleges</strong>, but only the <strong>5% All-India seats</strong> " +
            "at government, aided and university institutes. Each college is tagged with what&rsquo;s open to you below " +
            "(<strong>" + openN + "</strong> of " + list.length + " are private/self-financing). Verify with DTE."));
        }
        results.appendChild(el("p", "result-summary", "<strong>" + list.length + "</strong> colleges"));
        list.sort(function (x, y) {
          if (sort === "fee-asc" || sort === "fee-desc") {
            var xf = feeAmount(feeFor(ctx, x.id, bid || null)), yf = feeAmount(feeFor(ctx, y.id, bid || null));
            if (xf == null && yf == null) return 0;
            if (xf == null) return 1;
            if (yf == null) return -1;
            return sort === "fee-asc" ? xf - yf : yf - xf;
          }
          if (sort === "seats-desc") {
            var xs = Object.keys(ctx.intake[x.id] || {}).reduce(function (s, b) { return s + ((ctx.intake[x.id] || {})[b].total || 0); }, 0);
            var ys = Object.keys(ctx.intake[y.id] || {}).reduce(function (s, b) { return s + ((ctx.intake[y.id] || {})[b].total || 0); }, 0);
            return ys - xs || (x.name || "").localeCompare(y.name || "");
          }
          return (x.name || "").localeCompare(y.name || "");
        });
        list.forEach(function (c) {
          var seats = ctx.intake[c.id] || {};
          var card = el("div", "college-card");
          var totalSeats = Object.keys(seats).reduce(function (s, b) { return s + (seats[b].total || 0); }, 0);
          var fee = feeFor(ctx, c.id, bid || null);
          var branchChips = Object.keys(seats).map(function (b) {
            var s = seats[b];
            return "<span class='chip'>" + esc(ctx.branchLabel[b] || b) + " <em>" + s.total +
              (dom !== "other" && s.tfw ? "/" + s.tfw + " TFW" : "") + "</em></span>";   // TFW hidden for non-MP (can't get it)
          }).join("");
          var meta = [c.city, c.type, c.university, totalSeats + " seats"]
            .filter(function (x) { return x != null && x !== ""; })
            .map(function (x) { return esc(String(x)); }).join(" &middot; ");   // join only non-empty (no leading separator for null city)
          var access = (dom === "other")
            ? (nonMpOpen(c.type)
              ? "<p class='co-access'><span class='pool' title='Private / self-financing — its general (UR) seats are open to non-MP students'>Open to non-MP &mdash; general seats</span></p>"
              : "<p class='co-access'><span class='pool muted' title='Government / aided / university — only the 5% All-India seats are open to non-MP students'>All-India seats only (~5%)</span></p>")
            : "";
          var href = BASE + "/college/?id=" + encodeURIComponent(c.id);
          card.innerHTML = "<h3><a href='" + href + "'>" + esc(c.name) + "</a></h3>" +
            "<p class='muted'>" + meta + "</p>" + access +
            "<p class='co-fee'><strong>Fee:</strong> " + feeHtml(fee) + "</p>" +
            "<div class='chips'>" + branchChips + "</div>";
          card.style.cursor = "pointer";   // whole card opens the college page (title already links too)
          card.addEventListener("click", function (e) { if (!e.target.closest("a")) location.href = href; });
          results.appendChild(card);
        });
      }
      filtersBox.addEventListener("change", run);
      if (fc.search) fc.search.addEventListener("input", run);   // live search as you type
      run();
    }).catch(function (e) { showError(results, e); });
  }

  /* ---------- home quick form ---------- */
  function initHome() {
    var dv = document.getElementById("data-version");
    load("config").then(function (c) { if (dv) dv.textContent = "data " + c.data_version; }).catch(function () {});
  }

  /* ---------- page: single-college cut-off history ---------- */
  var ROUND_LABEL = { RF: "First Round", FR: "First Round", FU: "First-Round Upgrade",
    SR: "Second Round", QR: "Qualifying-Exam Round", TR: "Qualifying-Exam (TFW)" };
  // counselling sequence, so sorting the Round column is chronological, not alphabetical
  var ROUND_ORDER = { RF: 1, FR: 1, FU: 2, SR: 3, QR: 4, TR: 5 };
  var GENDER_LABEL = { OP: "Open", F: "Female", M: "Male" };
  // split a pool code (SOCIAL[/CLASS]/GENDER, e.g. UR/X/OP, FW/OP, EWS) into its dimensions,
  // mirroring preprocess.py's social_of / class_of / gender_of so the filters match the engine.
  function parsePool(pool) {
    var p = String(pool || "").split("/");
    var gen = (p.length >= 3) ? p[2] : (p.length === 2 ? p[1] : "");
    gen = (gen || "").trim().toUpperCase();
    return {
      soc: (p[0] || "").trim(),
      cls: (p.length >= 3) ? (p[1] || "").trim().toUpperCase() : "",
      gen: (gen === "F" || gen === "M") ? gen : "OP",
    };
  }
  function uniqSort(arr) {
    return Array.from(new Set(arr)).sort(function (a, b) { return String(a).localeCompare(String(b)); });
  }
  function initCollege() {
    var head = document.getElementById("college-head");
    var results = document.getElementById("results");
    var id = qsParams().id;
    if (!id || !/^[A-Za-z0-9]{1,8}$/.test(id)) {        // ids are short alphanumerics (474, 003, h20); reject anything else
      head.innerHTML = "<p class='empty'>No college selected. <a href='" + BASE +
        "/college-explorer/'>Browse colleges</a>.</p>";
      return;
    }
    Promise.all([load("branches"), load("history/" + id), load("fees").catch(function () { return null; })]).then(function (a) {
      var branchLabel = {};
      a[0].branches.forEach(function (b) { branchLabel[b.id] = b.label; });
      var H = a[1], feeData = a[2], rows = H.rows, ix = {};
      H.cols.forEach(function (c, i) { ix[c] = i; });

      document.title = H.name + " · cut-off history";
      var meta = [H.city, H.type, H.university].filter(Boolean).map(esc).join(" &middot; ");
      head.innerHTML =
        "<p class='crumb'><a href='" + BASE + "/college-explorer/'>&larr; All colleges</a></p>" +
        "<h1 class='page-title'>" + esc(H.name) + "</h1>" +
        "<p class='page-subtitle'>" + meta + "</p>" +
        "<p class='muted'>Official DTE opening &amp; closing ranks, " + H.years[0] + "&ndash;" +
        H.years[H.years.length - 1] + ". <strong>JEE</strong> rounds use the JEE-Main rank; " +
        "<strong>Qualifying-Exam</strong> rounds use the 12th-% merit rank &mdash; different scales, " +
        "never compare a rank across the two.</p>";

      var feeCol = feeData && feeData.colleges && feeData.colleges[id];
      var feeBox = el("details", "fee-history");
      if (feeCol) {
        var frows = [], seenFee = {};
        function addFeeRecord(r, bid) {
          var key = r.year + "|" + (bid || "") + "|" + r.semester_fee_rs + "|" + (r.raw_fee_text || "");
          if (seenFee[key]) return;
          seenFee[key] = 1;
          frows.push({
            year: r.year, session: r.session, bid: bid || r.branch_id || "",
            fee: r.semester_fee_rs, raw: r.raw_fee_text || "",
            period: r.fee_period || "",
            source: r.source || "", source_label: r.source_label || r.source || "", source_url: r.source_url || "",
          });
        }
        Object.keys(feeCol.years || {}).forEach(function (y) {
          (feeCol.years[y] || []).forEach(function (r) { addFeeRecord(r, ""); });
        });
        Object.keys(feeCol.branches || {}).forEach(function (bid) {
          var bdat = feeCol.branches[bid] || {};
          Object.keys(bdat.years || {}).forEach(function (y) {
            (bdat.years[y] || []).forEach(function (r) { addFeeRecord(r, bid); });
          });
        });
        frows.sort(function (a, b) {
          return (b.year - a.year) || (a.bid || "").localeCompare(b.bid || "");
        });
        var latestSummaryRecord = feeCol.latest || null;
        if (!latestSummaryRecord && frows.length) latestSummaryRecord = {
          semester_fee_rs: frows[0].fee,
          fee_period: frows[0].period,
        };
        var seenFeeYears = {}, yearOptions = "<option value=''>All sessions</option>";
        frows.forEach(function (r) {
          var y = String(r.year || "");
          if (!y || seenFeeYears[y]) return;
          seenFeeYears[y] = 1;
          yearOptions += "<option value='" + esc(y) + "'>" + esc(r.session || y) + "</option>";
        });
        var feeRows = frows.map(function (r) {
          var rawNote = String(r.raw || "");
          var plain = rawNote === String(r.fee) ? "<span class='muted'>—</span>" : esc(rawNote);
          var source = r.source_url
            ? "<a href='" + esc(r.source_url) + "' rel='noopener' target='_blank'>" + esc(r.source_label || r.source || "Source") + "</a>"
            : esc(r.source_label || r.source || "—");
          return "<tr data-fee-year='" + esc(r.year) + "'><td class='num'>" + esc(r.session || r.year) + "</td>" +
            "<td>" + (r.bid ? esc(branchLabel[r.bid] || r.bid) : "College-level / default") + "</td>" +
            "<td class='num'>₹" + fmt(r.fee) + "<span class='sub'>" + feePeriodLong({ fee_period: r.period }) + "</span></td>" +
            "<td>" + plain + "</td><td>" + source + "</td></tr>";
        }).join("");
        feeBox.innerHTML = "<summary><span>Fee history</span><span class='fee-summary'>Latest " +
          esc(fmtFeeRecord(latestSummaryRecord)) + "</span></summary>" +
          "<div class='fee-history-panel'><p class='muted'>Accepted fee matches, shown in the source unit. " +
          "Before relying on any amount, cross-check once with the official college or fee source linked here.</p>" +
          "<label class='fee-year-filter'>Session <select id='fee-year-filter'>" + yearOptions + "</select></label>" +
          "<div class='table-wrap'><table class='results fee-table'><thead><tr><th class='num'>Session</th><th>Branch</th>" +
          "<th class='num'>Fee</th><th>Fee note</th><th>Source</th></tr></thead><tbody>" + feeRows + "</tbody></table></div>" +
          "<p class='empty fee-empty' hidden>No fee records for the selected session.</p></div>";
        var feeYear = feeBox.querySelector("#fee-year-filter");
        var feeEmpty = feeBox.querySelector(".fee-empty");
        function filterFeeHistory() {
          var y = feeYear ? feeYear.value : "", shown = 0;
          Array.prototype.forEach.call(feeBox.querySelectorAll("tbody tr"), function (tr) {
            var ok = !y || tr.getAttribute("data-fee-year") === y;
            tr.hidden = !ok;
            if (ok) shown++;
          });
          if (feeEmpty) feeEmpty.hidden = shown > 0;
        }
        if (feeYear) feeYear.addEventListener("change", filterFeeHistory);
        filterFeeHistory();
      } else {
        feeBox.innerHTML = "<summary><span>Fee history</span><span class='fee-summary'>No fee match</span></summary>" +
          "<div class='fee-history-panel'><p class='empty'>No accepted fee match yet for this college. " +
          "Do not force-match doubtful fee rows; cross-check the official college or fee source before using a fee publicly.</p></div>";
      }
      head.appendChild(feeBox);

      var parsed = rows.map(function (r) { return parsePool(r[ix.pool]); });
      var branches = uniqSort(rows.map(function (r) { return r[ix.b]; }));
      var years = H.years.slice().sort(function (x, y) { return y - x; });
      var cats = uniqSort(parsed.map(function (p) { return p.soc; }));
      var genders = uniqSort(parsed.map(function (p) { return p.gen; }));                 // OP / F / M
      var quotas = uniqSort(parsed.map(function (p) { return p.cls; })                    // FF / D / NCC / S …
        .filter(function (c) { return c && c !== "X"; }));
      function optList(opts, fmtOpt) {
        return "<option value=''>All</option>" + opts.map(function (o) {
          return "<option value='" + esc(o) + "'>" + esc(fmtOpt ? fmtOpt(o) : o) + "</option>";
        }).join("");
      }
      var bar = el("div", "hist-filters");
      bar.innerHTML =
        "<label>Branch <select id='f-branch'>" + optList(branches, function (b) { return branchLabel[b] || b; }) + "</select></label>" +
        "<label>Year <select id='f-year'>" + optList(years) + "</select></label>" +
        "<label>Round type <select id='f-uni'><option value=''>All</option><option value='jee'>JEE rounds</option><option value='qe'>Qualifying-Exam</option></select></label>" +
        "<label>Domicile <select id='f-dom'><option value='mp'>MP (domicile)</option><option value='other'>Other state</option></select></label>" +
        "<label>Category <select id='f-cat'>" + optList(cats) + "</select></label>" +
        "<label>Gender <select id='f-gen'>" + optList(genders, function (g) { return GENDER_LABEL[g] || g; }) + "</select></label>" +
        "<label>Special quota <select id='f-quota'>" + optList(quotas, function (q) { return QUOTA_LABEL[q] || q; }) + "</select></label>" +
        "<label class='chk'><input type='checkbox' id='f-fw'> TFW only</label>";
      head.appendChild(bar);
      var fBranch = bar.querySelector("#f-branch"), fYear = bar.querySelector("#f-year"),
        fUni = bar.querySelector("#f-uni"), fCat = bar.querySelector("#f-cat"), fFw = bar.querySelector("#f-fw"),
        fGen = bar.querySelector("#f-gen"), fQuota = bar.querySelector("#f-quota"), fDom = bar.querySelector("#f-dom");
      var priv = nonMpOpen(H.type);   // private/self-financing → general seats open to non-MP; else AI-only
      // default to JEE rounds so the closing-rank sort never interleaves the two (incomparable)
      // rank scales; fall back to All if this college has no JEE rows.
      if (rows.some(function (r) { return r[ix.uni] === "jee"; })) fUni.value = "jee";

      var COLDEF = [
        { k: "yr", h: "Year", cls: "num" },
        { k: "b", h: "Branch", fmt: function (v) { return esc(branchLabel[v] || v); } },
        { k: "pool", h: "Pool", fmt: function (v) { return v ? esc(v) : "—"; } },
        { k: "dom", h: "Domicile", fmt: function (v) { return esc(v || "—"); } },
        { k: "fw", h: "TFW", cls: "num", fmt: function (v) { return v ? "Yes" : ""; } },
        { k: "op", h: "Opening", cls: "num", fmt: fmt },
        { k: "cl", h: "Closing", cls: "num", fmt: fmt },
        { k: "al", h: "Seats", cls: "num", fmt: fmt },
        { k: "rd", h: "Round", fmt: function (v) { return esc(ROUND_LABEL[v] || v); } },
      ];
      var sortCol = "cl", sortDir = 1;

      function render() {
        var fb = fBranch.value, fy = fYear.value, fu = fUni.value, fc = fCat.value, ff = fFw.checked;
        var fg = fGen ? fGen.value : "", fq = fQuota ? fQuota.value : "", fd = fDom ? fDom.value : "mp";
        var list = rows.filter(function (r, i) {
          var p = parsed[i];
          if (fb && r[ix.b] !== fb) return false;
          if (fy && String(r[ix.yr]) !== fy) return false;
          if (fu && r[ix.uni] !== fu) return false;
          if (fc && p.soc !== fc) return false;
          if (fg && p.gen !== fg) return false;
          if (fq && p.cls !== fq) return false;
          if (ff && !r[ix.fw]) return false;
          if (fd === "other") {
            // non-MP-domicile: All-India seats are open everywhere; otherwise only the open/general
            // (UR, non-female, non-TFW) seats at a PRIVATE college. Reservation, fee-waiver, female
            // and government home-state seats are MP-domicile only.
            var isAI = r[ix.dom] === "AI";
            var openGen = p.soc === "UR" && p.gen !== "F" && !r[ix.fw];
            if (!(isAI || (openGen && priv))) return false;
          }
          return true;
        });
        var si = ix[sortCol];
        list.sort(function (x, y) {
          var a = x[si], b = y[si];
          if (sortCol === "rd") return sortDir * ((ROUND_ORDER[a] || 99) - (ROUND_ORDER[b] || 99));
          if (typeof a === "string" || typeof b === "string") return sortDir * String(a).localeCompare(String(b));
          return sortDir * ((a == null ? Infinity : a) - (b == null ? Infinity : b));
        });
        var thead = "<thead><tr>" + COLDEF.map(function (c) {
          var arrow = c.k === sortCol ? (sortDir > 0 ? " &#9650;" : " &#9660;") : "";
          return "<th class='" + (c.cls || "") + " sortable' data-k='" + c.k + "'>" + c.h + arrow + "</th>";
        }).join("") + "</tr></thead>";
        var body = "<tbody>" + list.map(function (r) {
          return "<tr>" + COLDEF.map(function (c) {
            var v = r[ix[c.k]];
            return "<td class='" + (c.cls || "") + "'>" + (c.fmt ? c.fmt(v, r) : (v == null ? "—" : v)) + "</td>";
          }).join("") + "</tr>";
        }).join("") + "</tbody>";
        var domBanner = (fd === "other")
          ? "<div class='banner banner-info'><strong>Non-MP domicile:</strong> " + (priv
              ? "this is a private / self-financing college, so its <strong>general (UR) seats</strong> are open to you &mdash; reservation (SC/ST/OBC/EWS), fee-waiver and the female pool are MP-domicile-only and are hidden."
              : "this is a government / university institute, so only the <strong>5% All-India seats</strong> are open to you &mdash; MP home-state seats (most of the intake) are hidden.") +
            " Verify with DTE.</div>"
          : "";
        results.innerHTML = domBanner + "<p class='result-summary'><strong>" + list.length + "</strong> record" +
          (list.length === 1 ? "" : "s") + " <span class='muted'>(click a column to sort)</span></p>" +
          "<div class='table-wrap'><table class='results hist-table'>" + thead + body + "</table></div>";
        Array.prototype.forEach.call(results.querySelectorAll("th.sortable"), function (th) {
          th.addEventListener("click", function () {
            var k = th.getAttribute("data-k");
            if (k === sortCol) sortDir = -sortDir; else { sortCol = k; sortDir = 1; }
            render();
          });
        });
      }
      bar.addEventListener("change", render);
      render();
    }).catch(function () {
      head.innerHTML = "<p class='crumb'><a href='" + BASE + "/college-explorer/'>&larr; All colleges</a></p>";
      results.innerHTML = "<p class='empty'>No historical cut-off records found for this college " +
        "(id " + esc(id) + ").</p>";
    });
  }

  /* ---------- page: model accuracy (backtest) ---------- */
  function initAccuracy() {
    var box = document.getElementById("accuracy");
    if (!box) return;
    load("backtest").then(function (b) {
      // keep the prose headline figures in sync with the live backtest (so they can't go stale)
      var accFill = { "jee-within20": b.jee.overall.pct_within_20 + "%", "qe-within20": b.qe.overall.pct_within_20 + "%",
        "cov-pool": "~" + Math.round(b.jee.coverage_pool_pct) + "%", "cov-seat": "~" + Math.round(b.jee.coverage_seat_pct) + "%" };
      Object.keys(accFill).forEach(function (k) {
        Array.prototype.forEach.call(document.querySelectorAll("[data-acc='" + k + "']"), function (e) { e.textContent = accFill[k]; });
      });
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
    else if (page === "college") initCollege();
    else if (page === "accuracy") initAccuracy();
    else if (page === "branchrank") initBranchRankings();
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
