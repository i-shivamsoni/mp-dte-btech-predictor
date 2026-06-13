#!/usr/bin/env python3
"""
preprocess.py — MP-DTE B.Tech predictor: raw JSON -> compact static web assets.

Reads the three raw data families and emits small, columnar JSON into assets/data/
for the Jekyll client to fetch. NO machine learning anywhere: the predictor is a
deterministic comparison of a student's rank against published historical closing
ranks. This script just shapes + indexes the data.

Inputs (committed, unchanged):
  DTE_CutOff_BTech/all_btech_cutoffs.json    65,600 cut-off rows (2017-2025)
  DTE_Intake_BTech/intake_BE_2026-27.json    674 seat-matrix rows (111 colleges)
  DTE_MeritList_BTech/BTech_MeritList_QE_*   3 qualifying-exam %-> rank merit lists

Outputs (assets/data/*.json, minified):
  branches.json  colleges.json  intake.json  cities.json  categories.json
  predictor_jee.json  predictor_qe.json  demand_stats.json  config.json

Run from anywhere: anchors to the project root (this file's parent's parent).
"""
import json, os, re, sys, collections, statistics

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CUTOFF = os.path.join(ROOT, "DTE_CutOff_BTech", "all_btech_cutoffs.json")
INTAKE = os.path.join(ROOT, "DTE_Intake_BTech", "intake_BE_2026-27.json")
MERITDIR = os.path.join(ROOT, "DTE_MeritList_BTech")
OUTDIR = os.path.join(ROOT, "assets", "data")

DATA_VERSION = "2026-06-13"

# Years the JEE predictor uses as the cut-off basis (recent = relevant; >=2 for bands).
JEE_YEARS = [2023, 2024, 2025]
# QE %-route: cut-off year <-> the merit-list file that converts % to a merit rank.
QE_YEAR_TO_MERIT = {2019: "2019", 2022: "2022-23", 2024: "2024-25"}

# ---------------------------------------------------------------------------
# Canonical branch taxonomy. id -> human label. Both cut-off codes and intake
# names are mapped into these ids so the UI shows one consistent branch list.
# ---------------------------------------------------------------------------
CANON = {
    "cse": "Computer Science & Engineering",
    "it": "Information Technology",
    "cs-it": "Computer Science & Information Technology",
    "cse-ai": "CSE (Artificial Intelligence)",
    "cse-aiml": "CSE (AI & Machine Learning)",
    "cse-ds": "CSE (Data Science)",
    "cse-cyber": "CSE (Cyber Security)",
    "cse-iot": "CSE (IoT)",
    "cse-bc": "CSE (Block Chain)",
    "cse-bs": "Computer Science & Business Systems",
    "cse-design": "Computer Science & Design",
    "ai": "Artificial Intelligence",
    "ai-ds": "AI & Data Science",
    "aiml": "AI & Machine Learning",
    "data-science": "Data Science",
    "math-comp": "Mathematics & Computing",
    "robotics-ai": "Robotics & Artificial Intelligence",
    "it-ai-robotics": "IT (AI & Robotics)",
    "automation-robotics": "Automation & Robotics",
    "civil": "Civil Engineering",
    "civil-comp": "Civil Engineering with Computer Application",
    "mech": "Mechanical Engineering",
    "auto": "Automobile Engineering",
    "mechatronics": "Mechatronics Engineering",
    "ip": "Industrial & Production Engineering",
    "mining": "Mining Engineering",
    "ece": "Electronics & Communication Engineering",
    "ec-adv": "Electronics & Communication (Adv. Comm. Tech.)",
    "etc": "Electronics & Telecommunication",
    "ee": "Electrical Engineering",
    "eee": "Electrical & Electronics Engineering",
    "elec-comp": "Electrical & Computer Engineering",
    "ei": "Electronics & Instrumentation",
    "electronics": "Electronics Engineering",
    "ec-cs": "Electronics & Computer Science",
    "ec-vlsi": "Electronics Engineering (VLSI Design & Tech.)",
    "ev": "Electric Vehicles",
    "iot": "Internet of Things",
    "chem": "Chemical Engineering",
    "petro": "Petrochemical Technology",
    "biotech": "Bio Technology",
    "bme": "Bio-Medical Engineering",
    "agri": "Agriculture Engineering",
    "food": "Food Technology",
    "dairy": "Dairy Technology",
    "fire-safety": "Fire Technology & Safety",
    # added to match the official 2026-27 branch-code list (rule book p.73-74)
    "comp-sci": "Computer Science",
    "cs-tech": "Computer Science & Technology",
    "cse-ai-ds": "CSE (AI & Data Science)",
    "cse-iot-cyber": "CSE (IoT, Cyber Security & Block Chain)",
    "cyber-security": "Cyber Security",
    "ee-iot": "Electrical Engineering (IoT)",
    "applied-ei": "Applied Electronics & Instrumentation",
    "elec-comp-eng": "Electronics & Computer Engineering",
    "robotics-mechatronics": "Robotics & Mechatronics",
    "mech-automation": "Mechanical & Automation Engineering",
    "aircraft-maintenance": "Aircraft Maintenance Engineering",
    "aeronautical": "Aeronautical Engineering",
    "biomedical-robotic": "Biomedical & Robotic Engineering",
    "civil-rural": "Civil & Rural Engineering",
    "construction-automation": "Construction Automation",
    "mining-mineral": "Mining & Mineral Processing",
    "iem": "Industrial Engineering & Management",
    "production": "Production Engineering",
    "animation-graphics": "3D Animation & Graphics",
    "textile": "Textile Technology",
    "other": "Other / Unclassified",
}

# Cut-off abbreviation -> canonical id, aligned to the OFFICIAL MP-DTE branch-code
# list (2026-27 rule book p.73-74). EACE/CEWCA/EAPE/LG are not in that list (best-effort).
CUTOFF_BRANCH = {
    "CSE": "cse", "CE": "civil", "MECH": "mech", "EC": "ece", "IT": "it", "EE": "ee",
    "ELECT ELEX": "eee", "ELECT ELE": "eee", "CSEIML": "cse-aiml", "CSEDS": "cse-ds",
    "EI": "ei", "CHEM": "chem", "AIAIDS": "ai-ds", "IP": "ip", "AUTO": "auto",
    "AIML": "aiml", "AIADS": "ai-ds", "CSECS": "cse-cyber", "CSIT": "cs-it",
    "CSBS": "cse-bs", "EL": "electronics", "ET": "etc", "CSEITCS": "cse-iot-cyber", "BM": "bme",
    "MINING": "mining", "CSD": "cse-design", "CSEAIADS": "cse-ai-ds", "PCT": "petro",
    "CSEIOT": "cse-iot", "MAC": "math-comp", "FTS": "fire-safety", "MTENG": "mechatronics",
    "ITAIAR": "it-ai-robotics", "INOT": "iot", "ITIOT": "iot", "CSEAI": "cse-ai",
    "CSEBC": "cse-bc", "EEIOT": "ee-iot", "ECS": "ec-cs", "AIR": "robotics-ai",
    "ECACT": "ec-adv", "AI": "ai", "BEIL": "bme", "CST": "cs-tech", "CSEIL": "cse",
    "CERE": "civil-rural", "FOOD": "food", "CEng": "cse", "BT": "biotech", "AG": "agri",
    "PCE": "petro", "AGE": "agri", "ARE": "automation-robotics", "CSERC": "cse",
    "EEVDT": "ec-vlsi", "CEWCA": "civil-comp", "EACE": "elec-comp", "CMPS": "comp-sci", "AGRITECH": "agri",
    "CYSEC": "cyber-security", "MMP": "mining-mineral", "EV": "ev", "MAE": "mech-automation",
    "CA": "construction-automation", "CSEAIDS": "cse-ai-ds", "EAPE": "other",
    "SFE": "fire-safety", "CSEIT": "cse-iot", "AME": "aircraft-maintenance",
    "RAM": "robotics-mechatronics", "LG": "other", "AEIE": "applied-ei", "DS": "data-science",
    "AERONAUTICAL": "aeronautical", "BRE": "biomedical-robotic", "COMP": "comp-sci",
    "ECOMME": "elec-comp-eng", "IEM": "iem", "PRODUCTION": "production",
    "DAG": "animation-graphics", "TX": "textile", "EX": "electronics", "IOT": "iot",
}

INTAKE_BRANCH = {
    "AGRICULTURAL ENGINEERING": "agri", "AGRICULTURE ENGINEERING": "agri",
    "ARTIFICIAL INTELLIGENCE": "ai", "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE": "ai-ds",
    "ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING": "aiml",
    "AUTOMATION AND ROBOTICS": "automation-robotics",
    "Artificial Intelligence (AI) and Data Science": "ai-ds",
    "Automobile Engineering": "auto", "Bio-Medical Engineering": "bme",
    "CIVIL ENGINEERING WITH COMPUTER APPLICATION": "civil-comp",
    "COMPUTER SCIENCE AND BUSINESS SYSTEM": "cse-bs",
    "COMPUTER SCIENCE AND ENGINEERING (ARTIFICIAL INTELLIGENCE AND DATA SCIENCE)": "cse-ai-ds",
    "COMPUTER SCIENCE AND ENGINEERING (ARTIFICIAL INTELLIGENCE)": "cse-ai",
    "COMPUTER SCIENCE AND ENGINEERING (BLOCK CHAIN)": "cse-bc",
    "COMPUTER SCIENCE AND ENGINEERING(ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING)": "cse-aiml",
    "COMPUTER SCIENCE AND ENGINEERING(CYBER SECURITY)": "cse-cyber",
    "COMPUTER SCIENCE AND ENGINEERING(DATA SCIENCE)": "cse-ds",
    "COMPUTER SCIENCE AND ENGINEERING(INTERNET OF THINGS AND CYBER SECURITY INCLUDING BLOCK CHAIN TECHNOLOGY)": "cse-iot-cyber",
    "COMPUTER SCIENCE AND ENGINEERING(IOT)": "cse-iot", "Chemical Engineering": "chem",
    "Civil Engineering": "civil", "Computer Engineering": "cse",
    "Computer Science & Engineering (Regional Courses-Hindi)": "cse",
    "Computer Science and Design": "cse-design", "Computer Science and Engineering": "cse",
    "Computer Science and Engineering-Indian language (Hindi)": "cse",
    "Computer Science and Information Technology": "cs-it",
    "Computer Science and Technology": "cs-tech", "DATA SCIENCE": "data-science",
    "Dairy Technology": "dairy", "ELECTRIC VEHICLES": "ev",
    "ELECTRICAL AND COMPUTER ENGINEERING": "elec-comp",
    "ELECTRONICS AND COMPUTER SCIENCE": "ec-cs",
    "ELECTRONICS ENGINEERING (VLSI DESIGN AND TECHNOLOGY)": "ec-vlsi",
    "Electrical & Electronics Engineering": "eee", "Electrical Engineering": "ee",
    "Electronics": "electronics", "Electronics & Instrumentation": "ei",
    "Electronics & Telecommunication": "etc",
    "Electronics and Communication (Advanced Communication Technology)": "ec-adv",
    "Electronics and Communication Engineering": "ece",
    "Electronics and Telecommunications": "etc", "Fire Tech & Safety": "fire-safety",
    "INFORMATION TECHNOLOGY(ARTIFICIAL INTELLIGENCE AND ROBOTICS)": "it-ai-robotics",
    "INTERNET OF THINGS(IOT)": "iot", "Industrial & Production Engineering": "ip",
    "Information Technology": "it", "MATHEMATICS AND COMPUTING": "math-comp",
    "MECHATRONICS ENGINEERING": "mechatronics", "MINING Eng": "mining",
    "Mechanical Engineering": "mech", "Petrochemical Technology": "petro",
    "ROBOTICS AND ARTIFICIAL INTELLIGENCE": "robotics-ai",
}

CATEGORIES = {  # social-field codebook shown on the methodology page
    "UR": "Unreserved / General", "OBC": "Other Backward Classes", "SC": "Scheduled Caste",
    "ST": "Scheduled Tribe", "EWS": "Economically Weaker Section",
    "FW": "Fee Waiver (TFW)", "JKM": "J&K Migrant", "JKR": "J&K Resident", "NTPC": "NTPC quota",
}
MAIN_CATEGORIES = ["UR", "OBC", "SC", "ST", "EWS", "FW"]

MP_CITIES = [
    "Bhopal", "Indore", "Jabalpur", "Gwalior", "Sagar", "Ujjain", "Khargone", "Rewa",
    "Vidisha", "Ratlam", "Raisen", "Sehore", "Dewas", "Khandwa", "Satna", "Chhindwara",
    "Betul", "Shivpuri", "Mandsaur", "Neemuch", "Dhar", "Burhanpur", "Sidhi", "Singrauli",
    "Damoh", "Chhatarpur", "Tikamgarh", "Guna", "Shajapur", "Narsinghpur", "Balaghat",
    "Morena", "Bhind", "Datia", "Sheopur", "Katni", "Panna", "Seoni", "Mandla", "Harda",
    "Barwani", "Jhabua", "Pithampur", "Hoshangabad", "Narmadapuram", "Gwalior",
]

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def norm_name(s):
    """Normalize an institute name for cross-dataset joining."""
    s = (s or "").lower()
    s = re.sub(r"\(\s*\d{4}\s*\)", " ", s)          # drop "(1996)" establishment year
    s = re.sub(r"[\-\s]*f\.?\s*w\.?", " ", s)        # drop "-F.W." / "F.W." markers
    s = re.sub(r"[^a-z0-9]+", " ", s)               # punctuation -> space
    s = re.sub(r"\bdeemed( to be)? university\b", " ", s)   # drop "(Deemed University)" qualifier
    return re.sub(r"\s+", " ", s).strip()

def extract_city(name):
    raw = None
    m = re.search(r",\s*([A-Za-z .]+?)\s*\(\s*\d{4}\s*\)\s*$", name or "")
    if m and m.group(1).strip():
        raw = m.group(1).strip()
    if raw:
        for c in MP_CITIES:                       # canonicalize casing/spelling (BHOPAL -> Bhopal)
            if raw.lower() == c.lower():
                return c
        return raw.title()
    low = (name or "").lower()
    for c in MP_CITIES:
        if re.search(r"\b" + re.escape(c.lower()) + r"\b", low):
            return c
    return None

def estd_year(name):
    m = re.search(r"\(\s*(\d{4})\s*\)", name or "")
    return int(m.group(1)) if m else None

def canon_branch_cutoff(code):
    if not code:
        return "other", True
    if re.search(r"telecommun|^electronic", code, re.I) or "s and Telecom" in code:
        return "etc", True
    if "MECH" in code.replace(".", "").replace("F", "").replace("W", "").upper() and "MINING" not in code.upper():
        pass  # handled below by exact map; garbled handled next
    g = code.upper().replace("F.W.", "").replace(".", "").replace("-", "").strip()
    if g in ("MECH", "MFWECH", "MWECH"):
        return "mech", True
    if "INING" in code.upper():
        return "mining", True
    if code in CUTOFF_BRANCH:
        return CUTOFF_BRANCH[code], True
    return "other", False

def to_int(v):
    return v if isinstance(v, int) else None

def round_code(source_pdf, round_title):
    """Derive a canonical round code from the PDF name, else the round title."""
    s = (source_pdf or "").upper()
    for pat, code in [("INTSL", "SL"), ("_SL", "SL"), ("_TR", "TR"), ("_QR", "QR"),
                      ("_FU", "FU"), ("_SR", "SR"), ("_RF", "RF"), ("_FR", "FR"),
                      ("_SP", "SP"), ("SPECIAL", "SP")]:
        if pat in s:
            return code
    t = (round_title or "").upper()
    if "QUALIFYING" in t:
        return "QR"
    if "INTERNAL BRANCH CHANGE" in t:
        return "SL"
    if "UPGRAD" in t:
        return "FU"
    if "SECOND ROUND" in t:
        return "SR"
    if "INTERMEDIATE" in t:
        return "SR"
    if "SPECIAL" in t:
        return "SP"
    if "FIRST ROUND" in t:
        return "RF"
    return "??"

JEE_ROUNDS = {"RF", "FR", "FU", "SR"}
QE_ROUNDS = {"TR", "QR"}

def universe(code):
    if code in JEE_ROUNDS:
        return "jee"
    if code in QE_ROUNDS:
        return "qe"
    return None  # SL / SP / ?? -> not used by predictor

def social_of(allotted_category):
    s = (str(allotted_category or "").split("/")[0]).strip().upper().replace("F.W.", "FW")
    return s or None

def gender_of(allotted_category):
    """Gender pool from the category code (SOCIAL/MIDDLE/GENDER). OP=open, F=female, M=male."""
    p = str(allotted_category or "").split("/")
    g = p[2] if len(p) >= 3 else (p[1] if len(p) == 2 else "")
    g = (g or "").strip().upper()
    return g if g in ("OP", "F", "M") else "OP"

def dom_of(domicile):
    """MP=home-state seat (Y), AI=all-India/open, OTHER=N, ''=unspecified (treat as open)."""
    return {"Y": "MP", "AI": "AI", "N": "OTHER"}.get(str(domicile or "").strip().upper(), "")

def write_json(name, obj):
    os.makedirs(OUTDIR, exist_ok=True)
    path = os.path.join(OUTDIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)

# ---------------------------------------------------------------------------
# load + build
# ---------------------------------------------------------------------------
def main():
    cutoffs = json.load(open(CUTOFF, encoding="utf-8"))
    intake_rows = json.load(open(INTAKE, encoding="utf-8"))["rows"]
    print(f"loaded {len(cutoffs):,} cut-off rows, {len(intake_rows)} intake rows")

    # ---- institute_type normalization (official MP-DTE categories) ----
    def norm_type_intake(t):
        u = (t or "").strip().upper()
        if u.startswith("PRIVATE"):       return "Private"
        if "BSF" in u or u.startswith("SELF FINANC"): return "Self Financing (Managed by BSF)"
        if "UNIVERSITY" in u:             return "University Owned"
        if "AUTONOM" in u:                return "Government Autonomous"
        if "AIDED" in u:                  return "Government Aided"
        if "GOVERNMENT" in u or "GOVT" in u: return "Government Autonomous"
        return "Private"

    def norm_type_cutoff(t):
        # historical colleges (cut-off-only) -> nearest official category
        t = (t or "").lower()
        if "aided" in t:                                  return "Government Aided"
        if "govt" in t:                                   return "Government Autonomous"
        if "f.i" in t or "private" in t or "rivate" in t: return "Private"
        return "Private"

    # ---- 1. colleges + intake seats (intake is authoritative; keyed by college_id) ----
    colleges = {}            # college_id -> meta
    intake_seats = {}        # college_id -> { branch_id -> seat dict }
    for r in intake_rows:
        cid = r["college_id"]
        name = r["institute_name"]
        if cid not in colleges:
            colleges[cid] = {
                "id": cid, "name": re.sub(r"\s*\(\d{4}\)\s*$", "", name).strip(),
                "city": extract_city(name), "estd": estd_year(name),
                "type": norm_type_intake(r.get("institute_type")),
                "university": r.get("university"),
                "minority": bool(r.get("minority_status")),
                "aicte": r.get("aicte_code"),
            }
        bid, _ = (INTAKE_BRANCH.get(r["branch"], "other"), True)
        seats = intake_seats.setdefault(cid, {})
        cur = seats.setdefault(bid, {"total": 0, "tfw": 0, "ews": False,
                                     "nri": 0, "ips": 0, "pio_fn": 0})
        cur["total"] += to_int(r.get("total_intake")) or 0
        cur["tfw"] += to_int(r.get("tfw_seats")) or 0
        cur["nri"] += to_int(r.get("nri_seats")) or 0
        cur["ips"] += to_int(r.get("ips_seats")) or 0
        cur["pio_fn"] += to_int(r.get("pio_fn_seats")) or 0
        if r.get("ews_seats"):
            cur["ews"] = True

    # join keys: several normalized variants per intake college -> id
    name_to_id = {}
    for cid, c in colleges.items():
        keys = {norm_name(c["name"])}
        nn = norm_name(c["name"])
        keys.add(re.sub(r"\b(institute|of|technology|technical|college|engineering|science|and|the|group|campus)\b", " ", nn).strip())
        for k in keys:
            k = re.sub(r"\s+", " ", k).strip()
            if k:
                name_to_id.setdefault(k, cid)

    def match_college(institute_name):
        nn = norm_name(institute_name)
        if nn in name_to_id:
            return name_to_id[nn]
        toks = nn.split()
        if len(toks) >= 4:                       # prefix heuristic on first words
            for n in (6, 5, 4):
                pref = " ".join(toks[:n])
                if pref in name_to_id:
                    return name_to_id[pref]
        return None

    # historical (cut-off-only) colleges with no 2026-27 intake row get a synthetic
    # entry so every prediction row still resolves to a real college name + city.
    synth = {}
    def synth_college(r):
        name = r.get("institute_name") or "Unknown institute"
        nn = norm_name(name)
        if nn in synth:
            return synth[nn]
        sid = "h" + str(len(synth) + 1)
        colleges[sid] = {
            "id": sid, "name": re.sub(r"\s*\(\d{4}\)\s*$", "", name).strip() or name,
            "city": extract_city(name), "estd": estd_year(name),
            "type": norm_type_cutoff(r.get("institute_type")), "university": None,
            "minority": False, "historical": True,
        }
        synth[nn] = sid
        return sid

    # Per-row HOME-STATE flag enforcing the official MP-domicile rules (R3/R7/R8/R9):
    #   home=1  -> seat is MP-domicile-only (reservation/TFW/EWS anywhere; UR at govt/aided/univ)
    #   home=0  -> seat is open to non-domicile (All-India seats; UR/general at PRIVATE colleges)
    def home_flag(r):
        dom = r.get("_dom")
        if dom in ("AI", "OTHER"):
            return 0
        if dom == "MP":
            return 1
        social = r.get("_social") or "UR"
        ctype = (colleges.get(r.get("_cid")) or {}).get("type", "")
        is_private = ctype.startswith("Private")
        if social == "UR":
            return 0 if is_private else 1          # private UR open to all; govt UR is MP-only
        return 1                                   # reserved / fee-waiver / special -> MP-only

    # ---- 2. annotate every cut-off row (round_code, universe, branch, college, pools) ----
    unmapped = collections.Counter()
    matched_rows = unmatched_rows = 0
    matched_2025 = total_2025 = 0
    for r in cutoffs:
        rc = round_code(r.get("source_pdf"), r.get("round"))
        r["_rc"] = rc
        r["_uni"] = universe(rc)
        bid, ok = canon_branch_cutoff(r.get("branch"))
        r["_bid"] = bid
        if not ok:
            unmapped[r.get("branch")] += 1
        real = match_college(r.get("institute_name"))
        r["_cid"] = real if real else synth_college(r)
        r["_social"] = social_of(r.get("allotted_category"))
        r["_gender"] = gender_of(r.get("allotted_category"))
        r["_dom"] = dom_of(r.get("domicile"))
        r["_home"] = home_flag(r)
        if r.get("year") == 2025:
            total_2025 += 1
            if real:
                matched_2025 += 1
        if real:
            matched_rows += 1
        else:
            unmatched_rows += 1

    # de-dupe split colleges: a synthetic (historical) entry whose normalized name is a leading
    # prefix of a real intake college (e.g. a cut-off name missing the trailing city) is the SAME
    # college -> remap its rows to the real id and drop the synthetic, so it isn't listed twice.
    real_norm = {norm_name(c["name"]): cid for cid, c in colleges.items() if not c.get("historical")}
    remap = {}
    for hid, c in list(colleges.items()):
        if not c.get("historical"):
            continue
        hn = norm_name(c["name"]); ht = hn.split()
        tgt = real_norm.get(hn)
        if not tgt and len(ht) >= 4:
            for rn, rid in real_norm.items():
                rt = rn.split()
                if len(rt) >= 4 and rt[:len(ht)] == ht:    # historical name is a prefix of the real name
                    tgt = rid; break
        if tgt and tgt != hid:
            remap[hid] = tgt
    if remap:
        for r in cutoffs:
            if r["_cid"] in remap:
                r["_cid"] = remap[r["_cid"]]
        for hid in remap:
            colleges.pop(hid, None)
        print(f"de-duped {len(remap)} split college entries: {', '.join(sorted(remap))}")

    # colleges that appear in cut-offs but not in 2026-27 intake -> historical entries
    seen_ids = {r["_cid"] for r in cutoffs if r["_cid"]}
    # (intake colleges already in `colleges`; historical-only handled in UI via null seats)

    COLS = ["c", "b", "yr", "rd", "cat", "gen", "fw", "dom", "home", "op", "cl", "al"]
    def row_of(r, cl):
        return [
            r["_cid"], r["_bid"], r["year"], r["_rc"], r.get("_social") or "UR",
            r.get("_gender") or "OP", 1 if (r.get("fw") == "Y") else 0, r.get("_dom") or "",
            r.get("_home", 1),
            to_int(r.get("opening_rank")) or cl, cl, to_int(r.get("total_allotted")) or 0,
        ]

    # ---- 3. predictor_jee.json (columnar) ----
    jee_cols = COLS
    jee_data = []
    for r in cutoffs:
        if r["_uni"] != "jee" or r["year"] not in JEE_YEARS:
            continue
        cl = to_int(r.get("closing_rank"))
        if cl is None:
            continue
        jee_data.append(row_of(r, cl))

    # ---- 4. predictor_qe.json (columnar) + percentile lookup ----
    qe_data = []
    for r in cutoffs:
        if r["_uni"] != "qe" or r["year"] not in QE_YEAR_TO_MERIT:
            continue
        cl = to_int(r.get("closing_rank"))
        if cl is None:
            continue
        qe_data.append(row_of(r, cl))
    # % -> merit-rank lookup, one breakpoint per 0.1% bucket (min rank in bucket)
    percentile = {}
    for cyear, mtag in QE_YEAR_TO_MERIT.items():
        path = os.path.join(MERITDIR, f"BTech_MeritList_QE_{mtag}.json")
        if not os.path.exists(path):
            continue
        ml = json.load(open(path, encoding="utf-8"))
        ml = ml if isinstance(ml, list) else (ml.get("rows") or ml.get("candidates") or [])
        buckets = {}
        for c in ml:
            pct = c.get("qualifying_exam_percentage")
            rk = c.get("rank")
            if not isinstance(rk, int) or pct is None:
                continue
            key = round(float(pct), 1)
            buckets[key] = min(buckets.get(key, rk), rk)
        pts = sorted(buckets.items(), key=lambda kv: -kv[0])     # high % -> low rank first
        percentile[str(cyear)] = {"pct": [p for p, _ in pts], "rank": [r for _, r in pts]}
    # CI / privacy fallback: the raw merit lists carry student PII and are git-ignored, so they
    # may be absent. Reuse the committed percentile lookup (PII-free) when they are.
    if not percentile:
        prev_path = os.path.join(OUTDIR, "predictor_qe.json")
        if os.path.exists(prev_path):
            try:
                percentile = json.load(open(prev_path)).get("percentile", {})
                print("merit lists absent -> reused committed QE percentile lookup")
            except Exception:
                pass

    # ---- 5. demand_stats.json (aggregate across rounds+pools by college,branch,year) ----
    agg = collections.defaultdict(lambda: {"seats": 0, "closings": []})
    for r in cutoffs:
        if r["_uni"] != "jee":
            continue
        cl = to_int(r.get("closing_rank"))
        if cl is None:
            continue
        a = agg[(r["_cid"], r["_bid"], r["year"])]
        a["seats"] += to_int(r.get("total_allotted")) or 0
        a["closings"].append(cl)

    def med(xs):
        return int(statistics.median(xs)) if xs else None

    latest = max(JEE_YEARS)
    by_branch = collections.defaultdict(lambda: {"seats": 0, "closings": []})
    by_college = collections.defaultdict(lambda: {"seats": 0, "closings": []})
    by_city = collections.Counter()
    trend = collections.defaultdict(dict)            # branch -> {year: median closing}
    yr_branch = collections.defaultdict(lambda: collections.defaultdict(list))
    for (cid, bid, yr), a in agg.items():
        if yr == latest:
            bb = by_branch[bid]; bb["seats"] += a["seats"]; bb["closings"] += a["closings"]
            if cid and not colleges.get(cid, {}).get("historical"):
                cc = by_college[cid]; cc["seats"] += a["seats"]; cc["closings"] += a["closings"]
                city = colleges.get(cid, {}).get("city")
                if city:
                    by_city[city] += a["seats"]
        yr_branch[bid][yr] += a["closings"]
    for bid, yd in yr_branch.items():
        for yr, cls in yd.items():
            if cls:
                trend[bid][yr] = med(cls)

    # "Most in-demand" = most seats actually filled (popularity). Median closing is a poor
    # demand signal for branches because it's diluted by how many easy colleges offer them
    # (e.g. CSE has the most seats + the single most competitive seat, but a high median).
    demand_branches = sorted(
        [{"b": bid, "label": CANON.get(bid, bid), "seats": v["seats"],
          "median": med(v["closings"]), "best": min(v["closings"]) if v["closings"] else None}
         for bid, v in by_branch.items() if v["closings"]],
        key=lambda x: -x["seats"])
    demand_colleges = sorted(
        [{"c": cid, "name": colleges.get(cid, {}).get("name", cid),
          "city": colleges.get(cid, {}).get("city"),
          "type": colleges.get(cid, {}).get("type"), "seats": v["seats"],
          "median": med(v["closings"]), "best": min(v["closings"]) if v["closings"] else None}
         for cid, v in by_college.items() if v["closings"]],
        key=lambda x: (x["median"] is None, x["median"]))

    # ---- branch-wise priority ("demand list"): per branch, colleges ranked by demand ----
    # Pure revealed preference: WITHIN each branch, the more competitive the OPEN/general seat
    # (lower closing rank), the higher the priority. Score = median UR/OP closing per year, then
    # median across the last 5 years (robust to 1-seat outliers / year noise). This is PER BRANCH
    # (a college can top CSE yet sit mid-pack for Mech) — students choose by branch, so one whole-
    # college ranking would mislead. No institute-type adjustment: the data alone decides the order.
    DEMAND_YEARS = set(range(2021, 2026))
    cb_year = collections.defaultdict(lambda: collections.defaultdict(
        lambda: {"ur": [], "all": []}))               # (cid,bid) -> year -> {ur:[], all:[]}
    for r in cutoffs:
        if r["_uni"] != "jee" or r["year"] not in DEMAND_YEARS or not r["_cid"]:
            continue
        cl = to_int(r.get("closing_rank"))
        if cl is None:
            continue
        slot = cb_year[(r["_cid"], r["_bid"])][r["year"]]
        slot["all"].append(cl)
        if (r.get("_social") or "UR") == "UR" and (r.get("_gender") or "OP") == "OP" and r.get("fw") != "Y":
            slot["ur"].append(cl)                     # open/general seat = cleanest demand signal
    cb_score = {}
    for (cid, bid), yd in cb_year.items():
        yr_meds = [statistics.median(s["ur"] or s["all"]) for s in yd.values() if (s["ur"] or s["all"])]
        if yr_meds:
            cb_score[(cid, bid)] = int(statistics.median(yr_meds))
    branch_priority = {}                              # branchId -> [[collegeId, demandClosing], ...] best-first
    by_branch_cb = collections.defaultdict(list)
    for (cid, bid), sc in cb_score.items():
        by_branch_cb[bid].append((cid, sc))
    for bid, lst in by_branch_cb.items():
        lst.sort(key=lambda x: (x[1], x[0]))          # demand score asc (pure data); id = stable tiebreak
        branch_priority[bid] = [[cid, sc] for cid, sc in lst]

    # branch movement (revealed preference) from Internal Branch Change rows
    mv = collections.defaultdict(lambda: {"into": 0, "out": 0})
    for r in cutoffs:
        if r["_rc"] != "SL" or r.get("remarks") != "CHANGE":
            continue
        # allotted_category holds the post-change branch context in some rows; we use the
        # row's branch as the destination branch a student moved INTO.
        mv[r["_bid"]]["into"] += to_int(r.get("total_allotted")) or 1
    movement = sorted(
        [{"b": bid, "label": CANON.get(bid, bid), "into": d["into"]} for bid, d in mv.items()],
        key=lambda x: -x["into"])[:20]

    demand = {
        "latest_year": latest, "year_min": 2017, "year_max": 2025,
        "branches": demand_branches, "colleges": demand_colleges[:60],
        "trend": {b: trend[b] for b in [d["b"] for d in demand_branches[:10]]},
        "by_city": [{"city": c, "seats": n} for c, n in by_city.most_common()],
        "branch_movement": movement,
        "branch_priority": branch_priority,      # branchId -> [[collegeId, demandClosing], ...] best-first
    }

    # ---- 6. write assets ----
    sizes = {}
    sizes["branches.json"] = write_json("branches.json", {
        "branches": [{"id": k, "label": v} for k, v in CANON.items()]})
    sizes["categories.json"] = write_json("categories.json", {
        "codebook": CATEGORIES, "main": MAIN_CATEGORIES})
    cities_sorted = sorted({c["city"] for c in colleges.values()
                            if c["city"] and not c.get("historical")})
    sizes["cities.json"] = write_json("cities.json", {"cities": cities_sorted})
    inst_types = sorted({c["type"] for c in colleges.values() if c.get("type")})
    sizes["colleges.json"] = write_json("colleges.json", {
        "colleges": list(colleges.values()), "types": inst_types})
    sizes["intake.json"] = write_json("intake.json", {"seats": intake_seats})
    sizes["predictor_jee.json"] = write_json("predictor_jee.json", {
        "columns": jee_cols, "years": JEE_YEARS, "rows": jee_data})
    sizes["predictor_qe.json"] = write_json("predictor_qe.json", {
        "columns": jee_cols, "years": sorted(QE_YEAR_TO_MERIT), "rows": qe_data,
        "percentile": percentile})
    sizes["demand_stats.json"] = write_json("demand_stats.json", demand)
    sizes["config.json"] = write_json("config.json", {
        "data_version": DATA_VERSION,
        "flags": {"percentage_enabled": True},
        "percentage_years": sorted(QE_YEAR_TO_MERIT),
        "jee_years": JEE_YEARS,
        "institute_types": inst_types,
        "gender_options": [["M", "Male"], ["F", "Female"]],
        "domicile_options": [["mp", "Madhya Pradesh (domicile)"], ["other", "Other state (non-domicile)"]],
        "eligibility_note": ("Predictions default to the open pool plus your selected category, "
                             "gender and domicile. Reservation / fee-waiver / non-domicile / "
                             "female-pool eligibility is not fully confirmed by this data — "
                             "verify with DTE."),
    })

    # ---- 7. report / asserts ----
    print("\n=== PIPELINE REPORT ===")
    print(f"cut-off->college join: {matched_rows:,} matched, {unmatched_rows:,} unmatched "
          f"({100*matched_rows/len(cutoffs):.1f}%)")
    print(f"2025 join rate (active colleges): {matched_2025}/{total_2025} "
          f"({100*matched_2025/max(total_2025,1):.1f}%)")
    print(f"predictor_jee rows: {len(jee_data):,}  predictor_qe rows: {len(qe_data):,}")
    print(f"qe percentile years: {sorted(percentile)}")
    print(f"demand branches: {len(demand_branches)}  colleges: {len(demand_colleges)}")
    unmapped_total = sum(unmapped.values())
    print(f"unmapped branch rows: {unmapped_total:,} ({100*unmapped_total/len(cutoffs):.2f}%) "
          f"-> {dict(unmapped.most_common(8))}")
    print("\nasset sizes:")
    for k, v in sorted(sizes.items()):
        print(f"  {k:24s} {v/1024:8.1f} KB")
    print(f"  {'TOTAL':24s} {sum(sizes.values())/1024:8.1f} KB")

    assert len(jee_data) > 8000, "JEE predictor unexpectedly small"
    assert percentile, "no QE percentile lookup built"
    assert matched_2025 / max(total_2025, 1) > 0.6, "2025 join rate too low"
    assert unmapped_total / len(cutoffs) < 0.02, "too many unmapped branch rows"
    print("\nAll asserts passed.")


if __name__ == "__main__":
    main()
