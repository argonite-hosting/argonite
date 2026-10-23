// Writes a copy of index.html per static route with the right title and description, so link previews
// and search engines see real metadata. Project and user pages are filled in per request by the site worker.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, headTags, withHead } from '../edge/tags.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const site = JSON.parse(readFileSync(join(here, '..', '..', 'config', 'site.json'), 'utf8'));
const siteUrl = `https://${site.domain}`;
const template = readFileSync(join(dist, 'index.html'), 'utf8');

const home = [
  { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: `${siteUrl}/`, description: site.description },
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: site.name,
    url: `${siteUrl}/`,
    logo: `${siteUrl}/apple-touch-icon.png`,
    sameAs: [`https://github.com/${site.github.sourceRepo.split('/')[0]}`],
  },
];

function render({ path, title, description, jsonLd }) {
  const tags = headTags({
    url: siteUrl + (path === '/' ? '/' : path),
    title: title ? `${title} · ${site.name}` : `${site.name} · ${site.tagline}`,
    ogTitle: title || site.name,
    description,
    image: `${siteUrl}/og.png`,
    imageAlt: `${site.name} logo`,
    imageSize: [1200, 630],
    card: 'summary_large_image',
    type: 'website',
    jsonLd,
  });
  return withHead(template, tags);
}

function write(path, html) {
  const file = path === '/' ? join(dist, 'index.html') : join(dist, ...path.split('/').filter(Boolean), 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

const types = [
  ['mods', 'Mods'],
  ['plugins', 'Plugins'],
  ['resourcepacks', 'Resource packs'],
  ['shaders', 'Shaders'],
  ['datapacks', 'Data packs'],
  ['modpacks', 'Modpacks'],
];

const pages = [
  { path: '/', title: '', description: site.description, jsonLd: home },
  { path: '/browse', title: 'Browse', description: site.description },
  ...types.map(([p, label]) => ({ path: `/${p}`, title: label, description: `Find Minecraft ${label.toLowerCase()} on ${site.name}, scanned for malware and verified on every download.` })),
  { path: '/servers', title: 'Minecraft servers', description: `Find Minecraft servers with live player counts on ${site.name}, and the verified modpacks they run.` },
  { path: '/how-it-works', title: 'How verification works', description: `How ${site.name} scans, signs and verifies every Minecraft file.` },
  { path: '/help/formatting', title: 'Formatting guide', description: `What you can use in project descriptions, changelogs and server descriptions on ${site.name}.` },
  { path: '/api-docs', title: 'Public API', description: `Read-only JSON API for ${site.name}, with signed file fingerprints for launchers.` },
  { path: '/legal/terms', title: 'Terms of Service', description: `Terms of Service for ${site.name}.` },
  { path: '/legal/privacy', title: 'Privacy Policy', description: `How ${site.name} handles your data.` },
  { path: '/legal/rules', title: 'Content rules', description: `What can be published on ${site.name}.` },
  { path: '/legal/security', title: 'Security', description: `Report vulnerabilities and malicious files to ${site.name}.` },
  { path: '/legal/dmca', title: 'Copyright & DMCA', description: `Copyright notices for ${site.name}.` },
];

for (const p of pages) write(p.path, render(p));

// The site worker lists this next to the project and user sitemaps.
mkdirSync(join(dist, 'sitemaps'), { recursive: true });
writeFileSync(
  join(dist, 'sitemaps', 'pages.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map((p) => `  <url><loc>${esc(siteUrl + (p.path === '/' ? '/' : p.path))}</loc></url>`)
    .join('\n')}\n</urlset>\n`,
);
console.log(`Prerendered ${pages.length} pages.`);
