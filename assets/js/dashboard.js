/* Demand Insights dashboard. Reads demand_stats.json and renders Chart.js charts.
 * Loaded only on /demand-insights/ (Chart.js comes from CDN just before this file). */
(function () {
  "use strict";
  var COL = { brand: "#1f5fbf", brand2: "#0d9488", warm: "#c2410c", grid: "#e3e7ec" };

  function fmt(n) { return (n == null) ? "—" : Number(n).toLocaleString("en-IN"); }
  function palette(n) {
    var base = ["#1f5fbf", "#0d9488", "#c2410c", "#7c3aed", "#b97f00", "#be185d", "#0369a1", "#15803d", "#9333ea", "#0891b2"];
    var out = []; for (var i = 0; i < n; i++) out.push(base[i % base.length]); return out;
  }

  function barH(canvasId, labels, values, title, axisLabel) {
    var c = document.getElementById(canvasId); if (!c || !window.Chart) return;
    new Chart(c, {
      type: "bar",
      data: { labels: labels, datasets: [{ label: title, data: values, backgroundColor: COL.brand, borderRadius: 4 }] },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (ctx) { return fmt(ctx.parsed.x); } } } },
        scales: {
          x: { title: { display: !!axisLabel, text: axisLabel }, grid: { color: COL.grid }, ticks: { callback: function (v) { return fmt(v); } } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  function lineTrend(canvasId, years, series) {
    var c = document.getElementById(canvasId); if (!c || !window.Chart) return;
    var cols = palette(series.length);
    new Chart(c, {
      type: "line",
      data: {
        labels: years,
        datasets: series.map(function (s, i) {
          return { label: s.label, data: s.data, borderColor: cols[i], backgroundColor: cols[i],
            spanGaps: true, tension: .25, pointRadius: 2 };
        }),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + ": top-college closing rank " + fmt(ctx.parsed.y); } } } },
        scales: {
          y: { reverse: true, title: { display: true, text: "Top-college closing rank — higher up = more in demand" }, grid: { color: COL.grid }, ticks: { callback: function (v) { return fmt(v); } } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  function render(d) {
    // 1. most in-demand branches: 15 lowest median closing (most competitive)
    // most in-demand = most seats actually filled (popularity); branches arrive seats-sorted.
    var br = d.branches.slice(0, 15);
    barH("chart-branches", br.map(function (b) { return b.label; }),
      br.map(function (b) { return b.seats; }),
      "Seats filled (" + d.latest_year + ")", "Seats filled (latest year) — longer = more in demand");

    // 2. trend lines for the top branches we have trend data for
    var years = []; for (var y = d.year_min; y <= d.year_max; y++) years.push(y);
    var series = Object.keys(d.trend).slice(0, 6).map(function (bid) {
      var label = (br.filter(function (b) { return b.b === bid; })[0] || {}).label || bid;
      return { label: label, data: years.map(function (y) { return d.trend[bid][y] != null ? d.trend[bid][y] : null; }) };
    });
    lineTrend("chart-trend", years, series);

    // 3. seats by city (top 15)
    var cities = d.by_city.slice(0, 15);
    barH("chart-city", cities.map(function (c) { return c.city; }),
      cities.map(function (c) { return c.seats; }), "Seats allotted (" + d.latest_year + ")", "Seats allotted");

    // 4. branch switching (revealed preference)
    var mv = (d.branch_movement || []).slice(0, 12);
    barH("chart-movement", mv.map(function (m) { return m.label; }),
      mv.map(function (m) { return m.into; }), "Students moved in (Internal Branch Change)", "Net moves into branch");
  }

  document.addEventListener("DOMContentLoaded", function () {
    var err = document.getElementById("demand-error");
    if (!window.MP) { return; }
    window.MP.load("demand_stats").then(render).catch(function (e) {
      if (err) err.innerHTML = "<div class='data-error'>Couldn&rsquo;t load demand data. Please refresh. <span class='muted'>(" +
        window.MP.esc(e && e.message) + ")</span></div>";
    });
  });
})();
