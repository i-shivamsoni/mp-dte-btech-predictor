#!/usr/bin/env python3
"""Fetch the MP-DTE 'Tentative List of Institutes and Intake' (seat matrix) and
save it as JSON. ASP.NET WebForms flow: GET -> postback to select course (fills
branch/inst-type) -> POST btnView with All filters -> parse the result table.

Usage:  python3 fetch_intake.py [COURSE_CODE]   # default BE = BACHELOR OF TECHNOLOGY
"""
import os, re, sys, json, warnings
import requests
from bs4 import BeautifulSoup

URL = ("https://dte.mponline.gov.in/Portal/Services/OnlineCounselling/"
       "Administration/InitialIntake.aspx")
# result-table header text -> canonical json field
FIELD = {
    "S. No.": "sno", "College ID": "college_id", "Institute Name": "institute_name",
    "Branch": "branch", "Total Intake": "total_intake",
    "Tuition Fee Waiver seats": "tfw_seats", "IPS Seats": "ips_seats",
    "NRI Seats": "nri_seats", "EWS Seats": "ews_seats", "PIO/FN Seats": "pio_fn_seats",
    "NTPC Seats": "ntpc_seats", "Institute Type": "institute_type",
    "AICTE Code": "aicte_code", "Remark": "remark",
    "AFRC/Govt. Fee Status": "fee_status", "Minority Status": "minority_status",
    "University": "university",
}
INT_FIELDS = {"sno", "total_intake", "tfw_seats", "ips_seats", "nri_seats",
              "ews_seats", "pio_fn_seats", "ntpc_seats"}


def hidden(soup):
    return {i["name"]: i.get("value", "")
            for i in soup.find_all("input") if i.get("name")}


def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def to_int(s):
    s = norm(s)
    return int(s) if s.isdigit() else (s or None)


def fetch(course="BE"):
    s = requests.Session(); s.headers["User-Agent"] = "Mozilla/5.0"
    soup = BeautifulSoup(s.get(URL, timeout=30).text, "html.parser")
    # 1) autopostback: select course -> server fills branch + inst-type lists
    f = hidden(soup)
    f.update({"__EVENTTARGET": "ddlCourse", "__EVENTARGUMENT": "", "ddlCourse": course,
              "drpbranch": "00", "drpCity": "0", "DrpInstType": "00", "drpSeatType": "0"})
    f.pop("btnView", None)
    soup = BeautifulSoup(s.post(URL, data=f, timeout=60).text, "html.parser")
    # 2) click View with All branch / All city / All type / All seat-type
    f = hidden(soup)
    f.update({"__EVENTTARGET": "", "__EVENTARGUMENT": "", "ddlCourse": course,
              "drpbranch": "1", "drpCity": "0", "DrpInstType": "0",
              "drpSeatType": "0", "btnView": "View"})
    html = s.post(URL, data=f, timeout=180).text
    return BeautifulSoup(html, "html.parser")


def parse(soup):
    # Anchor on the inner GridView, not the outer wrapper table: find the header
    # cell "Institute Name" and use its own table. Header is <th>; each data row
    # has exactly len(header) direct <td> children.
    cell = soup.find(lambda t: t.name in ("td", "th")
                     and norm(t.get_text()) == "Institute Name")
    if not cell:
        return [], []
    tbl = cell.find_parent("table")
    hdr_tr = cell.find_parent("tr")
    header = [norm(c.get_text(" ")) for c in hdr_tr.find_all(["th", "td"], recursive=False)]
    cols = [FIELD.get(h, h) for h in header]
    rows = []
    for tr in tbl.find_all("tr"):
        tds = tr.find_all("td", recursive=False)
        if len(tds) != len(cols):              # header / spacer rows have a different count
            continue
        vals = [norm(td.get_text(" ")) for td in tds]
        if not vals[0].isdigit():               # data rows start with a serial number
            continue
        rec = {cols[j]: (to_int(v) if cols[j] in INT_FIELDS else (v or None))
               for j, v in enumerate(vals)}
        rows.append(rec)
    return cols, rows


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    course = sys.argv[1] if len(sys.argv) > 1 else "BE"
    soup = fetch(course)
    full = soup.get_text(" ", strip=True)
    m = re.search(r"TENTATIVE LIST OF INSTITUTES AND INTAKE\s*(20\d{2}-\d{2})", full, re.I)
    year = m.group(1) if m else "unknown"
    title = norm(m.group(0)) if m else "Tentative List of Institutes and Intake"
    cols, rows = parse(soup)
    out = {
        "source_url": URL, "course_code": course,
        "course_name": "BACHELOR OF TECHNOLOGY" if course == "BE" else course,
        "title": title, "year": year, "columns": cols,
        "row_count": len(rows), "rows": rows,
    }
    outdir = "DTE_Intake_BTech"; os.makedirs(outdir, exist_ok=True)
    path = f"{outdir}/intake_{course}_{year}.json"
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # summary
    insts = {r.get("college_id") for r in rows}
    tot = sum(r["total_intake"] for r in rows if isinstance(r.get("total_intake"), int))
    print(f"{title}")
    print(f"rows={len(rows)}  distinct institutes={len(insts)}  total_intake={tot:,}")
    for f in ("tfw_seats", "ips_seats", "nri_seats", "ews_seats", "pio_fn_seats", "ntpc_seats"):
        st = sum(r[f] for r in rows if isinstance(r.get(f), int))
        print(f"  {f:14s} total = {st:,}")
    from collections import Counter
    bytype = Counter(r.get("institute_type") for r in rows)
    print("  by institute_type:", dict(bytype))
    print(f"-> {path}  ({os.path.getsize(path)/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
