#!/usr/bin/env python3
"""
fix_2017_categories.py — recover the ALLOTTED_CATEGORY column for 2017 cut-offs.

The 2017 PDFs print the category column (UR/X/OP, OBC/X/F, SC/X/OP, F.W./X/OP, …),
but its header is OCR-garbled ("ALLOTED_CATEGOEY", rotated) so the original extractor
dropped it for 8 of the 9 2017 PDFs — 5,327 rows landed in the committed master
DTE_CutOff_BTech/2017-2025__all-cutoffs.json with allotted_category=null. (2017
first-round.pdf and all of 2018-2025 are unaffected.)

This re-reads the category straight from the PDFs with pdfplumber, aligns to the
master by (source_pdf, S.No.) — a 1:1 row correspondence — and fills the column.
Pool codes are ALL-UPPERCASE, so stripping OCR lowercase noise ("tUioRn/sX/OP")
cleanly recovers the code ("UR/X/OP"). Idempotent: only fills empty cells.

Run from anywhere:  python3 scripts/fix_2017_categories.py
"""
import json, os, re, collections, sys
import pdfplumber

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "DTE_CutOff_BTech", "2017-2025__all-cutoffs.json")
PDFDIR = os.path.join(ROOT, "DTE_CutOff_BTech", "2017")

AFFECTED = [  # the 8 2017 PDFs whose category column was lost (first-round.pdf was fine)
    "second-round", "first-round-upgrade", "intermediate-round", "qualifying-exam-round",
    "internal-branch-change", "special-round-jee", "special-round-qualifying-exam",
    "part-time-first-round",
]
SOCIAL = {"UR", "OBC", "SC", "ST", "EWS", "FW", "MIN", "JKM", "JKR", "NTPC", "OPEN"}


def clean_cat(c):
    """Pool codes are all-uppercase; strip interleaved OCR lowercase + whitespace."""
    return re.sub(r"\s+", "", re.sub(r"[a-z]", "", c or "")).strip()


def valid(c):
    if not c:
        return False
    head = c.split("/")[0].upper().replace("F.W.", "FW").replace(".", "")
    return ("/" in c and head in SOCIAL) or c.upper().replace(".", "") in SOCIAL


def toint(c):
    c = (c or "").strip().replace(",", "")
    return int(c) if c.isdigit() else None


def extract(pdf_path):
    """{sno: {'cat','op','cl'}} from one 2017 cut-off PDF, category column auto-detected."""
    rows = {}
    with pdfplumber.open(pdf_path) as pdf:
        for pg in pdf.pages:
            for tbl in (pg.extract_tables() or []):
                data = [r for r in tbl if r and (r[0] or "").strip().isdigit()]
                if not data:
                    continue
                # category column = the one whose cells most-often clean to a valid pool code
                score = collections.Counter()
                for r in data:
                    for i, c in enumerate(r):
                        if valid(clean_cat(c)):
                            score[i] += 1
                if not score:
                    continue
                ci = score.most_common(1)[0][0]
                for r in data:
                    cells = [(c or "").strip() for c in r]
                    if ci >= len(cells):
                        continue
                    sno = toint(cells[0])
                    if sno is None:
                        continue
                    lefts = [toint(cells[i]) for i in range(ci) if toint(cells[i]) is not None]
                    op, cl = (lefts[-2], lefts[-1]) if len(lefts) >= 2 else (None, lefts[-1] if lefts else None)
                    rows[sno] = {"cat": clean_cat(cells[ci]), "op": op, "cl": cl}
    return rows


def main():
    master = json.load(open(MASTER, encoding="utf-8"))
    todo = sum(1 for r in master if r.get("year") == 2017
               and not str(r.get("allotted_category") or "").strip()
               and r.get("source_pdf") in {f"2017__cutoff__{t}.pdf" for t in AFFECTED})
    if todo == 0:
        print("nothing to do — 2017 categories already present (idempotent no-op)")
        return

    lookup = {}  # source_pdf -> {sno: rec}
    for tag in AFFECTED:
        src = f"2017__cutoff__{tag}.pdf"
        path = os.path.join(PDFDIR, src)
        if not os.path.exists(path):
            sys.exit(f"missing PDF: {path}")
        lookup[src] = extract(path)
        print(f"  extracted {len(lookup[src]):5} category rows from {src}")

    filled = rank_confirmed = sno_only = unfillable = 0
    for r in master:
        if r.get("year") != 2017:
            continue
        if str(r.get("allotted_category") or "").strip():
            continue                                   # idempotent: already has a category
        src = r.get("source_pdf")
        rec = lookup.get(src, {}).get(r.get("sno"))
        if not rec or not valid(rec["cat"]):
            if src in lookup:
                unfillable += 1
            continue
        r["allotted_category"] = rec["cat"]
        filled += 1
        if rec["op"] == r.get("opening_rank") or rec["cl"] == r.get("closing_rank"):
            rank_confirmed += 1
        else:
            sno_only += 1                              # master's own rank cell is OCR-corrupt

    print(f"\nfilled {filled} rows  (rank-confirmed {rank_confirmed}, "
          f"S.No.-only {sno_only}), unfillable {unfillable}")
    assert filled >= 5300, f"expected ~5327 fills, got {filled}"
    assert unfillable <= 20, f"too many unfillable rows: {unfillable}"

    with open(MASTER, "w", encoding="utf-8") as f:
        json.dump(master, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {MASTER}")


if __name__ == "__main__":
    main()
