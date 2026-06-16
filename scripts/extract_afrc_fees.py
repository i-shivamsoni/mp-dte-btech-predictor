#!/usr/bin/env python3
"""
Extract AFRC B.E./B.Tech fee information into static site data.

Inputs:
  fees.xml                         optional Burp XML export of AFRC pages
  assets/data/colleges.json        current + historical college index

Outputs:
  assets/data/fees.json            accepted, app-ready fee records
  AFRC_Fees/fees_match_review.csv  all AFRC rows with match status/reasons

The public AFRC table labels the amount as "Semester wise Fees (in Rs)".
This script preserves that unit as semester_fee_rs and keeps raw_fee_text
whenever AFRC includes branch-specific notes.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
OUT_DATA = ROOT / "assets" / "data"
OUT_AUDIT = ROOT / "AFRC_Fees"
AFRC_URL = "https://web.afrcmp.org/feesinformation/frm_showinstitutes.aspx"

sys.path.insert(0, str(ROOT / "scripts"))
from preprocess import CANON, extract_city, norm_name  # noqa: E402


@dataclass(frozen=True)
class FeeRow:
    year: int
    session: str
    afrc_name: str
    address: str
    place: str
    raw_fee_text: str
    source_page: str


STREAMS = {
    "T": ("rblstream$2", "Technical Education"),
    "U": ("rblstream$3", "University"),
}


@dataclass
class Match:
    status: str
    college_id: str = ""
    college_name: str = ""
    score: float = 0.0
    reason: str = ""
    alternatives: str = ""


def parse_years(spec: str) -> List[int]:
    years: List[int] = []
    for part in re.split(r"[, ]+", spec.strip()):
        if not part:
            continue
        if "-" in part:
            a, b = [int(x) for x in part.split("-", 1)]
            years.extend(range(a, b + 1))
        else:
            years.append(int(part))
    return sorted(set(years))


def clean_text(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").replace("\xa0", " ")).strip()


def selected_option(soup: BeautifulSoup, element_id: str) -> Tuple[str, str]:
    sel = soup.find(id=element_id)
    if not sel:
        return "", ""
    opt = sel.find("option", selected=True) or sel.find("option")
    if not opt:
        return "", ""
    return opt.get("value", ""), clean_text(opt.get_text(" ", strip=True))


def grid_rows_from_soup(soup: BeautifulSoup, year: int, source_page: str) -> List[FeeRow]:
    table = soup.find(id="grdShowInstitutes")
    if not table:
        return []
    out: List[FeeRow] = []
    for tr in table.find_all("tr"):
        cells = [clean_text(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"])]
        if len(cells) < 5 or not cells[0].isdigit():
            continue
        if all(c.isdigit() for c in cells if c):
            continue  # GridView pager row
        name, address, place, raw_fee = cells[1], cells[2], cells[3], cells[4]
        if not name or not raw_fee or "no records" in name.lower():
            continue
        out.append(FeeRow(
            year=year,
            session=f"{year}-{year + 1}",
            afrc_name=name,
            address=address,
            place=place,
            raw_fee_text=raw_fee,
            source_page=source_page,
        ))
    return out


def parse_burp_xml(path: Path, wanted_years: Sequence[int]) -> List[FeeRow]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="replace").replace("\x00", "")
    items = re.findall(r"<item>.*?</item>", text, re.S)
    rows: List[FeeRow] = []
    for idx, item in enumerate(items):
        m = re.search(r'<response base64="false"><!\[CDATA\[(.*?)\]\]></response>', item, re.S)
        if not m:
            continue
        body = re.split(r"\r?\n\r?\n", m.group(1), maxsplit=1)[-1]
        soup = BeautifulSoup(body, "html.parser")
        _, program = selected_option(soup, "ddlProgram")
        year_value, year_text = selected_option(soup, "ddlYear")
        if "B.E./B.Tech" not in program:
            continue
        try:
            year = int(year_value or year_text[:4])
        except ValueError:
            continue
        if year not in wanted_years:
            continue
        rows.extend(grid_rows_from_soup(soup, year, f"fees.xml:item:{idx}"))
    return rows


class AFRCClient:
    def __init__(self, stream: str = "T", timeout: int = 30, delay: float = 0.15):
        if stream not in STREAMS:
            raise ValueError(f"unsupported AFRC stream {stream!r}; expected one of {', '.join(STREAMS)}")
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (compatible; mpDTE-fee-extractor/1.0)",
            "Referer": AFRC_URL,
            "Origin": "https://web.afrcmp.org",
        })
        self.stream = stream
        self.timeout = timeout
        self.delay = delay
        self.soup: Optional[BeautifulSoup] = None
        self.state: Dict[str, str] = {}

    def _state_from_delta(self, text: str) -> Dict[str, str]:
        return {k: v for k, v in re.findall(r"\|hiddenField\|([^|]+)\|([^|]*)\|", text)}

    def _controls(self) -> Dict[str, str]:
        soup = self.soup
        if soup is None:
            return dict(self.state)
        data = dict(self.state)
        for inp in soup.find_all("input"):
            name = inp.get("name")
            typ = (inp.get("type") or "").lower()
            if not name or typ in ("submit", "button", "image", "file"):
                continue
            if typ in ("radio", "checkbox") and not inp.has_attr("checked"):
                continue
            data[name] = inp.get("value", "")
        for sel in soup.find_all("select"):
            name = sel.get("name")
            if not name:
                continue
            opt = sel.find("option", selected=True) or sel.find("option")
            data[name] = opt.get("value", "") if opt else ""
        return data

    def _ajax(self, data: Dict[str, str]) -> BeautifulSoup:
        payload = dict(data)
        payload["__ASYNCPOST"] = "true"
        r = self.session.post(
            AFRC_URL,
            data=payload,
            headers={"X-MicrosoftAjax": "Delta=true", "X-Requested-With": "XMLHttpRequest"},
            timeout=self.timeout,
        )
        r.raise_for_status()
        if "pageRedirect" in r.text or "oops.aspx" in r.text.lower():
            raise RuntimeError("AFRC returned an error page/redirect")
        self.state.update(self._state_from_delta(r.text))
        self.soup = BeautifulSoup(r.text, "html.parser")
        time.sleep(self.delay)
        return self.soup

    def start(self) -> None:
        r = self.session.get(AFRC_URL, timeout=self.timeout)
        r.raise_for_status()
        self.soup = BeautifulSoup(r.text, "html.parser")
        self.state = {k: v for k, v in self._controls().items() if k.startswith("__")}
        stream_target, _ = STREAMS[self.stream]
        data = self._controls()
        data.update({
            "ScriptManager1": f"UPmain|{stream_target}",
            "__EVENTTARGET": stream_target,
            "__EVENTARGUMENT": "",
            "rblstream": self.stream,
        })
        self._ajax(data)
        data = self._controls()
        data.update({
            "ScriptManager1": "UPmain|DdlDivision",
            "__EVENTTARGET": "DdlDivision",
            "__EVENTARGUMENT": "",
            "rblstream": self.stream,
            "ddlProgram": "1",
            "DdlDivision": "0",
            "DdlDistrict": "32",
            "DdlPlace": "Bhopal",
            "ddlShowInstitute": "0",
        })
        self._ajax(data)

    def show_year(self, year: int) -> BeautifulSoup:
        data = self._controls()
        data.update({
            "ScriptManager1": "UPmain|btnShow",
            "__EVENTTARGET": "",
            "__EVENTARGUMENT": "",
            "rblstream": self.stream,
            "ddlProgram": "1",
            "ddlYear": str(year),
            "DdlDivision": "0",
            "DdlDistrict": "0",
            "DdlPlace": "0",
            "ddlShowInstitute": "0",
            "btnShow": "Show",
        })
        return self._ajax(data)

    def page(self, year: int, page_no: int) -> BeautifulSoup:
        data = self._controls()
        data.update({
            "ScriptManager1": "UPmain|grdShowInstitutes",
            "__EVENTTARGET": "grdShowInstitutes",
            "__EVENTARGUMENT": f"Page${page_no}",
            "rblstream": self.stream,
            "ddlProgram": "1",
            "ddlYear": str(year),
            "DdlDivision": "0",
            "DdlDistrict": "0",
            "DdlPlace": "0",
            "ddlShowInstitute": "0",
        })
        return self._ajax(data)

    def max_pages(self, soup: BeautifulSoup) -> int:
        pages = [1]
        table = soup.find(id="grdShowInstitutes")
        if not table:
            return 1
        for a in table.find_all("a", href=True):
            m = re.search(r"Page\$(\d+)", a["href"])
            if m:
                pages.append(int(m.group(1)))
        return max(pages)

    def fetch_year(self, year: int) -> List[FeeRow]:
        soup = self.show_year(year)
        rows = grid_rows_from_soup(soup, year, f"AFRC:{self.stream}:{year}:page:1")
        max_page = self.max_pages(soup)
        for page_no in range(2, max_page + 1):
            soup = self.page(year, page_no)
            rows.extend(grid_rows_from_soup(soup, year, f"AFRC:{self.stream}:{year}:page:{page_no}"))
        return rows


def parse_streams(spec: str) -> List[str]:
    streams = [s.strip().upper() for s in re.split(r"[, ]+", spec or "") if s.strip()]
    bad = [s for s in streams if s not in STREAMS]
    if bad:
        raise ValueError(f"unsupported AFRC stream(s): {', '.join(bad)}")
    return streams or ["T", "U"]


def fetch_live_rows(years: Sequence[int], streams: Sequence[str]) -> List[FeeRow]:
    rows: List[FeeRow] = []
    for stream in streams:
        _, stream_label = STREAMS[stream]
        for year in years:
            print(f"fetching AFRC {stream_label} {year}-{year + 1}...", flush=True)
            # AFRC is an ASP.NET WebForms app; reusing one view-state session while
            # changing years can leave the GridView pager on stale pages. Start a
            # fresh session per stream/year so every year is fetched from page 1 onward.
            client = AFRCClient(stream=stream)
            client.start()
            rows.extend(client.fetch_year(year))
    return rows


def dedupe_rows(rows: Iterable[FeeRow]) -> List[FeeRow]:
    seen = set()
    out: List[FeeRow] = []
    for r in rows:
        key = (r.year, norm_name(r.afrc_name), norm_name(r.address), norm_name(r.place), clean_text(r.raw_fee_text))
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    out.sort(key=lambda x: (x.year, norm_name(x.afrc_name), x.raw_fee_text))
    return out


RISKY_GROUP_WORDS = (
    "bansal", "bhopal institute", "lakshmi narain", "lnct", "oriental", "sagar institute",
    "shri ram", "technocrats", "truba", "radha raman", "radharaman", "patel",
    "vindhya", "vikrant", "nri", "ies", "ips", "malwa", "bhabha",
)
GENERIC_LEADING_WORDS = {
    "the", "shri", "sri", "dr", "pt", "school", "department", "faculty",
    "institute", "college", "university",
}


MANUAL_MATCHES = {
    # Keep this small and auditable; fuzzy matching handles the ordinary punctuation variants.
    ("b t institute of research technology sagar", "sagar"): "033",
    "bansal college of engineering": "039",
    ("bansal institute of research technology", "bhopal"): "042",
    ("iess college of technology", "bhopal"): "135",
    ("institute of technology management itm universe campus opp sithouli railway station nh 75 jhansi road gwalior mp 475001", "gwalior"): "162",
    ("lakshmi narain college of technology", "bhopal"): "213",
    ("patel group of institutions patel college of science technology indore", "indore"): "339",
    ("prashanti institute of technology science", "ujjain"): "354",
    ("rustam ji institute of technology", "gwalior"): "396",
    ("sagar institute of research technology", "bhopal"): "429",
    ("sagar institute of science technology", "bhopal"): "435",
    ("sagar institute of science technology and engineering", "bhopal"): "438",
    ("shashib college of technology", "bhopal"): "477",
    ("shreejee inst of tech mgmt", "khargone"): "484",
    ("shri yogindra sagar institute of technology science", "ratlam"): "516",
    ("technocrat institute of technology", "bhopal"): "561",
    ("vaishnavi inst of tech science", "bhopal"): "590",
}


def city_hint(row: FeeRow) -> str:
    for raw in (row.place, row.address, row.afrc_name):
        city = extract_city(raw)
        if city:
            return city
    return ""


def score_name(query: str, candidate: str, same_city: bool) -> float:
    if query == candidate:
        return 1.0
    if candidate.startswith(query + " ") or query.startswith(candidate + " "):
        base = 0.96
    elif query in candidate or candidate in query:
        base = 0.93
    else:
        base = SequenceMatcher(None, query, candidate).ratio()
    if same_city:
        base += 0.04
    return min(base, 1.0)


def leading_token(s: str) -> str:
    for tok in (s or "").split():
        if tok not in GENERIC_LEADING_WORDS:
            return tok
    return ""


def match_college(row: FeeRow, colleges: Sequence[dict]) -> Match:
    q = norm_name(row.afrc_name)
    hint = city_hint(row)
    manual_key = (q, norm_name(hint))
    if manual_key in MANUAL_MATCHES or q in MANUAL_MATCHES:
        cid = MANUAL_MATCHES.get(manual_key) or MANUAL_MATCHES[q]
        c = next((x for x in colleges if x["id"] == cid), None)
        if c:
            return Match("accepted", cid, c.get("name", ""), 1.0, "manual")

    scored = []
    for c in colleges:
        cn = norm_name(c.get("name", ""))
        same_city = bool(hint and c.get("city") and hint.lower() == str(c.get("city")).lower())
        score = score_name(q, cn, same_city)
        scored.append((score, c, same_city, cn))
    scored.sort(key=lambda x: x[0], reverse=True)
    if not scored or scored[0][0] < 0.62:
        return Match("unmatched", score=scored[0][0] if scored else 0.0, reason="no close college name")

    top_score, top, same_city, top_norm = scored[0]
    second_score = scored[1][0] if len(scored) > 1 else 0.0
    gap = top_score - second_score
    alternatives = "; ".join(
        f"{c.get('id')}:{c.get('name')}:{score:.3f}" for score, c, _, _ in scored[:3]
    )

    if top.get("historical"):
        return Match("doubtful", top["id"], top.get("name", ""), top_score, "matched historical/defunct college", alternatives)
    if q == top_norm:
        return Match("accepted", top["id"], top.get("name", ""), top_score, "exact normalized name", alternatives)
    qlead, clead = leading_token(q), leading_token(top_norm)
    if qlead and clead and qlead != clead and top_score < 0.96:
        return Match("doubtful", top["id"], top.get("name", ""), top_score, "leading name token differs", alternatives)
    if hint and top.get("city") and hint.lower() != str(top.get("city")).lower() and top_score < 0.94:
        return Match("doubtful", top["id"], top.get("name", ""), top_score, "city/address hint conflicts", alternatives)
    risky = any(w in q for w in RISKY_GROUP_WORDS)
    if risky and gap < 0.035:
        return Match("doubtful", top["id"], top.get("name", ""), top_score, "close group-name alternatives", alternatives)
    if top_score >= 0.88 and (same_city or gap >= 0.08):
        return Match("accepted", top["id"], top.get("name", ""), top_score, "high-confidence fuzzy match", alternatives)
    if top_score >= 0.94 and gap >= 0.04:
        return Match("accepted", top["id"], top.get("name", ""), top_score, "high-confidence name match", alternatives)
    return Match("doubtful", top["id"], top.get("name", ""), top_score, "below acceptance threshold", alternatives)


AMOUNT_RE = re.compile(r"(?:rs\.?\s*)?([0-9]{2,3}(?:,[0-9]{3})+|[0-9]{4,6})(?:\.\d+)?", re.I)


def parse_amounts(raw: str) -> List[Tuple[int, Tuple[int, int]]]:
    out: List[Tuple[int, Tuple[int, int]]] = []
    for m in AMOUNT_RE.finditer(raw or ""):
        amt = int(m.group(1).replace(",", ""))
        if 10000 <= amt <= 300000:
            out.append((amt, m.span()))
    return out


def norm_branch(s: str) -> str:
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\band\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def branch_aliases() -> List[Tuple[str, str]]:
    aliases: Dict[str, str] = {}
    for bid, label in CANON.items():
        if bid == "other":
            continue
        n = norm_branch(label)
        if len(n) >= 7:
            aliases[n] = bid
        aliases[norm_branch(label.replace("&", "and"))] = bid
    aliases.update({
        "computer science engineering": "cse",
        "computer science": "cse",
        "electronics communication engineering": "ece",
        "electrical electronics engineering": "eee",
        "electrical engineering": "ee",
        "mechanical engineering": "mech",
        "civil engineering": "civil",
        "information technology": "it",
    })
    return sorted(aliases.items(), key=lambda x: len(x[0]), reverse=True)


BRANCH_ALIASES = branch_aliases()


def branches_in_text(text: str) -> List[str]:
    n = norm_branch(text)
    found: List[str] = []
    for alias, bid in BRANCH_ALIASES:
        if alias and re.search(r"(^| )" + re.escape(alias) + r"( |$)", n):
            if bid not in found:
                found.append(bid)
    return found


def parse_fee_variants(raw: str) -> Tuple[Optional[int], Dict[str, int], str]:
    amounts = parse_amounts(raw)
    if not amounts:
        return None, {}, "no parseable fee amount"
    base = amounts[0][0]
    branch_amounts: Dict[str, int] = {}
    if len(amounts) >= 2:
        for idx, (amount, span) in enumerate(amounts):
            start = span[1]
            end = amounts[idx + 1][1][0] if idx + 1 < len(amounts) else len(raw)
            section = raw[start:end]
            for bid in branches_in_text(section):
                branch_amounts[bid] = amount
    return base, branch_amounts, ""


def build_outputs(rows: Sequence[FeeRow], colleges: Sequence[dict], years: Sequence[int]) -> Tuple[dict, List[dict]]:
    review: List[dict] = []
    fee_rows = []
    for row in rows:
        match = match_college(row, colleges)
        base_fee, branch_amounts, fee_problem = parse_fee_variants(row.raw_fee_text)
        status = match.status
        reason = match.reason
        if status == "accepted" and fee_problem:
            status = "doubtful"
            reason = fee_problem
        if status == "accepted" and len(parse_amounts(row.raw_fee_text)) > 1 and not branch_amounts:
            status = "doubtful"
            reason = "branch-specific/multi-fee note was not mapped"
        review.append({
            "session": row.session,
            "year": row.year,
            "afrc_name": row.afrc_name,
            "afrc_place": row.place,
            "afrc_address": row.address,
            "raw_fee_text": row.raw_fee_text,
            "best_college_id": match.college_id,
            "best_college_name": match.college_name,
            "score": f"{match.score:.3f}",
            "match_reason": reason,
            "status": status,
            "alternatives": match.alternatives,
            "source_page": row.source_page,
            "branch_amounts": "; ".join(f"{b}:{v}" for b, v in sorted(branch_amounts.items())),
        })
        if status != "accepted" or not match.college_id or base_fee is None:
            continue
        common = {
            "year": row.year,
            "session": row.session,
            "semester_fee_rs": base_fee,
            "fee_period": "semester",
            "raw_fee_text": clean_text(row.raw_fee_text),
            "afrc_name": row.afrc_name,
            "source": "AFRC",
            "source_url": AFRC_URL,
        }
        fee_rows.append((match.college_id, None, dict(common)))
        for bid, amount in sorted(branch_amounts.items()):
            rec = dict(common)
            rec["branch_id"] = bid
            rec["semester_fee_rs"] = amount
            fee_rows.append((match.college_id, bid, rec))

    by_college: Dict[str, dict] = {}
    seen_records = set()
    for cid, bid, rec in fee_rows:
        key = (cid, bid or "", rec["year"], rec["semester_fee_rs"], rec["raw_fee_text"])
        if key in seen_records:
            continue
        seen_records.add(key)
        cdat = by_college.setdefault(cid, {"years": {}, "branches": {}})
        if bid:
            cdat["branches"].setdefault(bid, {"years": {}})["years"].setdefault(str(rec["year"]), []).append(rec)
        else:
            cdat["years"].setdefault(str(rec["year"]), []).append(rec)

    def latest(records: List[dict]) -> Optional[dict]:
        if not records:
            return None
        return sorted(records, key=lambda r: (r["year"], r["semester_fee_rs"]), reverse=True)[0]

    for cid, cdat in by_college.items():
        all_general = [r for yr in cdat["years"].values() for r in yr]
        cdat["latest"] = latest(all_general)
        for bid, bdat in cdat["branches"].items():
            all_branch = [r for yr in bdat["years"].values() for r in yr]
            bdat["latest"] = latest(all_branch)

    accepted = sum(1 for r in review if r["status"] == "accepted")
    doubtful = sum(1 for r in review if r["status"] == "doubtful")
    unmatched = sum(1 for r in review if r["status"] == "unmatched")
    data = {
        "source": {
            "name": "Admission & Fee Regulatory Committee, Madhya Pradesh",
            "short_name": "AFRC",
            "url": AFRC_URL,
            "unit": "semester_fee_rs",
            "label": "Semester wise Fees (in Rs)",
        },
        "years": list(years),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "coverage": {
            "raw_rows": len(rows),
            "accepted_rows": accepted,
            "doubtful_rows": doubtful,
            "unmatched_rows": unmatched,
            "accepted_colleges": len(by_college),
        },
        "colleges": by_college,
    }
    return data, review


def add_fee_record(data: dict, cid: str, bid: str, rec: dict) -> bool:
    cdat = data.setdefault("colleges", {}).setdefault(cid, {"years": {}, "branches": {}})
    records = cdat["branches"].setdefault(bid, {"years": {}})["years"].setdefault(str(rec["year"]), []) if bid else cdat["years"].setdefault(str(rec["year"]), [])
    key = (rec.get("year"), rec.get("semester_fee_rs"), clean_text(rec.get("raw_fee_text", "")), rec.get("source_url", ""))
    for existing in records:
        if (existing.get("year"), existing.get("semester_fee_rs"), clean_text(existing.get("raw_fee_text", "")), existing.get("source_url", "")) == key:
            return False
    records.append(rec)
    return True


def refresh_fee_metadata(data: dict, review: Sequence[dict], supplement_count: int = 0) -> None:
    def latest(records: List[dict]) -> Optional[dict]:
        if not records:
            return None
        return sorted(records, key=lambda r: (r.get("year", 0), r.get("semester_fee_rs", 0)), reverse=True)[0]

    for cdat in data.get("colleges", {}).values():
        all_general = [r for yr in cdat.get("years", {}).values() for r in yr]
        cdat["latest"] = latest(all_general)
        for bdat in cdat.get("branches", {}).values():
            all_branch = [r for yr in bdat.get("years", {}).values() for r in yr]
            bdat["latest"] = latest(all_branch)

    accepted = sum(1 for r in review if r["status"] == "accepted")
    doubtful = sum(1 for r in review if r["status"] == "doubtful")
    unmatched = sum(1 for r in review if r["status"] == "unmatched")
    data["coverage"].update({
        "accepted_rows": accepted,
        "doubtful_rows": doubtful,
        "unmatched_rows": unmatched,
        "accepted_colleges": len(data.get("colleges", {})),
        "supplemental_rows": supplement_count,
    })


def apply_supplements(data: dict, review: List[dict], supplement_path: Path, years: Sequence[int]) -> int:
    if not supplement_path.exists():
        refresh_fee_metadata(data, review, 0)
        return 0
    count = 0
    with supplement_path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            try:
                year = int(row.get("year", ""))
                amount = int(str(row.get("semester_fee_rs", "")).replace(",", ""))
            except ValueError:
                continue
            if year not in years:
                continue
            cid = clean_text(row.get("college_id", ""))
            if not cid:
                continue
            rec = {
                "year": year,
                "session": clean_text(row.get("session", "")) or f"{year}-{year + 1}",
                "semester_fee_rs": amount,
                "fee_period": clean_text(row.get("fee_period", "")) or "semester",
                "raw_fee_text": clean_text(row.get("raw_fee_text", "")) or str(amount),
                "afrc_name": clean_text(row.get("source_name", "")) or clean_text(row.get("college_name", "")),
                "source": clean_text(row.get("source", "")) or "Supplement",
                "source_label": clean_text(row.get("source_label", "")) or clean_text(row.get("source", "")) or "Source",
                "source_url": clean_text(row.get("source_url", "")),
            }
            bid = clean_text(row.get("branch_id", ""))
            if bid:
                rec["branch_id"] = bid
            if add_fee_record(data, cid, bid, rec):
                count += 1
                review.append({
                    "session": rec["session"],
                    "year": year,
                    "afrc_name": rec["afrc_name"],
                    "afrc_place": clean_text(row.get("place", "")),
                    "afrc_address": clean_text(row.get("address", "")),
                    "raw_fee_text": rec["raw_fee_text"],
                    "best_college_id": cid,
                    "best_college_name": clean_text(row.get("college_name", "")),
                    "score": "1.000",
                    "match_reason": "supplemental source",
                    "status": "accepted",
                    "alternatives": "",
                    "source_page": clean_text(row.get("source_page", "")) or supplement_path.name,
                    "branch_amounts": bid + ":" + str(amount) if bid else "",
                })
    refresh_fee_metadata(data, review, count)
    return count


def write_review(rows: Sequence[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "session", "year", "afrc_name", "afrc_place", "afrc_address", "raw_fee_text",
        "best_college_id", "best_college_name", "score", "match_reason", "status",
        "alternatives", "source_page", "branch_amounts",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow(row)


def write_remaining_review(rows: Sequence[dict], path: Path) -> None:
    write_review([r for r in rows if r.get("status") != "accepted"], path)


def write_remaining_summary(rows: Sequence[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    groups: Dict[Tuple[str, str, str, str, str, str, str], dict] = {}
    for row in rows:
        if row.get("status") == "accepted":
            continue
        key = (
            row.get("status", ""),
            row.get("afrc_name", ""),
            row.get("afrc_place", ""),
            row.get("afrc_address", ""),
            row.get("best_college_id", ""),
            row.get("best_college_name", ""),
            row.get("match_reason", ""),
        )
        g = groups.setdefault(key, {
            "status": row.get("status", ""),
            "row_count": 0,
            "years": set(),
            "afrc_name": row.get("afrc_name", ""),
            "afrc_place": row.get("afrc_place", ""),
            "afrc_address": row.get("afrc_address", ""),
            "best_college_id": row.get("best_college_id", ""),
            "best_college_name": row.get("best_college_name", ""),
            "match_reason": row.get("match_reason", ""),
            "alternatives": row.get("alternatives", ""),
        })
        g["row_count"] += 1
        g["years"].add(str(row.get("year", "")))

    fields = [
        "status", "row_count", "years", "afrc_name", "afrc_place", "afrc_address",
        "best_college_id", "best_college_name", "match_reason", "alternatives",
    ]
    out_rows = sorted(groups.values(), key=lambda r: (-r["row_count"], r["status"], r["afrc_name"]))
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in out_rows:
            item = dict(row)
            item["years"] = ";".join(sorted(y for y in row["years"] if y))
            w.writerow(item)


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract AFRC B.E./B.Tech fee data")
    ap.add_argument("--input", default=str(ROOT / "fees.xml"), help="Burp XML capture to seed from")
    ap.add_argument("--years", default="2017-2026", help="Years or range, e.g. 2017-2026")
    ap.add_argument("--streams", default="T,U", help="AFRC streams to fetch, e.g. T,U for Technical and University")
    ap.add_argument("--no-fetch", action="store_true", help="Only parse --input; do not fetch AFRC live pages")
    ap.add_argument("--out", default=str(OUT_DATA / "fees.json"), help="Output JSON path")
    ap.add_argument("--review", default=str(OUT_AUDIT / "fees_match_review.csv"), help="Review CSV path")
    ap.add_argument("--remaining-review", default=str(OUT_AUDIT / "fees_remaining_review.csv"), help="Doubtful/unmatched CSV path")
    ap.add_argument("--remaining-summary", default=str(OUT_AUDIT / "fees_remaining_summary.csv"), help="Grouped doubtful/unmatched CSV path")
    ap.add_argument("--supplement", default=str(OUT_AUDIT / "fees_supplement.csv"), help="Supplemental PDF/manual fee CSV path")
    args = ap.parse_args()

    years = parse_years(args.years)
    streams = parse_streams(args.streams)
    rows = parse_burp_xml(Path(args.input), years)
    print(f"parsed {len(rows)} fee rows from {args.input}")
    if not args.no_fetch:
        try:
            live = fetch_live_rows(years, streams)
            print(f"fetched {len(live)} fee rows from AFRC")
            rows.extend(live)
        except Exception as exc:
            print(f"warning: live AFRC fetch failed: {exc}", file=sys.stderr)
    rows = dedupe_rows(rows)
    print(f"{len(rows)} unique fee rows after de-duplication")

    colleges = json.loads((OUT_DATA / "colleges.json").read_text(encoding="utf-8"))["colleges"]
    data, review = build_outputs(rows, colleges, years)
    supplement_count = apply_supplements(data, review, Path(args.supplement), years)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    write_review(review, Path(args.review))
    write_remaining_review(review, Path(args.remaining_review))
    write_remaining_summary(review, Path(args.remaining_summary))

    cov = data["coverage"]
    print("coverage:", ", ".join(f"{k}={v}" for k, v in cov.items()))
    if supplement_count:
        print(f"merged {supplement_count} supplemental fee rows from {display_path(Path(args.supplement))}")
    print(f"wrote {display_path(out_path)}")
    print(f"wrote {display_path(Path(args.review))}")
    print(f"wrote {display_path(Path(args.remaining_review))}")
    print(f"wrote {display_path(Path(args.remaining_summary))}")


if __name__ == "__main__":
    main()
