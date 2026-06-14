#!/usr/bin/env python3
"""
backtest.py — walk-forward validation of the deterministic cut-off predictor.

The model predicts an upcoming year from the most recent past year(s). To test how it
would have done historically, for each target year Y we predict using ONLY year Y-1 and
compare to year Y's ACTUAL closing ranks (the real allotment boundary) and total_allotted.

We reproduce the live engine's pool selection (max/most-lenient closing per
college × branch × social × gender × domicile, across rounds within a year), then for each
seat-pool present in both Y-1 and Y measure:
  • closing-rank error      pred (Y-1) vs actual (Y): median |rel error|, % within ±20%, bias
  • band calibration        a student at 0.7× / 0.95× / 1.1× last year's cutoff (Safe / Moderate /
                            Reach) — what % would ACTUALLY have been admitted in year Y?
  • coverage                % of year-Y pools the model could predict (present in Y-1 too)

Outputs assets/data/backtest.json + a printed report. No PII used (cut-off ranks only).
"""
import json, os, sys, statistics, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import preprocess as pp                      # reuse round/branch/category/domicile helpers

CUTOFF = os.path.join(ROOT, "DTE_CutOff_BTech", "2017-2025__all-cutoffs.json")
OUT = os.path.join(ROOT, "assets", "data", "backtest.json")


def annotate(co):
    for r in co:
        rc = pp.round_code(r.get("source_pdf"), r.get("round"))
        r["_uni"] = pp.universe(rc)
        r["_bid"] = pp.canon_branch_cutoff(r.get("branch"))[0]
        r["_ck"] = pp.norm_name(r.get("institute_name"))          # stable college key
        r["_social"] = pp.social_of(r.get("allotted_category")) or "UR"
        r["_gen"] = pp.gender_of(r.get("allotted_category"))
        r["_dom"] = pp.dom_of(r.get("domicile"))


def per_year_pool_close(co, uni):
    """year -> {pool key: {max,min closing, seats}}. max = most-lenient (live engine);
    min = round-1/strict boundary (for an honest worst-case calibration)."""
    m = collections.defaultdict(dict)
    for r in co:
        if r["_uni"] != uni:
            continue
        cl = r.get("closing_rank")
        if not isinstance(cl, int):
            continue
        key = (r["_ck"], r["_bid"], r["_social"], r["_gen"], r["_dom"])
        d = m[r["year"]]
        al = r.get("total_allotted")
        al = al if isinstance(al, int) else 0
        if key not in d:
            d[key] = {"max": cl, "min": cl, "seats": al}
        else:
            d[key]["max"] = max(d[key]["max"], cl)
            d[key]["min"] = min(d[key]["min"], cl)
            d[key]["seats"] += al
    return m


def metrics(pairs):
    rel = [abs(p - a) / a for p, a in pairs if a > 0]
    signed = [(p - a) / a for p, a in pairs if a > 0]
    within = sum(1 for x in rel if x <= 0.20)
    within10 = sum(1 for x in rel if x <= 0.10)
    return {
        "n": len(pairs),
        "median_abs_rel_err": round(statistics.median(rel), 3) if rel else None,
        "mean_abs_rel_err": round(statistics.fmean(rel), 3) if rel else None,
        "pct_within_10": round(100 * within10 / len(rel), 1) if rel else None,
        "pct_within_20": round(100 * within / len(rel), 1) if rel else None,
        "median_bias": round(statistics.median(signed), 3) if signed else None,  # +ve => cutoff loosened
    }


# Live engine thresholds (assets/js/mpdte.js band()): Safe ≤0.80×, Moderate ≤1.00×, Reach ≤1.15×.
LIVE_TIERS = {"Safe (<=0.80x)": 0.80, "Moderate (<=1.00x)": 1.00, "Reach (<=1.15x)": 1.15}


def calibration(triples):
    """For a student at m× last year's cut-off, what % were admissible this year?
    triples = (pred_max, actual_max, actual_min). 'lenient' uses the end-of-counselling
    (max) boundary the engine shows; 'strict' uses the round-1 (min) boundary."""
    out = {}
    for name, mult in LIVE_TIERS.items():
        len_adm = strict_adm = tot = 0
        for pred, act_max, act_min in triples:
            rank = pred * mult
            tot += 1
            if act_max >= rank:
                len_adm += 1
            if act_min >= rank:
                strict_adm += 1
        out[name] = {"lenient_admit_rate": round(100 * len_adm / tot, 1) if tot else None,
                     "strict_admit_rate": round(100 * strict_adm / tot, 1) if tot else None, "n": tot}
    return out


def backtest(co, uni, years):
    m = per_year_pool_close(co, uni)
    per_year = {}
    err_pairs = []        # (pred_max, actual_max) for closing-rank error
    cal_triples = []      # (pred_max, actual_max, actual_min) for band calibration
    pool_cov, seat_cov = [], []
    for Y in years:
        if (Y - 1) not in m or Y not in m:
            continue
        prev, cur = m[Y - 1], m[Y]
        keys = [k for k in cur if k in prev]
        if not keys:
            continue
        pairs = [(prev[k]["max"], cur[k]["max"]) for k in keys]
        per_year[Y] = {"basis_year": Y - 1, **metrics(pairs),
                       "coverage_pct": round(100 * len(keys) / len(cur), 1)}
        err_pairs += pairs
        cal_triples += [(prev[k]["max"], cur[k]["max"], cur[k]["min"]) for k in keys]
        pool_cov.append(len(keys) / len(cur))
        seats_tot = sum(v["seats"] for v in cur.values()) or 1
        seats_cov = sum(cur[k]["seats"] for k in keys)
        seat_cov.append(seats_cov / seats_tot)
    return {
        "per_year": per_year,
        "overall": metrics(err_pairs),
        "calibration": calibration(cal_triples),
        "total_pairs": len(err_pairs),
        "coverage_pool_pct": round(100 * statistics.fmean(pool_cov), 1) if pool_cov else None,
        "coverage_seat_pct": round(100 * statistics.fmean(seat_cov), 1) if seat_cov else None,
    }


def main():
    co = json.load(open(CUTOFF, encoding="utf-8"))
    annotate(co)
    jee = backtest(co, "jee", list(range(2018, 2026)))
    qe = backtest(co, "qe", list(range(2019, 2026)))
    result = {"jee": jee, "qe": qe, "note": (
        "Walk-forward: each year predicted from the previous year's closing ranks, compared to "
        "that year's actual closing ranks (the real allotment boundary). No machine learning.")}
    json.dump(result, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))

    def show(tag, b):
        print(f"\n================  {tag}  ================")
        print(f"  pool-pairs: {b['total_pairs']:,}   coverage: {b['coverage_pool_pct']}% pools / "
              f"{b['coverage_seat_pct']}% seats")
        o = b["overall"]
        print(f"  OVERALL closing-rank error: median |err| {int(o['median_abs_rel_err']*100)}%  "
              f"| within ±20%: {o['pct_within_20']}%  within ±10%: {o['pct_within_10']}%  "
              f"| bias {int(o['median_bias']*100):+d}%")
        print("  band calibration at LIVE thresholds (lenient = end-of-counselling / strict = round-1):")
        for k, v in b["calibration"].items():
            print(f"      {k:18s} -> lenient {v['lenient_admit_rate']}%  strict {v['strict_admit_rate']}%  (n={v['n']:,})")
        print("  per-year:")
        for Y, mm in sorted(b["per_year"].items()):
            print(f"      {Y} (from {mm['basis_year']}): n={mm['n']:5d}  within±20%={mm['pct_within_20']}%  "
                  f"median|err|={int(mm['median_abs_rel_err']*100)}%  cover={mm['coverage_pct']}%")

    show("JEE ROUTE (RF/FU/SR)", jee)
    show("QUALIFYING-EXAM ROUTE (TR/QR)", qe)
    print(f"\n-> {OUT}")


if __name__ == "__main__":
    main()
