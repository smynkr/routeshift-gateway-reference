const PII_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, label: 'EMAIL' },
  { regex: /(?:\+1[\-.\s]?)?(?:\(\d{3}\)[\-.\s]?|\d{3}[\-.\s])\d{3}[\-.\s]?\d{4}/g, label: 'PHONE' },
  { regex: /\b\d{3}-\d{2}-\d{4}\b/g, label: 'SSN' },
  { regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, label: 'CARD' },
  { regex: /\b(?:sk|pk|api|key|token)[_-][a-zA-Z0-9]{20,}\b/g, label: 'APIKEY' },
  { regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, label: 'IP' },
];

export function stripPii(text: string): string {
  let result = text;
  for (const { regex, label } of PII_PATTERNS) {
    regex.lastIndex = 0;
    result = result.replace(regex, `[REDACTED_${label}]`);
  }
  return result;
}
