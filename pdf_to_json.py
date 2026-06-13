#!/usr/bin/env python3
"""Convert MP-DTE B.Tech cut-off PDFs to JSON.

Tables have ruling lines, so pdfplumber's 'lines' strategy yields clean cells.
Column headers are rotated 90 deg, which only *permutes* a header's letters
(e.g. DOMICILE -> ELCIMIOD). So columns are mapped to canonical fields by
comparing letter-multisets (bags) -- robust to any rotation jumble or typo.
"""
import os, re, sys, glob, json, warnings
from collections import Counter
import pdfplumber

warnings.filterwarnings("ignore")
LINES = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}
INT_FIELDS = {"opening_rank", "closing_rank", "total_allotted"}
# canonical column order for output
COL_ORDER = ["sno", "institute_name", "institute_type", "fw", "branch",
             "exam_type", "national_player", "opening_rank", "closing_rank",
             "eligible_category", "allotted_category", "jk_residents",
             "jk_migrants", "domicile", "total_allotted", "remarks"]

def _subset(keyword, counter):
    kw = Counter(keyword)
    return all(counter[c] >= n for c, n in kw.items())

def classify(cell):
    """Map a header cell to a canonical field via letter-multiset matching.
    Order matters: distinctive multi-word headers (RANK/CATEGORY) are tested
    before short ones like NAME, because e.g. {N,A,M,E} is a loose subset of
    'OPENING JEE RANK COMMON' (COMMON->M, RANK->A,N, JEE->E)."""
    comp = re.sub(r"[^A-Za-z]", "", cell or "").upper()
    if not comp:
        return None
    C = Counter(comp)
    has = lambda kw: _subset(kw, C)
    if has("EXAM"):                              return "exam_type"        # X distinctive
    if has("REMARK"):                            return "remarks"
    if has("PLAYER") or has("NATIONAL"):         return "national_player"
    if has("RANK") and has("OPENING"):           return "opening_rank"
    if has("RANK") and has("CLOSING"):           return "closing_rank"
    if has("CATEGORY") and has("ELIGIBLE"):      return "eligible_category"
    if has("CATEGORY"):                          return "allotted_category"
    if has("MIGRANT"):                           return "jk_migrants"
    if has("RESIDENT"):                          return "jk_residents"
    if has("DOMICILE"):                          return "domicile"
    if has("TOTAL") and has("ALLOT"):            return "total_allotted"
    if has("NAME"):                              return "institute_name"
    if has("TYPE"):                              return "institute_type"
    if has("BRANCH"):                            return "branch"
    if comp in ("FW", "WF"):                     return "fw"
    if len(comp) <= 4 and set(comp) <= set("SNO"): return "sno"
    return None

def clean(v):
    return re.sub(r"\s+", " ", (v or "").replace("\n", " ")).strip()

def to_int(v):
    s = clean(v).replace(",", "")
    if re.fullmatch(r"\d+", s):
        return int(s)
    m = re.fullmatch(r"[A-Za-z]+\s*(\d+)", s)   # pool marker merged into rank e.g. "X 796584"
    if m:
        return int(m.group(1))
    return clean(v) or None

def find_header(table):
    for row in table:
        fields = {j: classify(c) for j, c in enumerate(row)}
        present = {f for f in fields.values() if f}
        if ("institute_name" in present or "institute_type" in present) and \
           ("opening_rank" in present or "closing_rank" in present):
            return {j: f for j, f in fields.items() if f}
    return None

def parse_pdf(path):
    rows, mapping, unmapped = [], None, set()
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            page = page.dedupe_chars(tolerance=1)   # collapse doubled/overlapping glyphs
            tables = page.extract_tables(LINES)
            if not tables:
                continue
            table = max(tables, key=len)
            hdr = find_header(table)
            if hdr:
                mapping = hdr
            if not mapping:
                continue
            for row in table:
                if not row or not (row[0] or "").strip().isdigit():
                    continue
                rec = {"sno": int(row[0])}
                for j, val in enumerate(row):
                    field = mapping.get(j)
                    if field is None:
                        if clean(val):           # capture (never drop) + flag for review
                            unmapped.add(j)
                            rec[f"col{j}"] = clean(val)
                        continue
                    if field == "sno":
                        continue
                    rec[field] = to_int(val) if field in INT_FIELDS else clean(val)
                rows.append(rec)
    cols = [c for c in COL_ORDER if c in set(mapping.values())] if mapping else []
    return rows, cols, sorted(unmapped)

def load_titles(year_dir):
    titles = {}
    idx = os.path.join(year_dir, "_index.txt")
    if os.path.exists(idx):
        for line in open(idx, encoding="utf-8"):
            if " — " in line:
                fn, desc = line.split(" — ", 1)
                titles[fn.strip()] = desc.strip()
    return titles

def doc_title(path):
    try:
        import subprocess
        txt = subprocess.run(["pdftotext", "-layout", "-f", "1", "-l", "1", path, "-"],
                             capture_output=True, text=True, timeout=30).stdout
        lines = [l.strip() for l in txt.splitlines() if l.strip()]
        return lines[:4]
    except Exception:
        return []

def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))   # run from project root regardless of cwd
    base = "DTE_CutOff_BTech"
    pdfs = sorted(glob.glob(f"{base}/*/*.pdf"))
    summary = []
    for path in pdfs:
        year = int(re.search(r"/(\d{4})/", path).group(1))
        titles = load_titles(os.path.dirname(path))
        rows, cols, unmapped = parse_pdf(path)
        out = {
            "source_pdf": path,
            "year": year,
            "round_title": titles.get(os.path.basename(path), ""),
            "document_title_lines": doc_title(path),
            "course": "BACHELOR OF TECHNOLOGY",
            "columns": cols,
            "row_count": len(rows),
            "rows": rows,
        }
        jpath = os.path.splitext(path)[0] + ".json"
        with open(jpath, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)
        flag = "  ⚠ UNMAPPED COLS " + str(unmapped) if unmapped else ""
        summary.append((path, year, len(rows), cols, unmapped))
        print(f"{os.path.basename(path):45s} {year}  rows={len(rows):5d}  cols={len(cols)}{flag}")
    total = sum(s[2] for s in summary)
    print(f"\nTotal: {len(summary)} PDFs, {total:,} rows -> JSON written next to each PDF")
    anomalies = [s for s in summary if s[4] or s[2] == 0]
    if anomalies:
        print("\nANOMALIES:")
        for p, y, n, c, u in anomalies:
            print(f"  {p}: rows={n} unmapped={u}")
    else:
        print("No anomalies (every column mapped, no empty files).")

if __name__ == "__main__":
    main()
