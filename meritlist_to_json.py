#!/usr/bin/env python3
"""Convert the MP-DTE B.Tech candidate Common Merit Lists in MeritLists/ to JSON.

Same engine as the cut-off / QE parsers: ruling-line tables (pdfplumber 'lines'),
dedupe_chars for doubled glyphs, and letter-multiset header matching (rotation only
permutes a header's letters, never adds/removes them).

Two candidate-list families live here:
  * JEE-rank list   -> cols: sno, rank(JEE common merit rank), roll_no, name,
                       domicile, category, class, gender, jk_residents,
                       jk_migrants, fee_waiver, national_player, ews, ntpc,
                       subject_group_name
  * QE-% list       -> cols: rank(QE merit rank), qualifying_exam_percentage,
                       roll_no, name, domicile, category, class, gender, ews,
                       fee_waiver, ntpc, subject_group_name

The MeritLists/2021/*.pdf files are NOT candidate lists -- they are institute
opening/closing-rank CUT-OFF tables, byte-identical to DTE_CutOff_BTech/2021/
(OPCL_BTECH_FR_UPDATED / _FR_UPGRADE). They are skipped here (see SKIP).

Usage:  python3 meritlist_to_json.py [substr ...]   # optional: limit to matching paths
"""
import os, re, sys, glob, json, warnings, subprocess
from collections import Counter
from multiprocessing import Pool
import pdfplumber

warnings.filterwarnings("ignore")
LINES = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}

# 2021 files are duplicate institute cut-off lists, not candidate merit lists.
SKIP = {
    "MeritLists/2021/2021_Round1-JEE-Main.pdf":
        "institute opening/closing cut-off (= DTE_CutOff_BTech/2021/OPCL_BTECH_FR_UPDATED.pdf)",
    "MeritLists/2021/2021_Round2-JEE-Main.pdf":
        "institute opening/closing cut-off (= DTE_CutOff_BTech/2021/OPCL_BTECH_FR_UPGRADE_2021.pdf)",
}

COL_ORDER = ["sno", "rank", "mp_state_common_rank", "qualifying_exam_percentage",
             "roll_no", "name", "domicile", "category", "class", "gender",
             "jk_residents", "jk_migrants", "fee_waiver", "national_player",
             "ews", "ntpc", "subject_group_name"]


def _subset(kw, C):
    return all(C[c] >= n for c, n in Counter(kw).items())


def classify(cell):
    """Map a (possibly rotation-jumbled) header cell to a canonical field.
    Order matters -- the most letter-rich / most distinctive tokens go first so a
    long phrase can't be swallowed by a short keyword that is a subset of it:
      * PERCENT before MIGRANT: 'Qualifying Exam Percentage' contains M,I,G,R,A,N,T.
      * PLAYER/NATIONAL before ROLL: 'National Player' contains R,O,L,L.
    """
    comp = re.sub(r"[^A-Za-z]", "", cell or "").upper()
    if not comp:
        return None
    C = Counter(comp)
    has = lambda kw: _subset(kw, C)
    if has("SUBJECT"):                    return "subject_group_name"
    if has("RANK") and has("STATE"):      return "mp_state_common_rank"  # 2021 MP State rank;
    #   NB: this must precede PERCENT -- "MP STATE COMMON RANK" is a letter-superset of PERCENT,
    #   but a real "Qualifying Exam Percentage" header has no K, so it can't match RANK.
    if has("PERCENT"):                    return "qualifying_exam_percentage"  # before MIGRANT
    if has("PLAYER") or has("NATIONAL"):  return "national_player"            # before ROLL
    if has("RESIDENT"):                   return "jk_residents"
    if has("MIGRANT"):                    return "jk_migrants"
    if has("WAIVER"):                     return "fee_waiver"
    if has("DOMICILE"):                   return "domicile"
    if has("CATEGORY"):                   return "category"
    if has("GENDER"):                     return "gender"
    if has("RANK"):                       return "rank"
    if has("ROLL"):                       return "roll_no"
    if has("CLASS"):                      return "class"
    if sorted(comp) == sorted("EWS"):     return "ews"
    if sorted(comp) == sorted("NTPC"):    return "ntpc"
    if has("NAME"):                       return "name"
    if len(comp) <= 4 and set(comp) <= set("SNO"):  return "sno"
    return None


def clean(v):
    return re.sub(r"\s+", " ", (v or "").replace("\n", " ")).strip()


def conv(field, v):
    s = clean(v)
    if field in ("rank", "sno", "mp_state_common_rank"):
        return int(s) if s.isdigit() else (s or None)   # weightage marks ".1"/"*" kept as str
    if field == "qualifying_exam_percentage":
        return float(s) if re.fullmatch(r"\d+(\.\d+)?", s) else (s or None)
    return s or None


def resolve_mapping(row):
    """Classify every cell, then resolve collisions:
      * two cols -> 'rank' (a 'RANK' serial col + a 'JEE Common Rank' col):
        demote the LEFT one to 'sno'.
    Returns {col_index: field} or None if this row isn't a header."""
    m = {j: classify(c) for j, c in enumerate(row)}
    m = {j: f for j, f in m.items() if f}
    fields = list(m.values())
    if "name" not in fields or not ({"rank", "qualifying_exam_percentage"} & set(fields)):
        return None
    ranks = sorted(j for j, f in m.items() if f == "rank")
    if len(ranks) > 1:               # leftmost rank is really the serial number
        m[ranks[0]] = "sno"
    return m


def parse(path):
    rows, mapping, unmapped, dup = [], None, set(), set()
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            page = page.dedupe_chars(tolerance=1)
            tables = page.extract_tables(LINES)
            if not tables:
                continue
            table = max(tables, key=len)
            for r in table:
                hdr = resolve_mapping(r)
                if hdr:
                    mapping = hdr
                    break
            if not mapping:
                continue
            for r in table:
                if not r or not (r[0] or "").strip().isdigit():
                    continue
                rec = {}
                for j, val in enumerate(r):
                    f = mapping.get(j)
                    if f is None:
                        if clean(val):
                            unmapped.add(j); rec[f"col{j}"] = clean(val)
                        continue
                    if f in rec and rec[f] not in (None, ""):   # never silently overwrite
                        dup.add(j); rec[f"col{j}"] = clean(val); continue
                    rec[f] = conv(f, val)
                rows.append(rec)
    cols = [c for c in COL_ORDER if mapping and c in set(mapping.values())]
    return rows, cols, sorted(unmapped | dup)


def title_lines(path):
    try:
        txt = subprocess.run(["pdftotext", "-layout", "-f", "1", "-l", "1", path, "-"],
                             capture_output=True, text=True, timeout=30).stdout
        return [l.strip() for l in txt.splitlines() if l.strip()][:4]
    except Exception:
        return []


def derive_meta(titles, cols):
    """Infer round + basis from title lines and detected columns."""
    blob = " ".join(titles).lower()
    is_qe = "qualifying_exam_percentage" in cols
    based_on = ("Qualifying Exam Percentage (Class XII)" if is_qe
                else "JEE Common Merit Rank")
    if "first round" in blob:       rnd = "First Round"
    elif "second round" in blob:    rnd = "Second Round"
    else:                           rnd = ""
    rnd = (rnd + " Common Merit List").strip()
    return ("qe_percentage" if is_qe else "jee_rank"), based_on, rnd


def group_key(year, fname):
    """Logical-list key: strip a trailing rank-range/pct-range suffix, and collapse
    QE-1/QE-2 (which are two parts of one list). Round1/Round2 stay distinct."""
    stem = fname[:-4]
    stem = re.sub(r"_\d+(?:\.\d+)?-(?:to-)?\d+(?:\.\d+)?(?:pct)?$", "", stem)
    stem = re.sub(r"(QE)-\d+$", r"\1", stem)
    return f"{year}/{stem}"


def rank_stats(rows, key):
    """Validation. `key` is the unique serial column ('sno' for JEE lists, 'rank'
    for QE lists). Integrity = that key is unique & contiguous 1..N. JEE 'rank'
    (JEE common merit rank) may legitimately TIE, so rank dupes are reported as
    informational `rank_ties`, never as an integrity failure."""
    keys = [r[key] for r in rows if isinstance(r.get(key), int)]
    ranks = [r["rank"] for r in rows if isinstance(r.get("rank"), int)]
    out = {
        "key": key,
        "key_min": min(keys) if keys else None,
        "key_max": max(keys) if keys else None,
        "key_unique_contiguous":
            bool(keys) and len(set(keys)) == len(keys)
            and len(keys) == max(keys) - min(keys) + 1,
        "rank_min": min(ranks) if ranks else None,
        "rank_max": max(ranks) if ranks else None,
        "rank_non_int": sum(1 for r in rows if not isinstance(r.get("rank"), int)),
        "rank_ties": len(ranks) - len(set(ranks)),
        "name_missing": sum(1 for r in rows if not r.get("name")),
    }
    pcts = [r["qualifying_exam_percentage"] for r in rows
            if isinstance(r.get("qualifying_exam_percentage"), float)]
    if pcts:
        out["pct_min"], out["pct_max"] = min(pcts), max(pcts)
        out["pct_out_of_order"] = sum(1 for a, b in zip(pcts, pcts[1:]) if b > a + 1e-9)
    return out


def key_for(list_type):
    return "rank" if list_type == "qe_percentage" else "sno"


MANIFEST = "MeritLists/manifest.json"


def parse_one(path):
    """Parse a PDF, write its per-PDF JSON, and return (doc_meta, logline).
    doc_meta excludes rows (rows live only in the per-PDF JSON on disk).
    No printing here so it is safe to run inside a multiprocessing Pool."""
    year = int(re.search(r"/(\d{4})/", path).group(1))
    titles = title_lines(path)
    rows, cols, anomalies = parse(path)
    ltype, based_on, rnd = derive_meta(titles, cols)
    doc = {
        "source_pdf": path, "year": year, "list_type": ltype,
        "round": rnd, "based_on": based_on, "course": "BACHELOR OF TECHNOLOGY",
        "document_title_lines": titles, "columns": cols, "row_count": len(rows),
        "validation": rank_stats(rows, key_for(ltype)), "rows": rows,
    }
    json.dump(doc, open(path[:-4] + ".json", "w", encoding="utf-8"), ensure_ascii=False)
    v = doc["validation"]
    flag = f"  ⚠ cols{anomalies}" if anomalies else ""
    flag += "" if v["key_unique_contiguous"] else "  ⚠ KEY NOT 1..N"
    logline = (f"{os.path.basename(path):46s} {year} {ltype:13s} rows={len(rows):6d} "
               f"cols={len(cols):2d} {v['key']}={v['key_min']}-{v['key_max']} "
               f"rankspan={v['rank_min']}-{v['rank_max']} ties={v['rank_ties']}{flag}")
    meta = {k: doc[k] for k in ("source_pdf", "year", "list_type", "round",
            "based_on", "columns", "row_count", "validation")}
    meta["group"] = group_key(year, os.path.basename(path))
    return meta, logline


def rebuild_group(gk, metas):
    """Build a logical-list group from its part doc_metas. Reads rows back from the
    per-PDF JSONs only when the group has >1 part (then also writes a merged file)."""
    metas = sorted(metas, key=lambda m: (m["validation"]["rank_min"] or 0))
    g = {"group": gk, "source_pdfs": [m["source_pdf"] for m in metas],
         "list_type": metas[0]["list_type"], "round": metas[0]["round"],
         "based_on": metas[0]["based_on"], "n_parts": len(metas)}
    if len(metas) == 1:
        g["row_count"] = metas[0]["row_count"]
        g["validation"] = metas[0]["validation"]
        return g
    rows = []
    for m in metas:
        rows += json.load(open(m["source_pdf"][:-4] + ".json", encoding="utf-8"))["rows"]
    g["row_count"] = len(rows)
    g["validation"] = rank_stats(rows, key_for(metas[0]["list_type"]))
    year, stem = gk.split("/", 1)
    out = f"MeritLists/{year}/_merged_{stem}.json"
    json.dump(g | {"course": "BACHELOR OF TECHNOLOGY", "rows": rows},
              open(out, "w", encoding="utf-8"), ensure_ascii=False)
    v = g["validation"]
    ok = "" if v["key_unique_contiguous"] else "  ⚠ KEY NOT 1..N"
    print(f"{gk:36s} parts={len(metas)} rows={len(rows):6d} "
          f"{v['key']}={v['key_min']}-{v['key_max']} ties={v['rank_ties']}{ok} -> {out}")
    return g


def groups_of(documents):
    by = {}
    for d in documents:
        by.setdefault(d["group"], []).append(d)
    return by


def report(manifest):
    total = sum(d["row_count"] for d in manifest["documents"])
    print(f"\nTotal: {len(manifest['documents'])} PDFs parsed, "
          f"{len(manifest['skipped'])} skipped, {total:,} candidate rows.")
    bad = [d for d in manifest["documents"]
           if d["validation"]["name_missing"] or not d["validation"]["key_unique_contiguous"]
           or d["row_count"] == 0 or d["validation"].get("pct_out_of_order")]
    if bad:
        print("\nANOMALIES:")
        for d in bad:
            print(f"  {d['source_pdf']}: rows={d['row_count']} {d['validation']}")
    else:
        print("No anomalies (serial key 1..N unique, names present, percentages ordered).")


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    args = sys.argv[1:]
    add_mode = "--add" in args
    filt = [a for a in args if a != "--add"]
    pdfs = sorted(glob.glob("MeritLists/*/*.pdf"))
    if filt:
        pdfs = [p for p in pdfs if any(f in p for f in filt)]

    if add_mode and os.path.exists(MANIFEST):
        manifest = json.load(open(MANIFEST, encoding="utf-8"))
    else:
        manifest = {"course": "BACHELOR OF TECHNOLOGY", "documents": [],
                    "skipped": [], "groups": {}}

    skips = [{"source_pdf": p, "reason": SKIP[p]} for p in pdfs if p in SKIP]
    for s in skips:
        print(f"SKIP {s['source_pdf']}  ({s['reason']})")
    work = [p for p in pdfs if p not in SKIP]

    # PDFs are independent -> parse them in parallel (one worker per core).
    # dedupe_chars dominates per-page cost, so wall-time ~= the slowest single PDF.
    new_metas = []
    jobs = max(1, min(len(work), os.cpu_count() or 1))
    if work:
        with Pool(jobs) as pool:
            for meta, logline in pool.imap_unordered(parse_one, work):
                print(logline)
                new_metas.append(meta)

    # upsert documents + skips by source_pdf
    docs = {d["source_pdf"]: d for d in manifest["documents"]}
    docs.update({m["source_pdf"]: m for m in new_metas})
    manifest["documents"] = sorted(docs.values(), key=lambda d: d["source_pdf"])
    sk = {s["source_pdf"]: s for s in manifest["skipped"]}
    sk.update({s["source_pdf"]: s for s in skips})
    manifest["skipped"] = sorted(sk.values(), key=lambda s: s["source_pdf"])

    # rebuild affected groups (all groups on a full run; only touched ones on --add)
    by = groups_of(manifest["documents"])
    affected = set(by) if not add_mode else {m["group"] for m in new_metas}
    print("\n--- logical lists ---")
    for gk in sorted(affected):
        manifest["groups"][gk] = rebuild_group(gk, by[gk])

    json.dump(manifest, open(MANIFEST, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    report(manifest)


if __name__ == "__main__":
    main()
