// Collects every interface string that goes through t()/tn(), plus the shared labels the UI translates
// at runtime, and reports which keys each locale file is missing or no longer uses.
//   node tools/i18n/extract.mjs            report
//   node tools/i18n/extract.mjs --verbose          list each missing or unused key
//   node tools/i18n/extract.mjs --write <file>     also write the key list as a JSON template
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const web = join(root, 'web/src');
const keys = new Map();
const plurals = new Set();
const singular = new Set();

const unquote = (q) => q.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n');
const add = (k, from) => {
  if (k && /[A-Za-z]/.test(k) && !keys.has(k)) keys.set(k, from);
};

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

const STR = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const call = new RegExp(String.raw`\bt\(\s*` + STR, 'g');
const ternary = new RegExp(String.raw`\bt\(\s*[^?()]*\?\s*` + STR + String.raw`\s*:\s*` + STR, 'g');
const plural = new RegExp(String.raw`\btn\(\s*[^,]+,\s*` + STR + String.raw`\s*,\s*` + STR, 'g');
const labelProp = new RegExp(String.raw`\b(?:label|plural|title|body):\s*` + STR, 'g');
const tuple = new RegExp(String.raw`\[\s*'[a-z0-9-]+'\s*,\s*('[A-Z](?:[^'\\]|\\.)*')\s*\]`, 'g');

for (const file of walk(web)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  if (rel.endsWith('pages/Legal.tsx')) continue;
  const s = readFileSync(file, 'utf8');
  for (const m of s.matchAll(call)) {
    add(unquote(m[1]), rel);
    singular.add(unquote(m[1]));
  }
  for (const m of s.matchAll(ternary)) {
    add(unquote(m[1]), rel);
    add(unquote(m[2]), rel);
  }
  for (const m of s.matchAll(plural)) {
    add(unquote(m[2]), rel);
    plurals.add(unquote(m[2]));
  }
  for (const m of s.matchAll(labelProp)) add(unquote(m[1]), rel);
  for (const m of s.matchAll(tuple)) add(unquote(m[1]), rel);
}

// Shared labels shown through t(variable).
const shared = (f) => readFileSync(join(root, f), 'utf8');
for (const f of ['shared/taxonomy.ts', 'shared/permissions.ts']) {
  const s = shared(f);
  for (const m of s.matchAll(labelProp)) add(unquote(m[1]), f);
  for (const block of s.matchAll(/_LABELS[^=]*=\s*\{([\s\S]*?)\n\};/g)) {
    for (const m of block[1].matchAll(new RegExp(String.raw`:\s*` + STR, 'g'))) add(unquote(m[1]), f);
  }
}
for (const m of shared('shared/validate.ts').matchAll(new RegExp(String.raw`return\s+` + STR, 'g'))) add(unquote(m[1]), 'shared/validate.ts');
const block = (file, name) => readFileSync(join(web, file), 'utf8').match(new RegExp(String.raw`const ${name}[^=]*=\s*\{([\s\S]*?)\n\};`))?.[1] ?? '';
for (const [file, name] of [['lib/typeIcons.ts', 'TYPE_BLURB'], ['lib/notifications.ts', 'STATUS']]) {
  for (const m of block(file, name).matchAll(new RegExp(String.raw`:\s*` + STR, 'g'))) add(unquote(m[1]), `web/src/${file}`);
}

// Enum values the UI shows as t(value) or t(Capitalized).
for (const k of [
  'critical', 'high', 'medium', 'low', 'info', 'clean', 'suspicious', 'malicious', 'unscanned',
  'required', 'optional', 'incompatible', 'embedded', 'Required', 'Optional', 'Incompatible', 'Embedded',
  'Open', 'Resolved', 'Dismissed', 'User', 'Moderator', 'Admin', 'Release', 'Beta', 'Alpha',
]) add(k, 'enum');

// Names that read the same in every language; locale files may leave them out.
const KEEP = new Set([
  'Babric', 'BTA (Babric)', 'Bukkit', 'BungeeCord', 'Canvas', 'Fabric', 'Folia', 'Forge', 'Iris', 'LiteLoader', 'ModLoader', 'NeoForge',
  'NilLoader', 'OptiFine', 'Ornithe', 'Paper', 'Purpur', 'Quilt', 'Rift', 'Spigot', 'Sponge', 'Velocity', 'Waterfall', 'Minecraft',
  'Discord', 'Markdown', 'MIT', 'Apache 2.0', 'BSD 2-Clause', 'BSD 3-Clause', 'CC0 1.0', 'CC BY 4.0', 'CC BY-NC 4.0', 'CC BY-NC-SA 4.0',
  'CC BY-SA 4.0', 'GPL 3.0 only', 'GPL 3.0 or later', 'LGPL 3.0 only', 'LGPL 3.0 or later', 'AGPL 3.0 only', 'Mozilla Public License 2.0',
  '16x', '32x', '64x', '128x+', 'SMP', 'PvP', 'GUI', '{project} {version}', '{used} / {max}', 'Wiki', 'Javadoc',
]);

const misused = [...plurals].filter((k) => singular.has(k));
if (misused.length) {
  console.log(`Plural keys passed to t() instead of tn(): ${misused.join(', ')}`);
  process.exitCode = 1;
}

const list = [...keys.keys()].sort((a, b) => a.localeCompare(b));
console.log(`${list.length} keys (${plurals.size} plural)`);

const dir = join(web, 'locales');
for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => /^[a-zA-Z-]+\.json$/.test(x)) : []) {
  const dict = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const missing = list.filter((k) => !(k in dict) && !KEEP.has(k));
  const unused = Object.keys(dict).filter((k) => !keys.has(k));
  const badPlural = [...plurals].filter((k) => k in dict && typeof dict[k] !== 'object');
  const vars = (x) => [...new Set(x.match(/\{\w+\}/g) ?? [])].filter((y) => y !== '{n}').sort().join();
  const badVars = Object.entries(dict).filter(([k, v]) => (typeof v === 'string' ? [v] : Object.values(v)).some((x) => vars(x) !== vars(k)));
  if (missing.length || unused.length || badPlural.length || badVars.length) process.exitCode = 1;
  console.log(`${f}: ${missing.length} missing, ${unused.length} unused, ${badPlural.length} plural shape, ${badVars.length} placeholder mismatch`);
  if (process.argv.includes('--verbose')) {
    for (const k of missing) console.log('  missing:', k);
    for (const k of unused) console.log('  unused:', k);
    for (const [k] of badVars) console.log('  vars:', k);
  }
}

if (process.argv.includes('--write')) {
  const out = process.argv[process.argv.indexOf('--write') + 1];
  writeFileSync(out, JSON.stringify(Object.fromEntries(list.map((k) => [k, plurals.has(k) ? 'PLURAL' : ''])), null, 2) + '\n');
  console.log('wrote', out);
}
