# MP DTE — BACHELOR OF TECHNOLOGY Cut-Off Lists (2017–2025) → JSON

Source: https://dte.mponline.gov.in (Online Off-Campus Counselling → Cut-Off List)
Course: **BACHELOR OF TECHNOLOGY**. Extracted 2026-06-10.

## Layout
```
<year>/<file>.pdf     original cut-off PDF
<year>/<file>.json    parsed data for that PDF
<year>/_index.txt     filename → round description
manifest.json         index of all 53 documents (year, round, columns, row_count)
all_btech_cutoffs.json all 65,600 rows flattened, each tagged with year + round
```

## Per-PDF JSON shape
```json
{
  "source_pdf": "2025/BE_RF_2025.pdf",
  "year": 2025,
  "round_title": "OPENING AND CLOSING FIRST ROUND 2025",
  "document_title_lines": ["DIRECTORATE ...", "BACHELOR OF TECHNOLOGY", ...],
  "course": "BACHELOR OF TECHNOLOGY",
  "columns": ["sno","institute_name", ...],
  "row_count": 1936,
  "rows": [ { ...one allotment record... } ]
}
```

## Row fields (a column appears only in years/rounds that publish it)
| field | meaning |
|-------|---------|
| `sno` | serial number within the PDF |
| `institute_name` | college name (with est. year) |
| `institute_type` | private / government / aided / S.F.I. / … |
| `fw` | tuition-fee-waiver seat flag (Y/N) |
| `branch` | branch code (CE, CSE, MECH, …) |
| `exam_type` | ENTRANCE / QUALIFYING (seat-allotment rounds) |
| `national_player` | national-player quota flag |
| `opening_rank` / `closing_rank` | JEE/qualifying opening & closing rank (int) |
| `eligible_category` / `allotted_category` | category pools (EWS, UR/X/OP, SC/X/OP, FW/OP, …) |
| `jk_residents` / `jk_migrants` / `domicile` | residency flags |
| `total_allotted` | seats allotted for that institute+branch+category |
| `remarks` | CHANGE / NO CHANGE (internal-branch-change rounds) |

## Extraction method
pdfplumber `lines` table strategy (these PDFs have ruling lines). Rotated 90°
headers were mapped to canonical fields by **letter-multiset matching** (rotation
only permutes a header's letters). `dedupe_chars` removed doubled/overlapping
glyphs present on some pages.

## Known data caveats (transparent, nothing dropped)
- **85 rank cells** are `.1`-style decimals — that is exactly what the source PDF
  prints; kept verbatim as strings.
- **30 rank cells (~15 rows) in `2017/BE_FW_GENREL_SECOND_ROUND_OPENING_CLOSING_2017`**:
  the long branch "Electronics and Telecommunications" overflows its column and
  interleaves with the rank digits in the source PDF. These rows carry a
  `"_note"` field and keep the raw cell text (rank not parseable to int).
- Everything else: 65,505 / 65,600 rank cells parsed cleanly as integers.
