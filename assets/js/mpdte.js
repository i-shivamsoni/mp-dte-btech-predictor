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

  /* opts: {rank, social, fwOnly, city, branchSet|null, type, year|null} */
  function predict(ctx, pred, opts) {
    var ci = colIndex(pred);
    var eligible = (opts.social === "FW") ? { FW: 1 }
      : (opts.social === "UR") ? { UR: 1 }
        : (function () { var s = {}; s[opts.social] = 1; s.UR = 1; return s; })();
    // gender pools: female may take open + female seats; male may take open + male seats
    var egender = (opts.gender === "F") ? { OP: 1, F: 1 } : { OP: 1, M: 1 };
    var groups = {};                 // college|branch -> best row
    for (var i = 0; i < pred.rows.length; i++) {
      var r = pred.rows[i];
      var social = r[ci.cat];
      if (!eligible[social]) continue;
      if (!egender[r[ci.gen]]) continue;
      // non-MP-domicile students can't take MP home-state-only seats
      if (opts.domicile === "other" && r[ci.dom] === "MP") continue;
      if (opts.fwOnly && r[ci.fw] !== 1) continue;
      if (opts.year && r[ci.yr] !== opts.year) continue;
      var cid = r[ci.c], bid = r[ci.b];
      if (opts.branchSet && !opts.branchSet[bid]) continue;
      var col = ctx.colleges[cid];
      if (opts.city && (!col || col.city !== opts.city)) continue;
      if (opts.type && (!col || col.type !== opts.type)) continue;
      var key = cid + "|" + bid;
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
        pool: (g._social === opts.social && opts.social !== "UR") ? "reserved" : "general",
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
    // Fee-waiver
    var fwWrap = el("label", "f-check");
    var fw = el("input"); fw.type = "checkbox"; fw.id = "f-fw";
    fwWrap.appendChild(fw); fwWrap.appendChild(document.createTextNode(" Only colleges offering TFW (fee-waiver) seats"));
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
      var pool = r.pool === "reserved"
        ? " <span class='pool' title='matched your reserved category pool'>" + esc(r.social) + "</span>"
        : " <span class='pool muted' title='general/open pool'>" + esc(r.social) + "</span>";
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
      var fc = buildFilters(ctx, filtersBox);
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

      function run(e) {
        if (e) e.preventDefault();
        var social = document.getElementById("in-cat").value;
        var gEl = document.getElementById("in-gender"), dEl = document.getElementById("in-dom");
        var opts = {
          social: social, gender: gEl ? gEl.value : "M", domicile: dEl ? dEl.value : "mp",
          fwOnly: fc.fw.checked, city: fc.city.value || null, type: fc.type.value || null,
          branchSet: fc.branch.value ? (function () { var s = {}; s[fc.branch.value] = 1; return s; })() : null,
        };
        var stateP = { cat: social, gender: opts.gender, dom: opts.domicile,
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
      var fc = buildFilters(ctx, filtersBox);
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
      var bandRows = ["Safe (<=0.80x)", "Moderate (<=1.00x)", "Reach (<=1.15x)"].map(function (k) {
        var j = b.jee.calibration[k], q = b.qe.calibration[k];
        var label = k.split(" ")[0], thr = k.match(/\(([^)]+)\)/)[1];
        return "<tr><td><span class='tag tag-" + label.toLowerCase() + "'>" + label + "</span> " +
          "<span class='sub'>rank " + thr + " of last cut-off</span></td>" +
          "<td class='num'>" + pct(j.lenient_admit_rate) + "</td><td class='num'>" + pct(j.strict_admit_rate) + "</td>" +
          "<td class='num'>" + pct(q.lenient_admit_rate) + "</td><td class='num'>" + pct(q.strict_admit_rate) + "</td></tr>";
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

      box.innerHTML =
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
    if (page === "jee") initPredictor("jee");
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
