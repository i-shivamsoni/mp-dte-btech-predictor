#!/usr/bin/env python3
"""Rename raw data files to the agreed convention: <year>__<kind>__<descriptor>.<ext>
(year-first, spelled out). DRY-RUN by default — prints old->new and flags collisions.
Run with --apply to execute. Tracked files (git) are renamed with `git mv`."""
import os, re, sys, subprocess, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPLY = "--apply" in sys.argv

TRACKED = set(subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True).stdout.split())

def cutoff_round(fn):
    u = fn.upper()
    if "2UPGR" in u or "2ND_UPGRADE" in u: return "first-round-second-upgrade"
    if "INTSL" in u or "BR_CHANGE" in u or "IS_ROUND" in u or "_SL" in u: return "internal-branch-change"
    if "SP_QUAL" in u or "SPR_QUA" in u: return "special-round-qualifying-exam"
    if "SP_ENT" in u or "SPR_JEE" in u: return "special-round-jee"
    if "_SP" in u or "SPECIAL" in u or "SPR" in u: return "special-round"
    if "PT_FR" in u: return "part-time-first-round"
    if "INTR" in u: return "intermediate-round"
    if "UPGR" in u or "_FU" in u or "BEFR_UP" in u or "_UR" in u: return "first-round-upgrade"
    if "QUA" in u or "_QR" in u or "_TR" in u: return "qualifying-exam-round"
    if "_SR" in u or "SECOND_ROUND" in u: return "second-round"
    if "_FR" in u or "_RF" in u or "TECH_FR" in u or "BEBTECH_OPCL_FR" in u or re.fullmatch(r"BE_OP_CL_\d+", fn.upper().replace(".PDF","").replace(".JSON","")): return "first-round"
    return None

# explicit map for merit-list / loose files (basename without extension) -> new basename
MERIT = {
    # DTE_MeritList_BTech (the %->rank lists preprocess reads)
    "BTech_MeritList_QE_2019": "2019__merit-list__qualifying-exam",
    "BTech_MeritList_QE_2022-23": "2022-23__merit-list__qualifying-exam",
    "BTech_MeritList_QE_2024-25": "2024-25__merit-list__qualifying-exam",
    # DTE_CutOff_BTech loose merit PDFs
    "CommonView22-23": "2022-23__merit-list__qualifying-exam__second-round",
    "document-2019": "2019__merit-list__qualifying-exam",
    "MP-DTE-BE-Merit-List-QE-1": "2024-25__merit-list__qualifying-exam__part1",
    "MP-DTE-BE-Merit-List-QE-2": "2024-25__merit-list__qualifying-exam__part2",
    # repo-root loose
    "CommonView": "2026-27__admission-rulebook",
    "2022_Common-merit-qualifying-exam-sample": "2022-23__merit-list__qualifying-exam__sample",
    "dte-mp-btech-merit-list-2025": "2025__merit-list__jee-common__first-round",
    # MeritLists tree
    "BE_Merit_SR_2017": "2017__merit-list__second-round",
    "2019_QE-Candidates": "2019__merit-list__qualifying-exam",
    "2019_Round1-JEE-Main": "2019__merit-list__jee-main__round1",
    "2019_Round2-JEE-Main": "2019__merit-list__jee-main__round2",
    "2020_Round1-JEE-Main": "2020__merit-list__jee-main__round1",
    "2020_Round2-JEE-Main": "2020__merit-list__jee-main__round2",
    "2021": "2021__merit-list__common",
    "2021_Round1-JEE-Main": "2021__merit-list__jee-main__round1",
    "2021_Round2-JEE-Main": "2021__merit-list__jee-main__round2",
    "PUBLISH_BE_Merit_Second_Round_2021 BASED ON JEE EXAM": "2021__merit-list__jee-main__second-round",
    "2022_Common-merit-qualifying-exam": "2022__merit-list__qualifying-exam",
    "2022_TFW-General-First-Round": "2022__merit-list__tfw-general__first-round",
    "2022_TFW-General-Second-Round": "2022__merit-list__tfw-general__second-round",
    "2024_MP-DTE-BE-Merit-List-JEE-Main": "2024__merit-list__jee-main",
    "2024_QE-1_96.4-to-64.8pct": "2024__merit-list__qualifying-exam__part1-96.4-to-64.8pct",
    "2024_QE-2_64.8-to-39.4pct": "2024__merit-list__qualifying-exam__part2-64.8-to-39.4pct",
    "_merged_2024_QE": "2024__merit-list__qualifying-exam__merged",
    "_merged_2024_merit-list": "2024__merit-list__merged",
    "_merged_2023_JEE-Rank": "2023__merit-list__jee-rank__merged",
    "_merged_2023_merit-list": "2023__merit-list__merged",
    "2025_Round1_MP-BTech-Merit-List": "2025__merit-list__jee-common__round1",
    "2025_Round2_CommonView": "2025__merit-list__jee-common__round2",
    "2018_CommonView": "2018__merit-list__qualifying-exam",
    # the two big tracked aggregate/intake + manifests
    "all_btech_cutoffs": "2017-2025__all-cutoffs",
    "intake_BE_2026-27": "2026-27__seat-matrix",
}

def merit_dynamic(base, year):
    m = re.match(r"(\d{4})_JEE-Rank_([\d-]+)$", base)
    if m: return f"{m.group(1)}__merit-list__jee-rank__{m.group(2)}"
    m = re.match(r"(\d{4})_merit-list_([\d-]+)$", base)
    if m: return f"{m.group(1)}__merit-list__{m.group(2)}"
    m = re.match(r"(\d{4})_merit-list_([\d-]+)$", base)
    if m: return f"{m.group(1)}__merit-list__{m.group(2)}"
    return None

def main():
    plan, targets, flags = [], collections.defaultdict(list), []
    
    def consider(path):
        d, fn = os.path.split(path)
        base, ext = os.path.splitext(fn)
        if ext.lower() not in (".pdf", ".json"): return
        rel = os.path.relpath(path, ROOT)
        new = None
        # per-year cut-off round files
        m = re.search(r"DTE_CutOff_BTech/(20\d\d)$", d)
        if m and base != "manifest":
            rn = cutoff_round(base)
            new = f"{m.group(1)}__cutoff__{rn}" if rn else None
            if not rn: flags.append(f"UNMAPPED cutoff: {rel}")
        # CommonView is the rule book at repo root, but a QE merit list under MeritLists/<year>/
        if new is None and base == "CommonView":
            ym = re.search(r"MeritLists/(\d{4})", d)
            new = f"{ym.group(1)}__merit-list__qualifying-exam" if ym else "2026-27__admission-rulebook"
        if new is None and base in MERIT: new = MERIT[base]
        if new is None: new = merit_dynamic(base, None)
        if new is None and base == "manifest":
            new = ("cutoffs__manifest" if "DTE_CutOff_BTech" in d else "merit-lists__manifest")
        if new is None:
            flags.append(f"UNMAPPED: {rel}"); return
        newpath = os.path.join(d, new + ext.lower())
        if os.path.abspath(newpath) == os.path.abspath(path): return
        targets[newpath].append(path)
        plan.append((path, newpath))
    
    for dirpath, _, files in os.walk(ROOT):
        if "/.git" in dirpath: continue
        if not re.search(r"DTE_CutOff_BTech|DTE_Intake_BTech|DTE_MeritList_BTech|MeritLists", dirpath) and dirpath != ROOT:
            continue
        for f in files:
            if dirpath == ROOT and f not in ("CommonView.pdf", "2022_Common-merit-qualifying-exam-sample.pdf", "dte-mp-btech-merit-list-2025.pdf"):
                continue
            consider(os.path.join(dirpath, f))
    
    collisions = {t: srcs for t, srcs in targets.items() if len(srcs) > 1}
    print(f"{'APPLYING' if APPLY else 'DRY-RUN'}: {len(plan)} renames, {len(collisions)} collisions, {len(flags)} flags\n")
    for src, dst in sorted(plan):
        tag = "TRACKED" if os.path.relpath(src, ROOT) in TRACKED else "       "
        print(f"  [{tag}] {os.path.relpath(src,ROOT)}\n          -> {os.path.relpath(dst,ROOT)}")
    if collisions:
        print("\n!! COLLISIONS:")
        for t, s in collisions.items(): print("  ", os.path.relpath(t,ROOT), "<-", [os.path.relpath(x,ROOT) for x in s])
    if flags:
        print("\n!! FLAGS:"); [print("  ", f) for f in flags]
    
    if APPLY and not collisions and not flags:
        for src, dst in plan:
            rel = os.path.relpath(src, ROOT)
            if rel in TRACKED:
                subprocess.run(["git", "mv", rel, os.path.relpath(dst, ROOT)], cwd=ROOT, check=True)
            else:
                os.rename(src, dst)
        print(f"\nDONE: {len(plan)} files renamed.")
    elif APPLY:
        print("\nABORTED: resolve collisions/flags first.")
    

if __name__ == '__main__':
    main()
