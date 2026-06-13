#!/usr/bin/env python3
import json, sys
from collections import defaultdict

BASE = "/home/seeker/Work/Projects/mpDTE/assets/data"

demand = json.load(open(f"{BASE}/demand_stats.json"))
colleges = json.load(open(f"{BASE}/colleges.json"))["colleges"]
branches = json.load(open(f"{BASE}/branches.json"))["branches"]

pref = demand["pref"]  # {"<collegeId>|<branchId>": rank}

col_by_id = {c["id"]: c for c in colleges}
branch_label = {b["id"]: b["label"] for b in branches}

def info(key):
    cid, bid = key.split("|", 1)
    c = col_by_id.get(cid)
    name = c["name"] if c else f"<unknown college {cid}>"
    ctype = c["type"] if c else "?"
    city = c.get("city", "?") if c else "?"
    blabel = branch_label.get(bid, bid)
    return cid, bid, name, ctype, city, blabel

rows = []
for key, rank in pref.items():
    cid, bid, name, ctype, city, blabel = info(key)
    rows.append((rank, cid, bid, name, ctype, city, blabel))
rows.sort(key=lambda r: r[0])

def pr(r):
    rank, cid, bid, name, ctype, city, blabel = r
    print(f"  #{rank:<4} [{ctype:<7}] {name} ({city}) -- {blabel} [{bid}]")

print("="*100)
print("(a) TOP 25 MOST SOUGHT-AFTER")
print("="*100)
for r in rows[:25]:
    pr(r)

print()
print("="*100)
print("(b) BOTTOM 10")
print("="*100)
for r in rows[-10:]:
    pr(r)

print()
print("="*100)
print("(c) PER-BRANCH ORDERED RANKING")
print("="*100)
for target in ['cse','it','ece','mech','civil','ee']:
    sub = [r for r in rows if r[2] == target]
    print(f"\n--- {target} ({branch_label.get(target, target)}) : {len(sub)} colleges ---")
    for i, r in enumerate(sub, 1):
        rank, cid, bid, name, ctype, city, blabel = r
        print(f"  {i:>2}. #{rank:<4} [{ctype:<7}] {name} ({city})")
