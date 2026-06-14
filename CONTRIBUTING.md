# Contributing

Thanks for helping improve the **MP-DTE B.Tech College Predictor**. Bug reports, data
corrections, and pull requests are all welcome.

This guide is written for **both human contributors and AI coding agents**. If you are an
agent, read [Guardrails](#guardrails-read-before-any-commit) and [For AI agents](#for-ai-agents)
in full before editing or staging anything — a few rules here are non-negotiable.

---

## TL;DR

```text
What it is   Static Jekyll site. No backend. Prediction runs in the browser.
                Deterministic cut-off lookup — NO machine learning, no hidden weights.
Privacy      Nothing a user types leaves their device. Keep it that way.
Data flow    raw committed JSON  ->  scripts/preprocess.py  ->  assets/data/*.json (generated)
Don't edit   assets/data/*.json by hand — change the source + script, then regenerate.
Never commit RTI/, MeritLists/, DTE_MeritList_BTech/, _site/, *.pdf, anything with PII.
Before a PR  Run the full verification suite below; it must pass clean.
```

---

## Ways to contribute

### 1. Report a bug or a data error (open an issue)

A free GitHub account is required.

1. Go to the [Issues tab](https://github.com/i-shivamsoni/mp-dte-btech-predictor/issues) and
   click **New issue**.
2. Give it a clear title. In the description include the **page / URL**, what you **expected**
   vs what you **saw**, and a **screenshot** if you can.
3. For a **data error**, name the **college, branch, category and year** so it can be traced
   back to the official DTE source.

### 2. Submit a change (open a pull request)

1. **Fork** the repo and clone your fork.
2. Branch off `main`: `git checkout -b fix-short-description`.
3. Make your change and **test locally** (see [Develop locally](#develop-locally)).
4. Run the [verification suite](#verification-must-pass-before-a-pr) — all of it must pass.
5. Push and open a **pull request against `main`**, describing **what** changed and **why**.

---

## Develop locally

Requirements: **Ruby + Bundler** (for Jekyll) and **Python 3.12+** (for the data pipeline).

```bash
bundle install                 # one-time: install Jekyll and gems
python3 scripts/preprocess.py  # (re)build assets/data/ from the committed raw data
bundle exec jekyll serve       # http://127.0.0.1:4000
```

`scripts/preprocess.py` regenerates everything under `assets/data/`. The committed assets are
**PII-free**. The raw qualifying-exam merit lists (which contain student names / roll numbers)
are **not** part of this repository, so the percentage-route percentile lookup falls back to the
committed `assets/data/predictor_qe.json` when the raw lists are absent — the build works
without them.

---

## Project layout

```text
scripts/preprocess.py             raw JSON -> compact static assets in assets/data/
scripts/backtest.py               walk-forward validation -> assets/data/backtest.json
DTE_CutOff_BTech/*.json           committed raw cut-off data (2017-2025), PII-free
DTE_Intake_BTech/*.json           committed 2026-27 seat matrix
assets/data/*.json                GENERATED — do not hand-edit
assets/data/history/<id>.json     per-college cut-off-history shards (one per colleges.json id)
assets/js/mpdte.js                data loader + deterministic prediction engine + filters + tables
assets/js/dashboard.js            demand-insights charts (Chart.js)
_layouts/ _includes/              Jekyll templates (default layout, nav, footer, caveat banner)
*.html                            pages (home, predictor, percentage-predictor, explorer, demand, …)
.github/workflows/jekyll.yml      CI: preprocess -> backtest -> jekyll build -> deploy to Pages
```

### How the data pipeline works

The cut-off and intake data are **committed as raw JSON** in `DTE_CutOff_BTech/` and
`DTE_Intake_BTech/`. `scripts/preprocess.py` reads them and emits the small, indexed files the
browser fetches (`branches.json`, `colleges.json`, `intake.json`, `predictor_jee.json`,
`predictor_qe.json`, `demand_stats.json`, the per-college `history/<id>.json` shards, etc.).

So: **to fix a data error, edit the source JSON and/or `preprocess.py` — never the generated
files in `assets/data/`.** Then re-run the pipeline and commit the regenerated assets together
with the source change. CI runs the same scripts, so a hand-edited asset would be silently
overwritten on the next deploy.

---

## Guardrails (read before any commit)

These are hard rules. They protect contributors' privacy and the project's core properties.

1. **Never commit personal data.** The directories `RTI/`, `MeritLists/`, and
   `DTE_MeritList_BTech/` contain RTI applications and student merit lists (names, roll numbers,
   personal identifiers). They are gitignored *and* excluded from the Jekyll build, but do not
   add them back, do not paste their contents into code/issues, and do not commit any file
   containing such identifiers.
2. **Never commit build output or local junk:** `_site/`, `vendor/`, `__pycache__/`, `*.pyc`,
   `*.pdf`, `_config_local.yml`.
3. **Don't hand-edit `assets/data/*.json`** — they are generated. Change the source data or
   `preprocess.py`, then regenerate (see above).
4. **Privacy is a feature.** No backend, no analytics, no telemetry, nothing that sends a user's
   rank or percentage off their device. Don't add it.
5. **No machine learning.** The predictor is a deterministic comparison against published
   historical closing ranks, by design. Keep predictions explainable and traceable to official
   data.
6. **Add new dependencies sparingly** and only with a clear reason — this is a fast static site.
7. **Predictions are estimates, not guarantees.** Don't introduce copy or UI that implies
   certainty; keep the existing caveats intact.

**Before every commit, confirm no PII path is staged:**

```bash
git status --porcelain | grep -E 'RTI/|MeritLists/|DTE_MeritList_BTech/' \
  && echo "STOP: PII path staged — unstage it" || echo "OK: no PII paths staged"
```

---

## Verification (must pass before a PR)

Run all of these from the repo root; each should exit clean:

```bash
python3 scripts/preprocess.py        # regenerate assets/data/ (no errors)
python3 scripts/backtest.py          # if you touched the model or backtest
bundle exec jekyll build --trace     # site builds clean
node --check assets/js/mpdte.js      # JS parses
node --check assets/js/dashboard.js  # JS parses
```

Integrity check — every college must have a matching history shard:

```bash
# Every colleges.json id must have a matching assets/data/history/<id>.json
python3 - <<'PY'
import json, os
cols = json.load(open("assets/data/colleges.json"))["colleges"]
missing = [c["id"] for c in cols if not os.path.exists(f"assets/data/history/{c['id']}.json")]
print("MISSING:", missing) if missing else print("OK: all", len(cols), "ids have a history shard")
PY
```

If you changed the prediction engine or data shaping, also click through the affected pages on
`http://127.0.0.1:4000` (predictor, percentage-predictor, college explorer, demand insights,
a college history page) and sanity-check the numbers.

---

## Commit & PR conventions

- **Branch** off `main`; keep one logical change per PR.
- **Commit messages** follow the existing log: a short capitalized topic, a colon, then a
  concise summary — e.g. `Data: correct SGSITS CSE 2024 closing rank` or
  `Predictor: fix Round-2 volatility floor`. Imperative mood, no trailing period needed.
- **PR description** says what changed and why; link the issue it fixes if there is one.
- Commit the **regenerated `assets/data/` files together with** the source/script change that
  produced them.
- Run the [verification suite](#verification-must-pass-before-a-pr) before pushing.

---

## For AI agents

If you are an automated agent working in this repo:

- **Do not blanket-stage.** Avoid `git add -A` / `git add .`. Stage specific paths, then run the
  PII check above before committing. The forbidden paths (`RTI/`, `MeritLists/`,
  `DTE_MeritList_BTech/`) and build output must never be committed.
- **`assets/data/*.json` is generated output** — never edit it directly. Edit the raw source in
  `DTE_CutOff_BTech/` / `DTE_Intake_BTech/` and/or `scripts/preprocess.py`, then run
  `python3 scripts/preprocess.py` (and `scripts/backtest.py` if the model changed) and commit
  the regenerated files.
- **Run the full verification suite** and report the actual results. If a step fails or you
  skipped one, say so — don't claim a clean build you didn't run.
- **Preserve the invariants:** no backend, no ML, no telemetry, no off-device data, predictions
  stay caveated. If a request conflicts with a guardrail, stop and flag it rather than working
  around it.
- **Match the surrounding code and copy** — comment density, naming, and the existing voice
  (these pages talk to anxious students; keep it plain and honest).
- **Branch, don't push to `main` directly.** Open a PR. Don't commit or push unless asked.

---

## License of contributions

By contributing you agree your contributions are licensed under the project's terms:
**code under [MIT](LICENSE)** and **processed/compiled data under [CC BY 4.0](LICENSE-DATA.md)**.
Don't add third-party code or data that isn't compatible with these.

## Questions & disclaimer

Open an issue for anything unclear. This project is **not affiliated with, endorsed by, or
operated by the Directorate of Technical Education, M.P.** It is built from official public data
to help students; predictions are estimates derived from past cut-offs. Always confirm seats,
eligibility, and fees on the [official DTE portal](https://dte.mponline.gov.in/).
