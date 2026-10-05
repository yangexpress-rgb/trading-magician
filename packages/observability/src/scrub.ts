/**
 * Removes things that must never leave the app in an error report or log line
 * (Design v1.0 §9.2, §16.1): provider keys, webhook secrets, bearer tokens,
 * passwords in connection strings, and email addresses.
 */
const PATTERNS: [RegExp, string][] = [
  [/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, '[redacted key]'],
  [/\bwhsec_[A-Za-z0-9]+/g, '[redacted secret]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi, '$1[redacted]@'],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[redacted pem]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
];

export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
