import { normalizeText } from '../../shared/finance';

function statementText(description: string): string {
  return normalizeText(description)
    .replace(/^(?:POS|OVERSEAS) PURCHASE (?:\(EFF(?:EC(?:TIVE)?)?\b[^)]*\) )?/, '')
    .replace(/\s+CARD (?:NO|NUMBER)\b.*$/, '');
}

export function safeDescription(description: string): string {
  return statementText(description)
    .replace(/\((?:EFF(?:EC(?:TIVE)?)?|AMT)\b[^)]*\)/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/g, ' ')
    .replace(/\b(?:ACCOUNT|ACCT|A\/C|REF(?:ERENCE)?|CARD|TRACE|AUTH)\s*(?:NO|NUMBER|#)?\s*[:#-]?\s*[A-Z-]*\d[\w./-]*/g, ' ')
    .replace(/\b[\w./-]*\d[\w./-]*\b/g, ' ')
    .replace(/[^\p{L}& -]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 120).trim();
}

export function ruleMatch(description: string): { name: string; match: string } | null {
  const detail = statementText(description)
    .split(/\s+(?:\((?:EFF(?:EC(?:TIVE)?)?|AMT)\b|(?:CARD|ACCOUNT|ACCT|REF(?:ERENCE)?|TRACE|AUTH)\s+(?:NO\b|NUMBER\b|#|[A-Z-]*\d))/, 1)[0]!;
  const match = detail.replace(/\s+\S*\d{4,}.*$/, '').trim();
  if (safeDescription(detail.slice(match.length))) return null;
  const summary = safeDescription(match)
    .replace(/^DIGITAL PAYMENT (?:DT|CR) ABSA BANK /, '')
    .replace(/^(TRANSACTION FEE DECL) POS TRAN FEE$/, '$1');
  if (!/\p{L}{3}/u.test(summary) || match.length > 200 || /\d{4,}|@/.test(match) ||
      /^(?:ACB (?:DEBIT|CREDIT)(?: EXTERNAL)?|DIGITAL TRANSF (?:DT|CR)|TRANSACTION FEE|POS CARD REFUND)$/.test(summary)) return null;
  const name = summary.toLowerCase().replace(/(^|[ -])\p{L}/gu, (initial) => initial.toUpperCase());
  return { name: name.slice(0, 80).trimEnd(), match };
}

export function shorterMatch(value: string, source: string): string | null {
  const match = normalizeText(value);
  const start = source.indexOf(match);
  if (start < 0 || match.length < 3 || /^(BANK|CARD|FEE|PAYMENT|PURCHASE|REFUND|SHOP|TRANSFER)$/.test(match)) return null;
  const partOfWord = /[\p{L}\p{N}]/u;
  return partOfWord.test(source.charAt(start - 1)) || partOfWord.test(source.charAt(start + match.length)) ? null : match;
}
