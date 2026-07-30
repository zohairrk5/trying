'use strict';

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompt');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const EFFORT = process.env.EXTRACTION_EFFORT || 'medium';
const PORT = process.env.PORT || 3000;

// Real credit agreements run 100-200+ pages. Sending the whole thing works
// (the model has a 1M-token context) but costs ~$0.30 and 2-4 minutes per run,
// which is no good for a live demo. Instead we build a focused excerpt: the
// front of the document plus windows around covenant language. Quotes stay
// verbatim because every window is a contiguous slice of the original text.
const EXCERPT_HEAD_CHARS = 45000;
const EXCERPT_MAX_CHARS = 130000;
const WINDOW_BEFORE = 1500;
const WINDOW_AFTER = 6000;
const HITS_PER_PATTERN = 4;

const COVENANT_PATTERNS = [
  /Financial Covenants?/gi,
  /Leverage Ratio/gi,
  /Interest Coverage Ratio/gi,
  /Fixed Charge Coverage Ratio/gi,
  /Minimum Liquidity/gi,
  /Consolidated EBITDA/gi,
  /Applicable (?:Margin|Rate)/gi,
  /Maturity Date/gi,
  /Term SOFR/gi,
];

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const SAMPLES = {
  quanex: {
    label: 'Quanex Building Products — 2nd A&R Credit Agreement (2024)',
    file: 'quanex-credit-agreement.pdf',
    source: 'SEC EDGAR 8-K EX-10.1, accession 0001104659-24-071335',
  },
  scholastic: {
    label: 'Scholastic Corp — A&R Credit Agreement, 3rd Amendment (2024)',
    file: 'scholastic-credit-agreement.pdf',
    source: 'SEC EDGAR 8-K EX-10.1, accession 0001193125-24-270026',
  },
};

/** Merge overlapping [start, end) ranges so windows don't duplicate text. */
function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push(range.slice());
    }
  }
  return merged;
}

function buildExcerpt(text) {
  if (text.length <= EXCERPT_MAX_CHARS) {
    return { excerpt: text, truncated: false };
  }

  // Collect candidate windows per pattern, then interleave them round-robin so
  // every term category gets sampled. Walking the patterns sequentially would
  // let the first two or three exhaust the budget, and fields like maturity
  // date and pricing margin would never reach the model.
  const perPattern = COVENANT_PATTERNS.map((pattern) => {
    pattern.lastIndex = 0;
    const windows = [];
    let match;
    while ((match = pattern.exec(text)) !== null && windows.length < HITS_PER_PATTERN) {
      windows.push([
        Math.max(0, match.index - WINDOW_BEFORE),
        Math.min(text.length, match.index + WINDOW_AFTER),
      ]);
    }
    return windows;
  });

  const deepest = Math.max(0, ...perPattern.map((w) => w.length));
  let ranges = [[0, EXCERPT_HEAD_CHARS]];

  outer: for (let pass = 0; pass < deepest; pass += 1) {
    for (const windows of perPattern) {
      if (!windows[pass]) continue;
      const candidate = mergeRanges(ranges.concat([windows[pass]]));
      const size = candidate.reduce((sum, [s, e]) => sum + (e - s), 0);
      if (size > EXCERPT_MAX_CHARS) break outer;
      ranges = candidate;
    }
  }

  const merged = mergeRanges(ranges);
  const excerpt = merged
    .map(([start, end], i) => {
      const slice = text.slice(start, end);
      return i === 0 ? slice : `\n\n[... document excerpt continues at character ${start} ...]\n\n${slice}`;
    })
    .join('');

  return { excerpt, truncated: true };
}

async function pdfToText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text || '', pages: result.total || 0 };
  } finally {
    await parser.destroy();
  }
}

/**
 * The model is told to return bare JSON. It usually does. When it doesn't, the
 * common failure is a markdown fence, so strip fences and try once more before
 * giving up.
 */
function parseModelJson(raw) {
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (_) {
    /* fall through to the repair attempt */
  }

  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }

  try {
    return { ok: true, data: JSON.parse(cleaned) };
  } catch (err) {
    return { ok: false, error: err.message, raw };
  }
}

function normalizeFields(data) {
  if (!data || !Array.isArray(data.fields)) return null;
  return data.fields
    .filter((f) => f && typeof f.field === 'string')
    .map((f) => ({
      field: f.field,
      value: f.value === undefined ? null : f.value,
      confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : 0,
      source_quote: typeof f.source_quote === 'string' ? f.source_quote : '',
      source_location: typeof f.source_location === 'string' ? f.source_location : '',
    }));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/samples', (_req, res) => {
  const available = Object.entries(SAMPLES)
    .filter(([, s]) => fs.existsSync(path.join(__dirname, 'samples', s.file)))
    .map(([id, s]) => ({ id, label: s.label, source: s.source }));
  res.json({ samples: available });
});

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    let buffer;
    let documentName;

    if (req.file) {
      buffer = req.file.buffer;
      documentName = req.file.originalname;
    } else if (req.body && req.body.sample && SAMPLES[req.body.sample]) {
      const sample = SAMPLES[req.body.sample];
      const filePath = path.join(__dirname, 'samples', sample.file);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `Sample "${req.body.sample}" is not present in /samples.` });
      }
      buffer = fs.readFileSync(filePath);
      documentName = sample.label;
    } else {
      return res.status(400).json({ error: 'Upload a PDF or pick a bundled sample.' });
    }

    let text;
    let pages;
    try {
      ({ text, pages } = await pdfToText(buffer));
    } catch (err) {
      return res.status(400).json({ error: `Could not read that PDF: ${err.message}` });
    }

    if (text.replace(/\s/g, '').length < 200) {
      return res.status(422).json({
        error:
          'No extractable text found. This looks like a scanned/image PDF — OCR is out of scope for this demo. Try a text-based PDF.',
      });
    }

    const { excerpt, truncated } = buildExcerpt(text);

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(excerpt) }],
    });

    const raw = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'The model declined to process this document.' });
    }

    const parsed = parseModelJson(raw);
    if (!parsed.ok) {
      return res.status(502).json({
        error: 'The model returned something that was not valid JSON.',
        detail: parsed.error,
        raw: parsed.raw.slice(0, 2000),
      });
    }

    const fields = normalizeFields(parsed.data);
    if (!fields) {
      return res.status(502).json({ error: 'The model returned JSON without a "fields" array.' });
    }

    res.json({
      documentName,
      fields,
      meta: {
        pages,
        documentChars: text.length,
        analyzedChars: excerpt.length,
        truncated,
        model: response.model,
        effort: EFFORT,
        usage: response.usage,
        stop_reason: response.stop_reason,
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is missing or invalid. See README.' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Rate limited by the Anthropic API. Wait a moment and retry.' });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Anthropic API error (${err.status}): ${err.message}` });
    }
    console.error(err);
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`Credit Agreement Extractor running at http://localhost:${PORT}`);
  console.log(`Model: ${MODEL} (effort: ${EFFORT})`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set — extraction calls will fail.');
  }
});
