#!/usr/bin/env python3
"""Convert MP-DTE B.Tech *percentage-wise* (qualifying-exam) Common Merit Lists to JSON.
Same engine as the cut-off parser: ruling-line tables + letter-multiset header mapping."""
import os, re, sys, json, warnings
from collections import Counter
import pdfplumber

warnings.filterwarnings("ignore")
LINES = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}

# (year, list-key) per source file; QE-1/QE-2 are two parts of one 2024-25 list
SOURCES = [
    ("document-2019.pdf",            2019, "2019"),
    ("CommonView22-23.pdf",          2022, "2022-23"),
    ("MP-DTE-BE-Merit-List-QE-1.pdf", 2024, "2024-25"),
    ("MP-DTE-BE-Merit-List-QE-2.pdf", 2024, "2024-25"),
]
COL_ORDER = ["rank", "qualifying_exam_percentage", "roll_no", "name", "domicile",
             "category", "class", "gender", "ews", "fee_waiver", "ntpc",
             "subject_group_name"]

def _subset(kw, C): return all(C[c] >= n for c, n in Counter(kw).items())

def classify(cell):
    comp = re.sub(r"[^A-Za-z]", "", cell or "").upper()
    if not comp:
        return None
    C = Counter(comp)
    has = lambda kw: _subset(kw, C)
    if has("SUBJECT"):                 return "subject_group_name"   # richest, check first
    if has("WAIVER"):                  return "fee_waiver"
    if has("PERCENT"):                 return "qualifying_exam_percentage"
    if has("ROLL"):                    return "roll_no"
    if has("DOMICILE"):                return "domicile"
    if has("CATEGORY"):                return "category"
    if has("GENDER"):                  return "gender"
    if has("CLASS"):                   return "class"
    if sorted(comp) == sorted("EWS"):  return "ews"     # rotation reorders -> use letter-bag
    if sorted(comp) == sorted("NTPC"): return "ntpc"
    if has("NAME"):                    return "name"
    if has("RANK"):                    return "rank"
    return None

def clean(v): return re.sub(r"\s+", " ", (v or "").replace("\n", " ")).strip()

def conv(field, v):
    s = clean(v)
    if field == "rank":
        return int(s) if s.isdigit() else (s or None)
    if field == "qualifying_exam_percentage":
        return float(s) if re.fullmatch(r"\d+(\.\d+)?", s) else (s or None)
    return s

def find_header(table):
    for row in table:
        m = {j: classify(c) for j, c in enumerate(row)}
        present = {f for f in m.values() if f}
        if "name" in present and "qualifying_exam_percentage" in present:
            return {j: f for j, f in m.items() if f}
    return None

def parse(path):
    rows, mapping, unmapped = [], None, set()
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            page = page.dedupe_chars(tolerance=1)
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
                rec = {}
                for j, val in enumerate(row):
                    f = mapping.get(j)
                    if f is None:
                        if clean(val):
                            unmapped.add(j); rec[f"col{j}"] = clean(val)
                        continue
                    rec[f] = conv(f, val)
                rows.append(rec)
    cols = [c for c in COL_ORDER if mapping and c in set(mapping.values())]
    return rows, cols, sorted(unmapped)

def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))   # anchor to project root
    os.chdir("DTE_CutOff_BTech")
    outdir = "../DTE_MeritList_BTech"
    os.makedirs(outdir, exist_ok=True)
    by_list = {}
    for fn, year, key in SOURCES:
        rows, cols, un = parse(fn)
        print(f"{fn:34s} {key}  rows={len(rows):6d} cols={len(cols)}"
              + (f"  ⚠ unmapped {un}" if un else ""))
        by_list.setdefault(key, {"year": year, "round": "Second Round Common Merit List"
                                 if key != "2019" else "Common Merit List (Qualifying Exam Round)",
                                 "based_on": "Qualifying Exam Percentage (Class XII)",
                                 "course": "BACHELOR OF TECHNOLOGY",
                                 "source_pdfs": [], "columns": cols, "rows": []})
        L = by_list[key]
        L["source_pdfs"].append(fn)
        for c in cols:
            if c not in L["columns"]:
                L["columns"].append(c)
        L["rows"].extend(rows)
    grand = 0
    for key, L in by_list.items():
        L["row_count"] = len(L["rows"]); grand += len(L["rows"])
        out = f"{outdir}/{key}__merit-list__qualifying-exam.json"   # name preprocess.py reads
        json.dump(L, open(out, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"  -> {out}  ({L['row_count']:,} candidates, "
              f"{os.path.getsize(out)/1e6:.1f} MB)")
    print(f"\nTotal candidates across all percentage-wise lists: {grand:,}")

if __name__ == "__main__":
    main()
