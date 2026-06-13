# MP-DTE B.Tech College Predictor

A fast, static web tool for Madhya Pradesh B.Tech aspirants. Enter your **JEE rank** or
**12th-class percentage** and see which MP-DTE colleges and branches you can realistically get —
plus a demand dashboard of the most competitive branches and colleges.

Built entirely from **official public data**: DTE opening/closing-rank cut-off lists
(2017–2025) and the 2026-27 intake (seat matrix). No backend — all prediction runs in the
browser, and nothing you type ever leaves your device.

## How it works

A **deterministic cut-off lookup** (no machine learning): your rank is compared to each
seat-pool's published historical closing rank. See [the methodology page](/methodology/) for
the confidence bands, the two rank universes (JEE rounds vs the Qualifying Exam Based Round),
and how category / gender / domicile change which pools you're eligible for.

## Project layout

```
scripts/preprocess.py     raw JSON  ->  compact static assets in assets/data/
assets/data/*.json        generated, PII-free data the browser fetches
_layouts/ _includes/       Jekyll templates
*.html                     pages (home, predictor, percentage-predictor, explorer, demand, …)
assets/js/mpdte.js         data loader + prediction engine + filters + table rendering
assets/js/dashboard.js     demand-insights charts (Chart.js)
.github/workflows/         CI: preprocess -> jekyll build -> deploy to GitHub Pages
```

## Develop locally

```bash
bundle install                 # one-time: install Jekyll
python3 scripts/preprocess.py  # (re)build assets/data/ from the raw data
bundle exec jekyll serve       # http://127.0.0.1:4000
```

`scripts/preprocess.py` regenerates `assets/data/`. The committed assets are PII-free; the raw
qualifying-exam merit lists (which contain student names/roll numbers) are **not** part of this
repository, so the percentage-route percentile lookup falls back to the committed asset when the
raw lists are absent.

## Data & disclaimer

Not affiliated with DTE M.P. Predictions are estimates from past cut-offs and may differ from
future rounds; cut-offs drift each year. Always confirm seats, eligibility and fees on the
[official DTE portal](https://dte.mponline.gov.in/). The qualifying-exam (12th-%) route currently
covers 2019, 2022-23 and 2024-25; the remaining years are not yet available and will be added later.
