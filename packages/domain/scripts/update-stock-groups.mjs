// Refreshes the member lists of the built-in stock groups besides the S&P 500
// (ADR 0079). Alpaca does not say which index a stock is in, so each list
// ships with the app and this script rewrites it from a public source:
//   - Nasdaq 100, Dow 30, S&P MidCap 400, S&P SmallCap 600: the member
//     tables of Wikipedia's articles (facts, read through the MediaWiki API).
//   - Russell 1000 and Russell 2000: FTSE Russell's lists are not public, so
//     the holdings iShares publishes for IWB and IWM stand in for them.
// Run with:
//   pnpm --filter @tm/domain groups:update            (every group)
//   pnpm --filter @tm/domain groups:update ndx dji    (only these)
// The GitHub workflow "Refresh stock groups" runs it once a month.
/* global URL, fetch, console, process, setTimeout */
import { readFileSync, writeFileSync } from 'node:fs';

const USER_AGENT = 'trading-magician-stock-groups/1.0 (member list refresh)';

/** Where each group comes from, and how many members it should have. */
const GROUPS = [
  {
    id: 'ndx',
    name: 'Nasdaq 100',
    wiki: ['List of NASDAQ-100 companies', 'Nasdaq-100'],
    // Nasdaq's own list, when Wikipedia's table can't be read (no sectors).
    nasdaq: 'https://api.nasdaq.com/api/quote/list-type/nasdaq100',
    min: 95,
    max: 110,
    source: 'Wikipedia, "Nasdaq-100"',
  },
  {
    id: 'dji',
    name: 'Dow Jones Industrial Average',
    wiki: ['List of Dow Jones Industrial Average companies', 'Dow Jones Industrial Average'],
    min: 30,
    max: 30,
    source: 'Wikipedia, "Dow Jones Industrial Average"',
  },
  {
    id: 'sp400',
    name: 'S&P MidCap 400',
    wiki: ['List of S&P 400 companies'],
    min: 380,
    max: 420,
    source: 'Wikipedia, "List of S&P 400 companies"',
  },
  {
    id: 'sp600',
    name: 'S&P SmallCap 600',
    wiki: ['List of S&P 600 companies'],
    min: 570,
    max: 630,
    source: 'Wikipedia, "List of S&P 600 companies"',
  },
  {
    id: 'r1000',
    name: 'Russell 1000',
    ishares:
      'https://www.ishares.com/us/products/239707/ishares-russell-1000-etf/1467271812596.ajax?fileType=csv&fileName=IWB_holdings&dataType=fund',
    min: 950,
    max: 1060,
    source: 'iShares Russell 1000 ETF (IWB) holdings',
  },
  {
    id: 'r2000',
    name: 'Russell 2000',
    ishares:
      'https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund',
    min: 1850,
    max: 2100,
    source: 'iShares Russell 2000 ETF (IWM) holdings',
  },
];

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page's text; a busy answer (429/503) is retried after the wait it asks for. */
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    });
    if (response.ok) return response.text();
    if ((response.status === 429 || response.status === 503) && attempt < 4) {
      const wait = Number(response.headers.get('retry-after')) || 10 * attempt;
      await pause(Math.min(wait, 60) * 1000);
      continue;
    }
    throw new Error(`${url} answered ${response.status}`);
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML into plain text: tags and footnote markers out, entities decoded. */
function text(html) {
  return html
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1));
        return String.fromCodePoint(code);
      }
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** The cells of each row of an HTML table, header cells included. */
function rows(table) {
  return [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((tr) =>
    [...tr[0].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => ({
      header: c[1].toLowerCase() === 'h',
      text: text(c[2]),
    })),
  );
}

/**
 * The members table of a Wikipedia article: the first wikitable with a
 * Symbol or Ticker column. Sectors come from a "GICS Sector" or "Sector"
 * column when the table has one.
 */
async function fromWikipedia(group) {
  const problems = [];
  for (const page of group.wiki) {
    try {
      return await fromWikipediaPage(page);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
    await pause(1000);
  }
  if (group.nasdaq) {
    try {
      return await fromNasdaq(group);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(problems.join('\n'));
}

/** Nasdaq's published member list (symbols only). */
async function fromNasdaq(group) {
  const rows = JSON.parse(await get(group.nasdaq))?.data?.data?.rows;
  if (!Array.isArray(rows)) throw new Error('Nasdaq’s member list has changed shape');
  return rows.map((r) => [
    String(r.symbol).toUpperCase().replace(/\//g, '.'),
    String(r.sector ?? ''),
  ]);
}

async function fromWikipediaPage(page) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=text&formatversion=2&redirects=1&page=${encodeURIComponent(page)}`;
  const body = JSON.parse(await get(url));
  if (!body.parse) throw new Error(`"${page}": ${body.error?.info ?? 'no page'}`);
  const html = body.parse.text;
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const table of tables) {
    const all = rows(table);
    const headerAt = all.findIndex((r) => r.length > 0 && r.every((c) => c.header));
    if (headerAt < 0) continue;
    const head = all[headerAt].map((c) => c.text.toLowerCase());
    const symbolAt = head.findIndex((h) => h === 'symbol' || h === 'ticker');
    if (symbolAt < 0) continue;
    let sectorAt = head.findIndex((h) => h.includes('gics sector'));
    if (sectorAt < 0) sectorAt = head.findIndex((h) => h === 'sector');
    const members = [];
    for (const r of all.slice(headerAt + 1)) {
      // A row may open with a header cell (the company); count cells as written.
      if (r.length !== head.length) continue;
      const symbol = r[symbolAt].text.toUpperCase().replace(/\s+/g, '');
      if (!SYMBOL.test(symbol)) continue;
      members.push([symbol, sectorAt >= 0 ? r[sectorAt].text : '']);
    }
    if (members.length > 0) return members;
  }
  const seen = tables
    .map(rows)
    .filter((all) => all.length >= 20)
    .map(
      (all) =>
        `[${all.length} rows: ${all
          .slice(0, 3)
          .map(
            (r) =>
              `(${r.length}) ` +
              r.map((c) => (c.header ? 'H:' : '') + c.text.slice(0, 24)).join(' | '),
          )
          .join(' // ')}]`,
    )
    .join('\n  ');
  throw new Error(`no members table found on Wikipedia's "${page}"; tables:\n  ${seen}`);
}

/** One CSV line into fields, honouring double quotes. */
function fields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Share-class symbols as Alpaca writes them (BRK.B), keyed by their dotless form (BRKB). */
function classShares(known) {
  const map = new Map();
  for (const s of known) if (s.includes('.')) map.set(s.replace(/\./g, ''), s);
  return map;
}

/** An ETF's stock holdings, from the CSV iShares publishes, with their sectors. */
async function fromIshares(group, dotted) {
  const file = fileFor(group.id);
  const csv = (file ? readFileSync(file, 'utf8') : await get(group.ishares)).replace(/^\uFEFF/, '');
  const lines = csv.split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /^"?Ticker"?,/.test(l));
  if (headerAt < 0)
    throw new Error(
      `the iShares holdings file has changed shape; it starts:\n${lines.slice(0, 12).join('\n').slice(0, 1500)}`,
    );
  const cols = fields(lines[headerAt]).map((c) => c.trim());
  const symbolAt = cols.indexOf('Ticker');
  const sectorAt = cols.indexOf('Sector');
  const classAt = cols.indexOf('Asset Class');
  if (sectorAt < 0 || classAt < 0) throw new Error(`missing iShares columns: ${cols.join(', ')}`);
  const members = [];
  for (const line of lines.slice(headerAt + 1)) {
    const f = fields(line);
    if (f.length < cols.length || f[classAt].trim() !== 'Equity') continue;
    let symbol = f[symbolAt]
      .trim()
      .toUpperCase()
      .replace(/[\s/-]+/g, '.');
    symbol = dotted.get(symbol) ?? symbol;
    if (!SYMBOL.test(symbol)) continue;
    members.push([symbol, f[sectorAt].trim()]);
  }
  return members;
}

const IDENT = (id) => id.toUpperCase();

function write(group, members, asOf) {
  const out = new URL(`../src/market/groups/${group.id}-members.ts`, import.meta.url);
  writeFileSync(
    out,
    `/**
 * ${group.name} members and their sectors (ADR 0079). Generated by
 * \`pnpm --filter @tm/domain groups:update ${group.id}\` from ${group.source};
 * do not edit by hand.
 */

export const ${IDENT(group.id)}_AS_OF = '${asOf}';

export const ${IDENT(group.id)}_SOURCE = ${JSON.stringify(group.source)};

/** \`[symbol, sector]\`, symbols as Alpaca writes them (BRK.B); sector '' when the source has none. */
export const ${IDENT(group.id)}_MEMBERS: readonly (readonly [string, string])[] = [
${members.map(([s, sector]) => `  [${JSON.stringify(s)}, ${JSON.stringify(sector)}],`).join('\n')}
];
`,
  );
}

// Share classes the S&P lists write with a dot, to read iShares' dotless tickers.
const sp500 = readFileSync(new URL('../src/market/sp500-members.ts', import.meta.url), 'utf8');
const known = new Set([...sp500.matchAll(/\['([A-Z0-9.]+)',/g)].map((m) => m[1]));

// `--file r2000=IWM_holdings.csv`: a holdings file saved from iShares' fund page, which
// does not hand its files to scripts.
const args = process.argv.slice(2);
const files = new Map();
const wanted = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') {
    const [id, path] = (args[++i] ?? '').split('=');
    if (!id || !path) throw new Error('Use --file <group>=<path>');
    files.set(id, path);
    wanted.push(id);
  } else wanted.push(args[i]);
}
function fileFor(id) {
  return files.get(id);
}
const asOf = new Date().toISOString().slice(0, 10);
const failures = [];
// Wikipedia groups first, so their share-class symbols help read iShares' tickers.
for (const group of GROUPS.filter((g) => wanted.length === 0 || wanted.includes(g.id))) {
  try {
    const raw = group.wiki
      ? await fromWikipedia(group)
      : await fromIshares(group, classShares(known));
    const bySymbol = new Map();
    for (const [s, sector] of raw) if (!bySymbol.has(s)) bySymbol.set(s, sector);
    const members = [...bySymbol].sort((a, b) => a[0].localeCompare(b[0]));
    if (members.length < group.min || members.length > group.max) {
      throw new Error(
        `expected ${group.min}–${group.max} members, got ${members.length}: ${members
          .slice(0, 15)
          .map(([s]) => s)
          .join(', ')}`,
      );
    }
    for (const [s] of members) known.add(s);
    write(group, members, asOf);
    // eslint-disable-next-line no-console -- a command-line script reports what it wrote
    console.log(`Wrote ${members.length} ${group.name} members as of ${asOf}`);
  } catch (err) {
    failures.push(`${group.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (failures.length > 0) {
  // eslint-disable-next-line no-console -- a command-line script reports what failed
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
