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
vercel.json                Vercel build command + _site output directory
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

## Deploy to Vercel

The repo is ready for Vercel as a static Jekyll site. `vercel.json` pins the deployment settings:

- install command: `bundle install`
- build command: `JEKYLL_ENV=production bundle exec jekyll build`
- output directory: `_site`

Before the first production deploy, enable **Web Analytics** for the Vercel project in the Vercel
dashboard. Production builds inject Vercel's analytics script automatically; local development
builds leave it out.

## Contributing

Issues and pull requests are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full
guide (it covers humans and AI agents, the data pipeline, guardrails, and the verification suite),
or the [contributing page](https://i-shivamsoni.github.io/mp-dte-btech-predictor/open-source/) for the short version.

**Report a bug or data error — open an issue:**

1. Go to the [Issues tab](https://github.com/i-shivamsoni/mp-dte-btech-predictor/issues) and click **New issue** (a free GitHub account is required).
2. Give it a clear title, and in the description include the **page / URL**, what you **expected** vs what you **saw**, and a **screenshot** if you can.
3. For a **data error**, name the **college, branch, category and year** so it can be traced back to the official source.

Or [open a new issue directly](https://github.com/i-shivamsoni/mp-dte-btech-predictor/issues/new).

**Submit a change — open a pull request:**

1. **Fork** the repo and create a branch.
2. Make your change and test locally (`bundle exec jekyll serve`; see *Develop locally* above).
3. Push and open a **pull request** against `main`, describing what changed and why.

> Please don't add the raw qualifying-exam merit lists (they contain student names / roll numbers) — they are intentionally excluded from this repository.

## Data & disclaimer

Not affiliated with DTE M.P. Predictions are estimates from past cut-offs and may differ from
future rounds; cut-offs drift each year. Always confirm seats, eligibility and fees on the
[official DTE portal](https://dte.mponline.gov.in/). The qualifying-exam (12th-%) route currently
covers 2019, 2022-23 and 2024-25; the remaining years are not yet available and will be added later.

## License

- **Code** — [MIT](LICENSE).
- **Processed data** — [CC BY 4.0](LICENSE-DATA.md) (attribution required); the underlying cut-offs and seat matrix are official MP-DTE public records, and student merit lists are excluded.

Both licenses apply to the project as a whole, **including all earlier commits in its history** — adding them in a later commit doesn't leave the earlier code/data unlicensed.
