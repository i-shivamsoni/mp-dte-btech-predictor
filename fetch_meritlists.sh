#!/usr/bin/env bash
# Download MP-DTE BE/BTech merit lists (2019-2025) into MeritLists/<year>/.
# URLs passed verbatim to curl so encrypted ?src= query strings stay exact.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/MeritLists"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146 Safari/537.36"
ok=0; fail=0
dl(){ # year  filename  url
  local d="$ROOT/$1"; mkdir -p "$d"; local out="$d/$2"
  local code; code=$(curl -skL -A "$UA" --max-time 180 -o "$out" -w "%{http_code}" "$3")
  if [ "$code" = "200" ] && [ "$(head -c4 "$out")" = "%PDF" ]; then
    printf "  ok  %s/%s  (%s)\n" "$1" "$2" "$(du -h "$out" | cut -f1)"; ok=$((ok+1))
  else
    printf "  FAIL %s/%s  http=%s magic=%s\n" "$1" "$2" "$code" "$(head -c4 "$out" | tr -d '\0')"; fail=$((fail+1)); rm -f "$out"
  fi
}
C=https://cache.careers360.mobi/media/uploads/froala_editor/files
S=https://static.careers360.mobi/media/uploads/froala_editor/files
D=https://dte.mponline.gov.in/Portal/Services/OnlineCounselling/NW/Utilities/CommonView.aspx

# ---- 2025 ----
dl 2025 "2025_Round1_MP-BTech-Merit-List.pdf" "$C/MP-BTech-Merit-List-2025.pdf"
dl 2025 "2025_Round2_CommonView.pdf" "$D?src=n90zMM8CLEGjqNHJ0%2f1mmZiUg9FWfHHHNEbBjO4KwFpmOE6oa54iLVtDXxra7uKMWDiwlasudLHl5afopbkfQY4GiU0Ffxngytllqwmf1ts%3d&UserType=aQflB8jTbn4YSev8TQomPw%3d%3d"

# ---- 2024 ----
dl 2024 "2024_merit-list_2932-325890.pdf"      "$C/MP-BE-merit-list-%28between-2932-to-325890%29.pdf"
dl 2024 "2024_merit-list_326060-672720.pdf"    "$C/MP-BE-2024-merit-list-%28between-326060-to-672720%29.pdf"
dl 2024 "2024_merit-list_672741-1053554.pdf"   "$C/MP-BE-2024-merit-list-%28between-672741-to-1053554%29.pdf"
dl 2024 "2024_merit-list_1053556-1415099.pdf"  "$C/MP-BE-2024-merit-list-%28between-1053556-to-1415099%29.pdf"
dl 2024 "2024_MP-DTE-BE-Merit-List-JEE-Main.pdf" "$C/MP-DTE-BE-Merit-List-JEE-Main.pdf"
dl 2024 "2024_QE-1_96.4-to-64.8pct.pdf"        "$C/MP-DTE-BE-Merit-List-QE-1.pdf"
dl 2024 "2024_QE-2_64.8-to-39.4pct.pdf"        "$C/MP-DTE-BE-Merit-List-QE-2.pdf"

# ---- 2023 ----
dl 2023 "2023_merit-list_7861-248022.pdf"      "$D?src=n90zMM8CLEGjqNHJ0/1mmZiUg9FWfHHHNEbBjO4KwFp8AYXXM42QBuK5kt1iBglJmrs/VKlWgjXz0ATVL3DQUpOF3X2kZ4t5rTcFXW0awrU="
dl 2023 "2023_merit-list_248029-479706.pdf"    "$D?src=n90zMM8CLEGjqNHJ0/1mmZiUg9FWfHHHNEbBjO4KwFp8AYXXM42QBuK5kt1iBglJM4l2OHYsJYsgLPNz9OICnZHqnzp+u3vMw6GZIND4yR4="
dl 2023 "2023_merit-list_479726-749069.pdf"    "$D?src=n90zMM8CLEGjqNHJ0/1mmZiUg9FWfHHHNEbBjO4KwFqIfcioMHVCgx7zt2qR7GmBEpvfe+k02MMUU3y5Bu1sn+laVv+sDpOevpXcworXvzw="
dl 2023 "2023_merit-list_749070-1113288.pdf"   "$D?src=n90zMM8CLEGjqNHJ0/1mmZiUg9FWfHHHNEbBjO4KwFrvk7ePkcI8SzRY3Lw3RK3uO0LRmjBdo0QFWiE6jDGfgY7jhLoKBRvZudY9du8aS0I="
dl 2023 "2023_JEE-Rank_5021-312005.pdf"        "$C/MP-BE-%28JEE-Rank-between-5021-to-312005%29.pdf"
dl 2023 "2023_JEE-Rank_312015-578173.pdf"      "$C/MP-BE-%28JEE-Rank-between-312015-to-578173%29.pdf"
dl 2023 "2023_JEE-Rank_578176-893217.pdf"      "$C/MP-BE-%28JEE-Rank-between-578176-to-893217%29.pdf"
dl 2023 "2023_JEE-Rank_893304-1112656.pdf"     "$C/MP-BE-%28JEE-Rank-between-893304-to-1112656%29.pdf"

# ---- 2022 ----
dl 2022 "2022_TFW-General-First-Round.pdf"     "$C/CommonView_W5M6OyS.pdf"
dl 2022 "2022_TFW-General-Second-Round.pdf"    "$C/CommonView%20%281%29.pdf"
dl 2022 "2022_Common-merit-qualifying-exam.pdf" "$C/CommonView%20%282%29.pdf"

# ---- 2021 ----
dl 2021 "2021_Round1-JEE-Main.pdf"             "$C/first%20round.pdf"
dl 2021 "2021_Round2-JEE-Main.pdf"             "$C/second-round.pdf"

# ---- 2020 ----
dl 2020 "2020_Round1-JEE-Main.pdf" "$D?src=n90zMM8CLEGjqNHJ0%2f1mmZiUg9FWfHHHNEbBjO4KwFpKtlNhOdaktWpJT332dDoaqEJosMrzeEPkrTt%2b49zrcgNyMDzMi0gg84GJbMAWC0PP5Sr2OjSnhiGSZ29ESfeI&UserType=aQflB8jTbn4YSev8TQomPw%3d%3d"
dl 2020 "2020_Round2-JEE-Main.pdf"             "$C/MP-BE-Round-2-merit-list.pdf"

# ---- 2019 ----
dl 2019 "2019_Round1-JEE-Main.pdf"             "$S/document_pu0yOkt.pdf"
dl 2019 "2019_Round2-JEE-Main.pdf"             "$S/document%281%29.pdf"
dl 2019 "2019_QE-Candidates.pdf"               "$S/document%282%29.pdf"

echo ""
echo "DONE: $ok ok, $fail failed -> $ROOT"
