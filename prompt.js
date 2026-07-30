'use strict';

/**
 * The extraction contract. The field list is shared with the frontend so the UI
 * can group rows into Core Terms vs Financial Covenants without guessing.
 */
const CORE_TERMS = [
  'Borrower',
  'Lender / Administrative Agent',
  'Facility type',
  'Principal / commitment amount',
  'Currency',
  'Maturity date',
  'Interest rate / margin',
];

const FINANCIAL_COVENANTS = [
  'Maximum leverage ratio',
  'Minimum interest coverage ratio',
  'Minimum liquidity / minimum EBITDA',
];

const SYSTEM_PROMPT = `You are a credit agreement analyst. You extract structured deal terms and financial covenants from loan documents, and you cite the exact source text for every value.

Extract exactly these fields, in this order:

Core terms:
${CORE_TERMS.map((f) => `- ${f}`).join('\n')}

Financial covenants:
${FINANCIAL_COVENANTS.map((f) => `- ${f}`).join('\n')}

Then append one entry for each additional financial covenant you find in the document (for example a maximum secured leverage ratio, a minimum fixed charge coverage ratio, or a capital expenditure limit). Use the covenant's own name as the field name.

Rules:
- Output valid JSON only. No markdown fences, no commentary, no preamble.
- "confidence" is a float between 0 and 1 reflecting how certain the extraction is given the text you were shown.
- "source_quote" MUST be a verbatim span copied character-for-character from the document. Never paraphrase, never stitch together separated sentences. If you cannot find a real supporting quote, confidence must be 0.3 or lower and source_quote must be an empty string.
- Never invent a value. If a field is not present in the document, return it with "value": null and "confidence": 0.
- Return every field listed above even when it is absent, so the caller always gets the same shape.
- "source_location" is a short human-readable pointer such as "Section 7.11, Financial Covenants" or "Preamble, page 1". Use an empty string if you cannot tell.

Respond with exactly this JSON shape:

{
  "fields": [
    {
      "field": "Borrower",
      "value": "Acme Holdings LLC",
      "confidence": 0.97,
      "source_quote": "This Credit Agreement is entered into by Acme Holdings LLC, as Borrower",
      "source_location": "Preamble, page 1"
    }
  ]
}`;

function buildUserPrompt(documentText) {
  return `Here is the credit agreement text.

<document>
${documentText}
</document>

Extract the terms and covenants as specified. Return JSON only.`;
}

module.exports = { SYSTEM_PROMPT, buildUserPrompt, CORE_TERMS, FINANCIAL_COVENANTS };
