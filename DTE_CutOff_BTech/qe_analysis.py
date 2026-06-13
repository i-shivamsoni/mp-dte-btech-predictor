#!/usr/bin/env python3
import json, os, re
from collections import defaultdict, Counter

DATA = "/home/seeker/Work/Projects/mpDTE/DTE_CutOff_BTech/all_btech_cutoffs.json"

with open(DATA) as f:
    data = json.load(f)

# ---------------------------------------------------------------------------
# 1. Bucket derivation from source_pdf basename (case-insensitive).
#    Order matters: most specific / exclusion patterns first.
#    We use word-ish token matching on the lowercased basename.
# ---------------------------------------------------------------------------
def bucket_for(basename: str, round_str: str) -> str:
    b = (basename or "").lower()
    r = (round_str or "").upper()

    # ----- EXCLUSIONS first -----
    # Internal branch change: '_sl', 'intsl', also '_is_' round, 'br_change'
    if "_sl" in b or "intsl" in b or "_is_" in b or "br_change" in b \
       or "INTERNAL BRANCH CHANGE" in r:
        return "InternalBranchChange(EXCL)"
    # Special rounds: 'spr', 'special', 'sp_ent', 'sp_qual'
    if "spr" in b or "special" in b or "sp_ent" in b or "sp_qual" in b \
       or "SPECIAL ROUND" in r:
        return "Special(EXCL)"

    # ----- QE-Based: '_tr', '_qr', 'qua' (qualifying) -----
    if "_tr" in b or "_qr" in b or "qua" in b or "QUALIFYING" in r:
        return "QE-Based"

    # ----- JEE-Upgrade: '_fu' (and upgrade variants) -----
    if "_fu" in b or "upgr" in b or "_up" in b or "_ur" in b or "UPGRADE" in r:
        return "JEE-Upgrade"

    # ----- JEE-Second: '_sr', 'second' -----
    if "_sr" in b or "second" in b or "SECOND ROUND" in r:
        return "JEE-Second"

    # ----- JEE-First: '_rf','_fr', GENREL-first; also intermediate / part-time first
    if "_rf" in b or "_fr" in b or "genrel" in b or "INTERMEDIATE" in r \
       or "PART TIME" in r or "FIRST ROUND" in r:
        return "JEE-First"

    return "UNCLASSIFIED"

JEE_BUCKETS = {"JEE-First", "JEE-Upgrade", "JEE-Second"}

# ---------------------------------------------------------------------------
# Print mapping of distinct basenames -> bucket (with the round string seen)
# ---------------------------------------------------------------------------
bn_info = {}  # basename -> (bucket, set(rounds), set(years))
for row in data:
    bn = os.path.basename(row.get("source_pdf") or "")
    rs = (row.get("round") or "").strip()
    bk = bucket_for(bn, rs)
    if bn not in bn_info:
        bn_info[bn] = [bk, set(), set()]
    bn_info[bn][1].add(rs)
    bn_info[bn][2].add(row.get("year"))
    # sanity: a single basename should map to a single bucket
    assert bn_info[bn][0] == bk, f"basename {bn} mapped to two buckets"

print("=" * 100)
print("STEP 1 — basename -> bucket mapping")
print("=" * 100)
for bn in sorted(bn_info):
    bk, rounds, years = bn_info[bn]
    yrs = ",".join(str(y) for y in sorted(years))
    print(f"  [{bk:26s}] {bn:38s} years={yrs}")
    for rr in sorted(rounds):
        print(f"       round: {rr}")

print("\nbucket totals (distinct basenames):",
      dict(Counter(v[0] for v in bn_info.values())))

# ---------------------------------------------------------------------------
# 2. Per-year allotment: JEE buckets vs QE-Based bucket
# ---------------------------------------------------------------------------
def alloted(row):
    v = row.get("total_allotted")
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0

per_year_jee = defaultdict(int)
per_year_qe = defaultdict(int)
years = set()
for row in data:
    bn = os.path.basename(row.get("source_pdf") or "")
    bk = bn_info[bn][0]
    y = row.get("year")
    years.add(y)
    a = alloted(row)
    if bk in JEE_BUCKETS:
        per_year_jee[y] += a
    elif bk == "QE-Based":
        per_year_qe[y] += a

print("\n" + "=" * 100)
print("STEP 2 — per-year allotments (sum of total_allotted)")
print("=" * 100)
print(f"  {'year':6s} {'JEE_alloc':>12s} {'QE_alloc':>12s} {'QE_present':>11s} {'QE_share%':>10s}")
per_year_rows = []
for y in sorted(years):
    j = per_year_jee[y]
    q = per_year_qe[y]
    present = q > 0
    share = (100.0 * q / (j + q)) if (j + q) > 0 else 0.0
    print(f"  {str(y):6s} {j:12d} {q:12d} {str(present):>11s} {share:9.2f}%")
    per_year_rows.append((y, j, q, present, round(share, 2)))

# ---------------------------------------------------------------------------
# 3. Universe check — closing_rank min/max JEE vs QE
# ---------------------------------------------------------------------------
def crank(row):
    v = row.get("closing_rank")
    try:
        return int(v)
    except (TypeError, ValueError):
        return None

jee_cr = [crank(r) for r in data
          if bn_info[os.path.basename(r.get("source_pdf") or "")][0] in JEE_BUCKETS]
qe_cr = [crank(r) for r in data
         if bn_info[os.path.basename(r.get("source_pdf") or "")][0] == "QE-Based"]
jee_cr = [x for x in jee_cr if x is not None]
qe_cr = [x for x in qe_cr if x is not None]

def pct(lst, p):
    s = sorted(lst)
    return s[int(p / 100.0 * (len(s) - 1))]

print("\n" + "=" * 100)
print("STEP 3 — closing_rank universe check")
print("=" * 100)
print(f"  JEE rows={len(jee_cr):6d}  min={min(jee_cr):8d}  median={pct(jee_cr,50):8d}  p95={pct(jee_cr,95):8d}  max={max(jee_cr):8d}")
print(f"  QE  rows={len(qe_cr):6d}  min={min(qe_cr):8d}  median={pct(qe_cr,50):8d}  p95={pct(qe_cr,95):8d}  max={max(qe_cr):8d}")

# Per-year QE max closing rank (to test the "small ~<15000" merit universe)
print("\n  QE closing_rank max per year:")
qe_by_year = defaultdict(list)
jee_by_year = defaultdict(list)
for r in data:
    bk = bn_info[os.path.basename(r.get("source_pdf") or "")][0]
    c = crank(r)
    if c is None:
        continue
    if bk == "QE-Based":
        qe_by_year[r.get("year")].append(c)
    elif bk in JEE_BUCKETS:
        jee_by_year[r.get("year")].append(c)
for y in sorted(years):
    qmx = max(qe_by_year[y]) if qe_by_year[y] else None
    jmx = max(jee_by_year[y]) if jee_by_year[y] else None
    print(f"     {y}: QE max={qmx}   JEE max={jmx}")

# ---------------------------------------------------------------------------
# 4. Category mix inside QE rows
# ---------------------------------------------------------------------------
print("\n" + "=" * 100)
print("STEP 4 — category mix inside QE rows")
print("=" * 100)
print("  Available fields on a row:", list(data[0].keys()))
# Check every field value distribution on QE rows for category-looking content
qe_rows = [r for r in data
           if bn_info[os.path.basename(r.get("source_pdf") or "")][0] == "QE-Based"]
print(f"  QE rows: {len(qe_rows)}")
CAT_WORDS = {"UR", "SC", "ST", "OBC", "EWS", "GEN", "GENERAL", "UNRESERVED",
             "OPEN", "TFW", "PWD", "MINORITY"}
found_cat_field = None
for key in data[0].keys():
    vals = Counter(str(r.get(key)) for r in qe_rows)
    # does this field look categorical with category labels?
    hits = sum(1 for v in vals if v.strip().upper() in CAT_WORDS)
    if hits:
        found_cat_field = key
        print(f"  field '{key}' contains category-like labels: {dict(vals)}")
# domicile distribution on QE rows (proxy: shows seat-pool labels present)
print("  QE domicile distribution:", dict(Counter(str(r.get('domicile')) for r in qe_rows)))
print("  QE institute_type distribution:", dict(Counter(str(r.get('institute_type')) for r in qe_rows)))
if not found_cat_field:
    print("  RESULT: No category field present. Category (UR/SC/ST/OBC/EWS) is NOT")
    print("          encoded in any row field nor in the branch token. The dataset is")
    print("          aggregated per (institute, branch, round) with opening/closing rank")
    print("          and a single total_allotted count -- there is no per-category split.")
