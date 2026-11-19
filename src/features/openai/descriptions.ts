import { normalizeText } from '../../shared/finance';

export function safeDescription(description: string): string {
  return normalizeText(description)
    .replace(/\(EFFEC(?:TIVE)?\s+[^)]*\)/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/g, ' ')
    .replace(/\b(?:ACCOUNT|ACCT|A\/C|REF(?:ERENCE)?|CARD|TRACE|AUTH)\s*(?:NO|NUMBER|#)?\s*[:#-]?\s*[A-Z-]*\d[\w./-]*/g, ' ')
    .replace(/\b[A-Z]*\d[\d A-Z./-]*\d[A-Z]*\b/g, ' ')
    .replace(/\b[\w-]*\d[\w-]*\b/g, ' ')
    .replace(/[^\p{L}& -]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 120).trim();
}

export function ruleMatch(description: string): { text: string; operator: 'contains' | 'equals' } | null {
  const source = normalizeText(description);
  const pos = /^POS PURCHASE (?:\(EFFEC(?:TIVE)? \d{8}\) )?(.+)$/.exec(source);
  const merchant = pos?.[1] && safeDescription(pos[1]);
  if (merchant && merchant.length >= 4 && source.includes(merchant)) return { text: merchant, operator: 'contains' };
  if (source.length <= 200) return { text: source, operator: 'equals' };
  return null;
}
