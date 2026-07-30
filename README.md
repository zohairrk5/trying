# Credit Agreement Term & Covenant Extractor

A single-evening proof of concept. Drop in a credit agreement PDF, get back structured deal terms and financial covenants — each with a **confidence score** and the **verbatim source text** it was pulled from. Anything below the confidence threshold is flagged for human review.

The point of the demo is the human-in-the-loop + traceability story: the system tells you how sure it is, shows you its evidence, and routes the weak extractions to a person.

## Setup

Requires Node 18+.

```bash
npm install
cp .env.example .env
# open .env and paste your key
npm start
```

Then open <http://localhost:3000>.

**Where the API key goes:** put it in `.env` as `ANTHROPIC_API_KEY=sk-ant-...`. Get one at <https://console.anthropic.com/settings/keys>. The key is read from the environment at startup and never leaves the server — it is not hardcoded and is not exposed to the browser.

Optional overrides in `.env`:

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Any current Claude model id |
| `EXTRACTION_EFFORT` | `medium` | `low` is faster/cheaper, `high` is more thorough |
| `PORT` | `3000` | |

## Using it

Pick one of the two bundled samples, or upload your own text-based PDF, and hit **Extract**. A run takes roughly 30–60 seconds on a full-length agreement.

Results render as two sections — Core Terms and Financial Covenants. Each row shows the field name, the extracted value, a colour-coded confidence pill (green ≥ 0.8, amber 0.5–0.8, red < 0.5), and the source quote beneath it. Rows under 0.8 get a **⚠ Needs human review** badge plus Confirm / Correct buttons; resolving one shows the note about that feedback becoming labelled training data in a real system. There is also a "Show raw JSON response" toggle at the bottom for showing what is under the hood.

## Bundled samples

Both are real, unmodified credit agreements pulled from SEC EDGAR and rendered to PDF:

| File | Source |
| --- | --- |
| `samples/quanex-credit-agreement.pdf` | Quanex Building Products, Amendment No. 1 to Second A&R Credit Agreement (2024). 8-K EX-10.1, accession `0001104659-24-071335`. 210 pages. |
| `samples/scholastic-credit-agreement.pdf` | Scholastic Corporation, Third Amendment to A&R Credit Agreement (2024). 8-K EX-10.1, accession `0001193125-24-270026`. 124 pages. |

To try your own document, drop any text-based PDF on the upload control. Scanned/image PDFs are rejected with a message — OCR is out of scope.

## How it works

```
PDF ──pdf-parse──> raw text ──excerpt──> Claude ──JSON──> UI
```

1. **`server.js`** accepts an upload (or a bundled sample), extracts text with `pdf-parse`, and rejects documents with no extractable text as probable scans.
2. It builds a **targeted excerpt** (see below) and sends it to the Anthropic Messages API with the extraction contract in the system prompt.
3. The model returns bare JSON. If it wraps the JSON in a markdown fence anyway, the fence is stripped and parsing is retried once; a second failure returns a clean error state rather than crashing.
4. **`public/index.html`** is the whole frontend — vanilla JS, no build step.

Everything is held in memory. No database, no accounts, no persistence.

### Why the document gets excerpted

Real credit agreements are 100–200+ pages. The bundled Quanex agreement is 624,000 characters, about 155K tokens. Sending the whole thing works — the model's context window is large enough — but it costs roughly $0.30 and takes several minutes per run, which is no good for a live demo.

So `buildExcerpt()` assembles a focused subset: the first 45K characters (preamble, parties, facility structure, start of definitions) plus ~7.5K-character windows around covenant and pricing language — leverage ratio, interest coverage, financial covenants, applicable margin/rate, maturity date, Term SOFR, and so on. Windows are allocated **round-robin** across those patterns rather than first-come-first-served, so no single term category can exhaust the budget and starve the rest. Overlapping windows are merged, and the total is capped at 130K characters.

Because every window is a contiguous slice of the original text, `source_quote` values remain genuinely verbatim. The UI reports how much of the document was analyzed, so the coverage tradeoff is visible rather than hidden.

In production you would replace this with proper chunking plus retrieval, or just send the full document and eat the cost.

## Known limitations

This is a POC, and deliberately so:

- **The excerpt can miss things.** A covenant expressed in unusual language, or buried in a schedule past the window budget, will not reach the model. The reported coverage numbers make this visible but do not fix it.
- **Confidence is self-reported.** The model's own estimate, not a calibrated probability. It is useful for triage and routing, not for anything load-bearing.
- **Quotes are not verified against the source.** The prompt requires verbatim spans, but nothing checks the returned quote actually appears in the document. That check is a genuinely easy addition (`text.includes(quote)`) and would be the first thing to add.
- **Corrections are not persisted.** Confirm/Correct updates the view only; the training-data note describes what a real system would do with the feedback.
- No auth, no database, no tests, no deployment config, no OCR.

## Files

```
server.js            Express server: upload, PDF text extraction, excerpting, API call, JSON repair
prompt.js            System prompt, field list, and the output contract
public/index.html    Entire frontend (markup, styles, logic)
samples/             Two real SEC EDGAR credit agreements as PDFs
.env.example         Copy to .env and add your key
```
