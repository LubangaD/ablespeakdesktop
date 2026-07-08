# AbleSpeak — Click-Grounding A/B Harness

Measures how accurately a "grounding provider" turns *screenshot + instruction*
into a **click point** — the core of "click that thing" by voice. Use it to decide
whether MolmoWeb is worth integrating before writing any integration code.

It scores each provider on:

- **Hit rate** — did the predicted point land inside the ground-truth target box?
- **Median normalized distance** — distance from the box center, normalized by the
  image diagonal (tie-breaker / "how close when it misses").
- **Latency** — mean ms per call.

Everything is measured in the **image's own pixel space**, so it's independent of
how AbleSpeak later rescales coordinates to the real screen.

## Why this first

AbleSpeak's weakest path is resolving "click X" — especially on native apps with no
DOM. Today that goes to Gemini with a screenshot. This harness tells you, with real
numbers on *your* screens, whether a dedicated grounding model (MolmoWeb) actually
beats the Gemini baseline before you invest in serving a GPU model.

## Layout

```
grounding-eval/
  annotator.html        # browser tool to author ground-truth cases
  run-eval.cjs          # the runner: query providers, score, write report
  dataset.sample.json   # example schema (copy to dataset.json)
  lib/image-size.cjs    # PNG/JPEG dimension reader (no deps)
  providers/
    gemini.cjs          # mirrors AbleSpeak's production Gemini call
    molmoweb.cjs        # POSTs to a MolmoWeb /predict endpoint
  images/               # <-- put your screenshots here (you create this)
  out/                  # report.html, results.json, results.csv (generated)
```

## 1. Build a test set

Open **`annotator.html`** in a browser. For each case: load a screenshot, drag a box
around the correct click target, type the instruction (e.g. "click the Wikipedia
link"), pick a category (`web` / `desktop` / `other`), and **Add case**. Export
`dataset.json` when done.

Save the screenshots you annotated into `grounding-eval/images/` (the annotator
prepends the `images/` path prefix to each filename), and put `dataset.json` in
`grounding-eval/`.

Aim for ~12–20 cases, split between real web pages and native Windows apps — the
native-app cases are where a dedicated grounding model is most likely to win.

## 2. Configure keys

The runner auto-loads `server/.env`. It needs:

```
GEMINI_API_KEY=...            # for the gemini baseline (same key AbleSpeak uses)
# GEMINI_MODEL=gemini-2.5-flash   # optional, this is the default
# MOLMOWEB_ENDPOINT=http://127.0.0.1:8001   # set ONLY when you have a server
```

## 3. Run

```bash
cd server/tools/grounding-eval

# Gemini baseline now (MolmoWeb is skipped automatically if no endpoint is set):
node run-eval.cjs --dataset ./dataset.json

# Later, head-to-head once MolmoWeb is serving:
MOLMOWEB_ENDPOINT=http://127.0.0.1:8001 node run-eval.cjs --dataset ./dataset.json

# Options:
#   --providers gemini            limit to one provider
#   --limit 5                     only the first 5 cases (quick smoke test)
#   --out ./out                   output directory
```

Open **`out/report.html`** — a self-contained page showing each screenshot with the
ground-truth box (green dashed) and every provider's predicted point (✓ hit / ✗ miss),
plus a summary table overall and per category. `results.csv` is for spreadsheets.

## How the comparison is kept fair

- **Gemini adapter** uses the same base URL and default model as
  `server/src/ai-engine.js`, attaches the screenshot as `inline_data` exactly like
  production, and disables thinking for `gemini-2.5*`. For measurement it asks for a
  single JSON point at temperature 0 (deterministic) instead of a function call.
- **MolmoWeb adapter** posts `{prompt, image_base64}` to `/predict` and parses
  Molmo-style percentage points (`<point x=".." y=".."/>`), converting to pixels.

> ⚠ **Verify the MolmoWeb response shape against your live server.** Builds differ in
> which JSON field holds the generated text and in point formatting. If the text isn't
> under `response`/`text`/`output`, set `MOLMOWEB_RESPONSE_FIELD=<field>`. Eyeball the
> `raw` strings shown in the report on your first run.

## Reading the result

If MolmoWeb clearly wins on `desktop` cases (higher hit rate, lower normDist),
integrating it as a desktop-only grounding provider in `ai-engine.js` is justified.
If it doesn't, invest in Windows UI Automation element targeting instead — no GPU
required. Either way, you'll have decided with data, not vibes.
