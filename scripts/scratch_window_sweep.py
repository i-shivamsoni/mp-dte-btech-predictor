#!/usr/bin/env python3
"""scratch (local-only, NOT committed): walk-forward sweep of prediction-window /
estimator choices for the JEE & QE cut-off predictor. Answers: does blending older
years into the closing-rank estimate beat the live 'last-1' model? Reuses backtest.py
helpers so numbers are comparable to the published pct_within_20."""
import json, os, sys, statistics, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import preprocess as pp
import backtest as bt

co = json.load(open(os.path.join(ROOT, "DTE_CutOff_BTech", "2017-2025__all-cutoffs.json"), encoding="utf-8"))
bt.annotate(co)


def hist_vals(history, k):
    """last k prior (year,val) pairs -> just the vals, most-recent-first order preserved by year."""
    h = history if k is None else history[-k:]
    return [v for (_, v) in h]


def lin_extrap(history, k, target):
    """linear fit val~year over last k prior years, extrapolate to target. Falls back to last-1 if <2 pts."""
    h = history if k is None else history[-k:]
    if len(h) < 2:
        return history[-1][1]
    xs = [y for y, _ in h]
    ys = [v for _, v in h]
    n = len(h)
    mx = statistics.fmean(xs)
    my = statistics.fmean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return history[-1][1]
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
    return my + slope * (target - mx)


def ewma(history, alpha):
    """recency-weighted mean, weight alpha^age (age 0 = most recent prior year)."""
    acc = w = 0.0
    for age, (_, v) in enumerate(reversed(history)):
        wt = alpha ** age
        acc += wt * v
        w += wt
    return acc / w if w else history[-1][1]


ESTIMATORS = {
    "last1 (LIVE)":   lambda h, Y: h[-1][1],
    "mean2":          lambda h, Y: statistics.fmean(hist_vals(h, 2)),
    "median2":        lambda h, Y: statistics.median(hist_vals(h, 2)),
    "mean3":          lambda h, Y: statistics.fmean(hist_vals(h, 3)),
    "median3":        lambda h, Y: statistics.median(hist_vals(h, 3)),
    "mean5":          lambda h, Y: statistics.fmean(hist_vals(h, 5)),
    "median5":        lambda h, Y: statistics.median(hist_vals(h, 5)),
    "mean_all":       lambda h, Y: statistics.fmean(hist_vals(h, None)),
    "median_all":     lambda h, Y: statistics.median(hist_vals(h, None)),
    "ewma_a0.5":      lambda h, Y: ewma(h, 0.5),
    "ewma_a0.7":      lambda h, Y: ewma(h, 0.7),
    "trend2":         lambda h, Y: lin_extrap(h, 2, Y),
    "trend3":         lambda h, Y: lin_extrap(h, 3, Y),
    "trend_all":      lambda h, Y: lin_extrap(h, None, Y),
}


def sweep(uni, years, require_prev=True):
    m = bt.per_year_pool_close(co, uni)
    # comparison set: all (Y, key) where key present in Y. require_prev => key also in Y-1
    # (matches LIVE coverage so every estimator is scored on the SAME pairs).
    samples = []  # (Y, history[list of (year,val) for prior years < Y where key present], actual)
    for Y in years:
        if Y not in m:
            continue
        for key, cur in m[Y].items():
            prior = [(y, m[y][key]["max"]) for y in range(2017, Y) if y in m and key in m[y]]
            if not prior:
                continue
            if require_prev and prior[-1][0] != Y - 1:
                continue
            samples.append((Y, prior, cur["max"]))
    out = {}
    for name, fn in ESTIMATORS.items():
        rel = []
        for Y, h, actual in samples:
            if actual <= 0:
                continue
            pred = fn(h, Y)
            if pred <= 0:
                pred = h[-1][1]
            rel.append(abs(pred - actual) / actual)
        within = sum(1 for x in rel if x <= 0.20)
        within10 = sum(1 for x in rel if x <= 0.10)
        out[name] = {
            "n": len(rel),
            "within20": round(100 * within / len(rel), 1) if rel else None,
            "within10": round(100 * within10 / len(rel), 1) if rel else None,
            "median_err": round(100 * statistics.median(rel), 1) if rel else None,
        }
    return out, len(samples)


def show(tag, res, n):
    print(f"\n================ {tag}  (n={n:,} pool-year pairs) ================")
    print(f"  {'estimator':14s} {'within20':>9s} {'within10':>9s} {'median|err|':>12s}")
    base = res["last1 (LIVE)"]["within20"]
    for name, v in sorted(res.items(), key=lambda kv: -(kv[1]["within20"] or 0)):
        d = v["within20"] - base
        flag = "  <- LIVE" if name == "last1 (LIVE)" else (f"  ({d:+.1f})" if abs(d) >= 0.05 else "")
        print(f"  {name:14s} {v['within20']:>8.1f}% {v['within10']:>8.1f}% {v['median_err']:>11.1f}%{flag}")


jee, nj = sweep("jee", list(range(2018, 2026)), require_prev=True)
qe, nq = sweep("qe", list(range(2019, 2026)), require_prev=True)
show("JEE  (same pools as live, Y-1 required)", jee, nj)
show("QE   (same pools as live, Y-1 required)", qe, nq)

# coverage view: how many MORE pools could each window predict if it didn't require Y-1?
print("\n--- coverage if we relax the 'Y-1 present' requirement (any prior year in window) ---")
for uni, years in [("jee", range(2018, 2026)), ("qe", range(2019, 2026))]:
    m = bt.per_year_pool_close(co, uni)
    req = relax = 0
    for Y in years:
        if Y not in m:
            continue
        for key in m[Y]:
            prior = [y for y in range(2017, Y) if y in m and key in m[y]]
            if not prior:
                continue
            relax += 1
            if prior[-1] == Y - 1:
                req += 1
    print(f"  {uni}: live(Y-1 req)={req:,} pairs | any-prior={relax:,} pairs  (+{relax-req:,} = +{round(100*(relax-req)/req,1)}% coverage)")
