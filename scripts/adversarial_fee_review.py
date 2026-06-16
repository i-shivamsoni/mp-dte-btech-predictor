#!/usr/bin/env python3
"""
Adversarial review pass for unresolved AFRC fee matches.

This script does not change public fee data. It reads the existing extractor
review artifacts and produces judge-friendly CSVs:

  AFRC_Fees/fees_agent_evidence.csv
  AFRC_Fees/fees_manual_queue.csv
  AFRC_Fees/fees_resolved_historical.csv

The intent is to separate "resolved as historical / do not publish as current"
from genuinely ambiguous matches that need manual decision.
"""
from __future__ import annotations

import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "AFRC_Fees"

sys.path.insert(0, str(ROOT / "scripts"))
from preprocess import extract_city, norm_name  # noqa: E402


SUMMARY_PATH = OUT / "fees_remaining_summary.csv"
REVIEW_PATH = OUT / "fees_remaining_review.csv"
EVIDENCE_PATH = OUT / "fees_agent_evidence.csv"
MANUAL_PATH = OUT / "fees_manual_queue.csv"
HISTORICAL_PATH = OUT / "fees_resolved_historical.csv"

AFRC_URL = "https://web.afrcmp.org/feesinformation/frm_showinstitutes.aspx"

RISKY_GROUPS = (
    "bansal", "bhopal institute", "lakshmi narain", "lnct", "oriental",
    "sagar institute", "shri ram", "technocrat", "technocrats", "truba",
    "radha raman", "radharaman", "patel", "vindhya", "vikrant", "nri",
    "ies", "ips", "malwa", "bhabha", "millennium", "millenium",
)

GENERIC_LEADING_WORDS = {
    "the", "shri", "sri", "dr", "pt", "late", "school", "department",
    "faculty", "institute", "college", "university",
}


def read_csv(path: Path) -> List[dict]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: Iterable[dict], fields: List[str]) -> None:
    rows = list(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def clean(s: object) -> str:
    return re.sub(r"\s+", " ", str(s or "").replace("\xa0", " ")).strip()


def leading_token(s: str) -> str:
    for tok in norm_name(s).split():
        if tok not in GENERIC_LEADING_WORDS:
            return tok
    return ""


def parse_alt_score(alternatives: str, cid: str) -> float:
    for alt in parse_alternatives(alternatives):
        if alt["id"] == cid:
            return alt["score"]
    return 0.0


def parse_alternatives(alternatives: str) -> List[dict]:
    out: List[dict] = []
    for part in (alternatives or "").split(";"):
        part = part.strip()
        if not part:
            continue
        cid, name, score = "", "", 0.0
        bits = part.rsplit(":", 1)
        if len(bits) == 2:
            try:
                score = float(bits[1].strip())
            except ValueError:
                score = 0.0
            left = bits[0]
        else:
            left = part
        id_name = left.split(":", 1)
        if len(id_name) == 2:
            cid, name = id_name[0].strip(), id_name[1].strip()
        out.append({"id": cid, "name": name, "score": score})
    return out


def same_city(row: dict) -> bool:
    afrc_city = clean(row.get("afrc_place")) or extract_city(clean(row.get("afrc_address"))) or extract_city(clean(row.get("afrc_name")))
    candidate_city = extract_city(clean(row.get("best_college_name")))
    return bool(afrc_city and candidate_city and afrc_city.lower() == candidate_city.lower())


def risky_group(row: dict) -> str:
    text = norm_name(" ".join([
        clean(row.get("afrc_name")),
        clean(row.get("best_college_name")),
        clean(row.get("alternatives")),
    ]))
    hits = [g for g in RISKY_GROUPS if g in text]
    return ";".join(hits)


def alt_evidence(row: dict, colleges: Dict[str, dict], top_score: float) -> dict:
    afrc_city = clean(row.get("afrc_place")) or extract_city(clean(row.get("afrc_address"))) or extract_city(clean(row.get("afrc_name")))
    afrc_lead = leading_token(clean(row.get("afrc_name")))
    best_lead = leading_token(clean(row.get("best_college_name")))
    alternatives = parse_alternatives(clean(row.get("alternatives")))
    second = alternatives[1] if len(alternatives) > 1 else {}
    possible_current, same_brand_current = [], []
    for alt in alternatives:
        cid = alt["id"]
        if not cid or cid.startswith("h"):
            continue
        c = colleges.get(cid, {})
        if c.get("historical"):
            continue
        alt_lead = leading_token(alt["name"])
        close_to_top = bool(top_score and top_score - alt["score"] <= 0.08)
        high_score = alt["score"] >= 0.90
        alt_city = clean(c.get("city")) or extract_city(alt["name"])
        city_ok = bool(afrc_city and alt_city and afrc_city.lower() == alt_city.lower())
        address_city_ok = bool(alt_city and alt_city.lower() in clean(row.get("afrc_address")).lower())
        item = f"{cid}:{alt['name']}:{alt['score']:.3f}"
        if high_score or close_to_top:
            possible_current.append(item)
        if (high_score or close_to_top) and alt_lead in {afrc_lead, best_lead} and (city_ok or address_city_ok):
            same_brand_current.append(item)
    return {
        "second_college_id": second.get("id", ""),
        "second_college_name": second.get("name", ""),
        "second_score": second.get("score", 0.0),
        "score_gap": top_score - second.get("score", 0.0) if top_score and second else 0.0,
        "possible_current_alternatives": "; ".join(possible_current),
        "strong_current_alternative": "; ".join(same_brand_current),
    }


def review_key(row: dict) -> Tuple[str, str, str, str, str, str, str]:
    return (
        clean(row.get("status")),
        clean(row.get("afrc_name")),
        clean(row.get("afrc_place")),
        clean(row.get("afrc_address")),
        clean(row.get("best_college_id")),
        clean(row.get("best_college_name")),
        clean(row.get("match_reason")),
    )


def year_range(years: str) -> str:
    vals = []
    for y in re.split(r"[;, ]+", years or ""):
        if y.isdigit():
            vals.append(int(y))
    if not vals:
        return ""
    vals = sorted(set(vals))
    return str(vals[0]) if vals[0] == vals[-1] else f"{vals[0]}-{vals[-1]}"


def aggregate_review(rows: List[dict]) -> Dict[Tuple[str, str, str, str, str, str, str], dict]:
    grouped: Dict[Tuple[str, str, str, str, str, str, str], dict] = {}
    for row in rows:
        key = review_key(row)
        g = grouped.setdefault(key, {
            "scores": [],
            "raw_fee_texts": set(),
            "source_pages": set(),
            "branch_amounts": set(),
            "sessions": set(),
            "years": set(),
            "row_count_from_review": 0,
        })
        g["row_count_from_review"] += 1
        if clean(row.get("score")):
            try:
                g["scores"].append(float(row["score"]))
            except ValueError:
                pass
        for field, target in [
            ("raw_fee_text", "raw_fee_texts"),
            ("source_page", "source_pages"),
            ("branch_amounts", "branch_amounts"),
            ("session", "sessions"),
            ("year", "years"),
        ]:
            val = clean(row.get(field))
            if val:
                g[target].add(val)
    return grouped


def agent_a_reason(row: dict, score: float, city_ok: bool, risk: str) -> str:
    reason = clean(row.get("match_reason"))
    cid = clean(row.get("best_college_id"))
    if cid.startswith("h") and reason == "matched historical/defunct college":
        return "Best candidate is the exact/strong historical ID; resolve identity as historical, not current-public fee."
    if clean(row.get("status")) == "unmatched":
        return "No candidate is close enough for automatic matching."
    if reason == "leading name token differs":
        return "Top score exists, but the first distinctive name token differs from AFRC."
    if reason == "city/address hint conflicts":
        return "Name match conflicts with city/address evidence."
    if risk:
        return "Candidate is in a risky same-group namespace; alternatives must be compared manually."
    if score >= 0.90 and city_ok:
        return "Strong score and city agreement, but extractor already withheld it for review."
    return "Insufficient evidence for automatic public acceptance."


def agent_b_objection(row: dict, score: float, city_ok: bool, risk: str, strong_current_alt: str, possible_current_alt: str) -> str:
    reason = clean(row.get("match_reason"))
    cid = clean(row.get("best_college_id"))
    if clean(row.get("status")) == "unmatched":
        return "No reliable candidate to attack or accept; needs external source/name research."
    objections = []
    if cid.startswith("h"):
        objections.append("candidate is historical/defunct; do not attach to current college card")
    if strong_current_alt:
        objections.append("strong same-brand current alternative exists: " + strong_current_alt)
    elif possible_current_alt and cid.startswith("h"):
        objections.append("plausible current alternative exists: " + possible_current_alt)
    if not city_ok:
        objections.append("city/place evidence does not confirm the candidate")
    if reason == "leading name token differs":
        objections.append("distinctive leading token mismatch can indicate a different institute")
    if reason == "city/address hint conflicts":
        objections.append("address/city conflict overrides fuzzy name similarity")
    if risk:
        objections.append("same-group collision risk: " + risk)
    if score and score < 0.90:
        objections.append(f"score below 0.900 ({score:.3f})")
    return "; ".join(objections) if objections else "No major objection beyond extractor caution."


def judge(row: dict, score: float, city_ok: bool, risk: str, strong_current_alt: str, possible_current_alt: str) -> Tuple[str, str, str]:
    status = clean(row.get("status"))
    reason = clean(row.get("match_reason"))
    cid = clean(row.get("best_college_id"))
    afrc_lead = leading_token(clean(row.get("afrc_name")))
    cand_lead = leading_token(clean(row.get("best_college_name")))

    if status == "unmatched" or reason == "no close college name":
        return (
            "unmatched",
            "manual_research",
            "No candidate clears minimum identity evidence; needs external source or explicit manual mapping.",
        )
    if cid.startswith("h") and reason == "matched historical/defunct college":
        if strong_current_alt or possible_current_alt:
            return (
                "review_possible_current_remap",
                "manual_review",
                "Historical top match has a plausible current alternative; requires official source/manual mapping.",
            )
        if score < 0.88 or (afrc_lead and cand_lead and afrc_lead != cand_lead and not city_ok):
            return (
                "review_historical_match_ambiguous",
                "manual_review",
                "Historical candidate is weak, contradictory, or poorly supported.",
            )
        if score >= 0.88 and (city_ok or afrc_lead == cand_lead):
            return (
                "resolved_historical_exclude",
                "do_not_publish_current_fee",
                "Identity is resolved to a historical/defunct college ID; keep out of current public fee displays.",
            )
        return (
            "review_historical_match_ambiguous",
            "manual_review",
            "Historical candidate is not strong enough to resolve without human review.",
        )
    if reason == "city/address hint conflicts":
        return (
            "review_current_match_ambiguous",
            "manual_review",
            "Address/city conflict must be resolved by official source evidence.",
        )
    if reason == "leading name token differs":
        return (
            "review_current_match_ambiguous",
            "manual_review",
            "Distinctive leading token differs; likely wrong institute unless source proves alias/renaming.",
        )
    if reason == "close group-name alternatives" or risk:
        return (
            "review_current_match_ambiguous",
            "manual_review",
            "Same-group alternatives are too close for automatic acceptance.",
        )
    return (
        "review_current_match_ambiguous",
        "manual_review",
        "Extractor withheld this row; keep for manual review unless source-backed mapping is added.",
    )


def main() -> None:
    summary = read_csv(SUMMARY_PATH)
    review = read_csv(REVIEW_PATH)
    colleges = {
        c["id"]: c
        for c in json.loads((ROOT / "assets" / "data" / "colleges.json").read_text(encoding="utf-8"))["colleges"]
    }
    grouped = aggregate_review(review)

    evidence_rows: List[dict] = []
    for row in summary:
        key = review_key(row)
        agg = grouped.get(key, {})
        score = max(agg.get("scores", []) or [parse_alt_score(clean(row.get("alternatives")), clean(row.get("best_college_id")))])
        city_ok = same_city(row)
        risk = risky_group(row)
        alt = alt_evidence(row, colleges, score)
        current_alt = alt["strong_current_alternative"]
        possible_current_alt = alt["possible_current_alternatives"]
        judge_status, public_action, judge_reason = judge(row, score, city_ok, risk, current_alt, possible_current_alt)
        evidence_rows.append({
            "judge_status": judge_status,
            "public_action": public_action,
            "row_count": clean(row.get("row_count")),
            "review_row_count": agg.get("row_count_from_review", ""),
            "years": clean(row.get("years")),
            "year_range": year_range(clean(row.get("years"))),
            "afrc_name": clean(row.get("afrc_name")),
            "afrc_place": clean(row.get("afrc_place")),
            "afrc_address": clean(row.get("afrc_address")),
            "best_college_id": clean(row.get("best_college_id")),
            "best_college_name": clean(row.get("best_college_name")),
            "best_score": f"{score:.3f}" if score else "",
            "second_college_id": alt["second_college_id"],
            "second_college_name": alt["second_college_name"],
            "second_score": f"{alt['second_score']:.3f}" if alt["second_score"] else "",
            "score_gap": f"{alt['score_gap']:.3f}" if alt["score_gap"] else "",
            "match_reason": clean(row.get("match_reason")),
            "same_city": "yes" if city_ok else "no",
            "risky_group_terms": risk,
            "strong_current_alternative": current_alt,
            "possible_current_alternatives": possible_current_alt,
            "agent_a_matcher_reason": agent_a_reason(row, score, city_ok, risk),
            "agent_b_skeptic_objection": agent_b_objection(row, score, city_ok, risk, current_alt, possible_current_alt),
            "agent_c_historian_policy": "Historical IDs may be resolved for audit completeness but must not become current college fee display records.",
            "agent_e_judge_reason": judge_reason,
            "raw_fee_texts": " | ".join(sorted(agg.get("raw_fee_texts", []))),
            "branch_amounts": " | ".join(sorted(x for x in agg.get("branch_amounts", []) if x)),
            "sessions": ";".join(sorted(agg.get("sessions", []))),
            "source_pages": " | ".join(sorted(agg.get("source_pages", []))),
            "source_urls": AFRC_URL,
            "alternatives": clean(row.get("alternatives")),
        })

    fields = [
        "judge_status", "public_action", "row_count", "review_row_count", "years", "year_range",
        "afrc_name", "afrc_place", "afrc_address", "best_college_id", "best_college_name",
        "best_score", "second_college_id", "second_college_name", "second_score", "score_gap",
        "match_reason", "same_city", "risky_group_terms",
        "strong_current_alternative", "possible_current_alternatives",
        "agent_a_matcher_reason", "agent_b_skeptic_objection", "agent_c_historian_policy",
        "agent_e_judge_reason", "raw_fee_texts", "branch_amounts", "sessions",
        "source_pages", "source_urls", "alternatives",
    ]
    write_csv(EVIDENCE_PATH, evidence_rows, fields)
    write_csv(MANUAL_PATH, [r for r in evidence_rows if r["public_action"] != "do_not_publish_current_fee"], fields)
    write_csv(HISTORICAL_PATH, [r for r in evidence_rows if r["judge_status"] == "resolved_historical_exclude"], fields)

    counts = Counter(r["judge_status"] for r in evidence_rows)
    actions = Counter(r["public_action"] for r in evidence_rows)
    print(f"read {len(summary)} grouped unresolved cases from {SUMMARY_PATH.relative_to(ROOT)}")
    print("judge_status:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    print("public_action:", ", ".join(f"{k}={v}" for k, v in sorted(actions.items())))
    print(f"wrote {EVIDENCE_PATH.relative_to(ROOT)}")
    print(f"wrote {MANUAL_PATH.relative_to(ROOT)}")
    print(f"wrote {HISTORICAL_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
