#!/usr/bin/env python3
"""Download BACHELOR OF TECHNOLOGY cut-off PDFs for 2017-2025 from MP DTE portal."""
import os, re, sys, urllib.parse, time
import requests
from bs4 import BeautifulSoup

BASE = "https://dte.mponline.gov.in/Portal/Services/OnlineCounselling/NW/Utilities/Citizen/CutOffList.aspx"
ROOT = "https://dte.mponline.gov.in"
OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "DTE_CutOff_BTech")
COURSE_TARGET = "rptCourse$ctl05$lnkCourse"   # BACHELOR OF TECHNOLOGY
YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017]

HEAD = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"}

def hidden(soup):
    d = {}
    for inp in soup.find_all("input"):
        n = inp.get("name")
        if n and n.startswith("__"):
            d[n] = inp.get("value", "")
    return d

def sanitize(name):
    name = re.sub(r"\s+", " ", name).strip()
    return re.sub(r'[\\/:*?"<>|]', "_", name)

def get_btech_links(year):
    """Run the ASP.NET postback flow for one year, return [(title, src_path), ...]."""
    s = requests.Session(); s.headers.update(HEAD)
    r = s.get(BASE, verify=False, timeout=30)
    f = hidden(BeautifulSoup(r.text, "html.parser"))

    # Step 1: select the year radio (index = 2026 - year)
    idx = 2026 - year
    d = dict(f); d["__EVENTTARGET"] = f"rblYear${idx}"; d["__EVENTARGUMENT"] = ""
    d["rblYear"] = str(year)
    r = s.post(BASE, data=d, verify=False, timeout=30)
    f = hidden(BeautifulSoup(r.text, "html.parser"))

    # Step 2: click BACHELOR OF TECHNOLOGY
    d = dict(f); d["__EVENTTARGET"] = COURSE_TARGET; d["__EVENTARGUMENT"] = ""
    d["rblYear"] = str(year)
    r = s.post(BASE, data=d, verify=False, timeout=60)
    soup = BeautifulSoup(r.text, "html.parser")

    out = []
    container = soup.find("div", class_="dte_container")
    if not container:
        return out, s
    for a in container.find_all("a", href=True):
        href = a["href"]
        m = re.search(r"src=([^&]+\.pdf)", href, re.IGNORECASE)
        if not m:
            continue
        src = urllib.parse.unquote(m.group(1)).strip()
        title = a.get_text(strip=True)
        out.append((title, src))
    return out, s

def download(session, src, dest):
    """Try direct static path; fall back to the InitailizeCommonView viewer."""
    direct = ROOT + urllib.parse.quote(src)
    viewer = (ROOT + "/Portal/Services/OnlineCounselling/NW/Utilities/InitailizeCommonView.aspx"
              "?UserType=C&src=" + urllib.parse.quote(src))
    for url in (direct, viewer):
        try:
            r = session.get(url, verify=False, timeout=120)
        except Exception as e:
            print(f"      ! error {e}")
            continue
        ct = r.headers.get("Content-Type", "")
        if r.status_code == 200 and (r.content[:4] == b"%PDF" or "pdf" in ct.lower()):
            with open(dest, "wb") as fh:
                fh.write(r.content)
            return len(r.content), ("direct" if url == direct else "viewer")
    return None, None

def main():
    import warnings; warnings.filterwarnings("ignore")
    os.makedirs(OUTDIR, exist_ok=True)
    grand = 0
    for year in YEARS:
        ydir = os.path.join(OUTDIR, str(year))
        os.makedirs(ydir, exist_ok=True)
        print(f"\n=== {year} ===")
        try:
            links, sess = get_btech_links(year)
        except Exception as e:
            print(f"  failed to load year: {e}")
            continue
        if not links:
            print("  (no B.Tech records for this year)")
            continue
        index_lines = []
        for title, src in links:
            base = os.path.basename(src)
            dest = os.path.join(ydir, base)
            size, via = download(sess, src, dest)
            if size:
                print(f"  ✓ {base}  ({size:,} B, {via})  [{title}]")
                index_lines.append(f"{base} — {title}")
                grand += 1
            else:
                print(f"  ✗ FAILED {base}  [{title}]  src={src}")
                index_lines.append(f"{base} — FAILED — {title}")
        with open(os.path.join(ydir, "_index.txt"), "w") as fh:
            fh.write(f"BACHELOR OF TECHNOLOGY — Cut-Off List {year}\n\n" + "\n".join(index_lines) + "\n")
    print(f"\nDONE. {grand} PDFs downloaded under {OUTDIR}")

if __name__ == "__main__":
    main()
