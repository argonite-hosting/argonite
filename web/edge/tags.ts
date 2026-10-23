// Head tags for a page, shared by the build-time prerender and the site worker.
// No imports on purpose: Node loads this file directly during the build.

export interface HeadInput {
  url: string;
  title: string;
  ogTitle: string;
  description: string;
  image: string;
  imageAlt: string;
  imageSize?: [number, number];
  card: 'summary' | 'summary_large_image';
  type: 'website' | 'profile';
  noindex?: boolean;
  jsonLd?: object[];
}

const START = '<!--meta:start-->';
const END = '<!--meta:end-->';

export function esc(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// JSON inside a script tag only needs "<" escaped to stay inert.
function ldJson(data: object): string {
  return `<script type="application/ld+json" data-page>${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function headTags(h: HeadInput): string {
  const tags = [
    `<title>${esc(h.title)}</title>`,
    `<meta name="description" content="${esc(h.description)}" />`,
    `<link rel="canonical" href="${esc(h.url)}" />`,
    h.noindex ? '<meta name="robots" content="noindex" />' : '',
    `<meta property="og:type" content="${h.type}" />`,
    `<meta property="og:title" content="${esc(h.ogTitle)}" />`,
    `<meta property="og:description" content="${esc(h.description)}" />`,
    `<meta property="og:url" content="${esc(h.url)}" />`,
    `<meta property="og:image" content="${esc(h.image)}" />`,
    `<meta property="og:image:alt" content="${esc(h.imageAlt)}" />`,
    h.imageSize ? `<meta property="og:image:width" content="${h.imageSize[0]}" />` : '',
    h.imageSize ? `<meta property="og:image:height" content="${h.imageSize[1]}" />` : '',
    `<meta name="twitter:card" content="${h.card}" />`,
    ...(h.jsonLd ?? []).map(ldJson),
  ];
  return tags.filter(Boolean).join('\n    ');
}

export function withHead(template: string, tags: string): string {
  const start = template.indexOf(START);
  const end = template.indexOf(END);
  if (start < 0 || end < start) throw new Error('index.html is missing the meta markers');
  return `${template.slice(0, start + START.length)}\n    ${tags}\n    ${template.slice(end)}`;
}

// The plain copy sits in <noscript>: browsers running the app never draw it (no flash of an unstyled
// page while the stylesheet loads), while crawlers and visitors without JavaScript still get it.
export function withBody(template: string, html: string): string {
  return template.replace('<div id="app"></div>', `<div id="app"><noscript>${html}</noscript></div>`);
}
