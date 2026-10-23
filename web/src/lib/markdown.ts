// Renders user Markdown (descriptions, changelogs) to HTML that is safe to insert into the page.
// DOMPurify removes anything not on the allowlist below; the pass after it enforces the per-tag rules
// (allowed attribute values, https-only media, YouTube-only embeds). The formatting guide on the site
// (pages/Formatting.tsx) documents these rules for authors, so keep the two in step.
import DOMPurify, { type Config } from 'dompurify';
import { Marked } from 'marked';
import { isBlocked, type BlockedLinks } from './blockedLinks';
import { t } from './i18n';

const marked = new Marked({ gfm: true, breaks: false, async: false });

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const TAGS = [
  ...HEADINGS,
  'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'kbd', 'div', 'span', 'details', 'summary', 'figure', 'figcaption',
  'strong', 'b', 'em', 'i', 's', 'del', 'mark', 'small', 'sub', 'sup', 'abbr', 'wbr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'a', 'img', 'picture', 'source', 'video', 'audio', 'iframe', 'input', 'progress', 'meter',
];

const GLOBAL_ATTRS = ['title', 'lang'];
const ALIGNABLE = new Set(['p', 'div', 'img', 'h2', 'h3', 'h4', 'h5', 'h6', 'th', 'td']);
const ATTRS: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  ol: ['start', 'reversed', 'type'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  details: ['open'],
  input: ['type', 'checked'],
  source: ['srcset', 'media'],
  video: ['src', 'poster', 'width', 'height', 'loop', 'muted'],
  audio: ['src', 'loop'],
  iframe: ['src'],
  progress: ['value', 'max'],
  meter: ['value', 'min', 'max'],
};

const PURIFY: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: TAGS,
  ALLOWED_ATTR: [...new Set([...GLOBAL_ATTRS, 'align', ...Object.values(ATTRS).flat()])],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/(?![/\\]))/i,
  // Only href, src, srcset and poster hold URLs; DOMPurify would otherwise check every value against the URL pattern.
  ADD_URI_SAFE_ATTR: ['align', 'lang', 'width', 'height', 'start', 'reversed', 'type', 'colspan', 'rowspan', 'open', 'checked', 'media', 'loop', 'muted', 'value', 'min', 'max'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

const HTTPS = /^https:\/\/[^\s"'<>]+$/i;
const DARK_LIGHT = new Set(['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)']);
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);

const isNumber = (v: string | null, max: number) => v !== null && /^\d{1,6}(\.\d{1,4})?$/.test(v) && Number(v) <= max;

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

// https://www.youtube.com/embed/<id>?start=<seconds> → a fixed, sandboxed player on the no-cookie domain.
function youtubeEmbed(src: string | null, doc: Document): HTMLElement | null {
  if (!src) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  const id = /^\/embed\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname) || !id) return null;
  const start = url.searchParams.get('start');
  const frame = doc.createElement('iframe');
  frame.setAttribute('src', `https://www.youtube-nocookie.com/embed/${id}${start && /^\d{1,6}$/.test(start) ? `?start=${start}` : ''}`);
  frame.setAttribute('title', 'YouTube video');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media');
  frame.setAttribute('allowfullscreen', '');
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  frame.setAttribute('loading', 'lazy');
  const box = doc.createElement('div');
  box.setAttribute('class', 'prose-embed');
  box.appendChild(frame);
  return box;
}

function rename(el: Element, tag: string): Element {
  const next = el.ownerDocument.createElement(tag);
  for (const a of [...el.attributes]) next.setAttribute(a.name, a.value);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
  return next;
}

// Applies the per-tag rules. Runs on DOMPurify's output, so nothing here can introduce scripting.
function enforce(root: DocumentFragment, blocked: BlockedLinks | null): void {
  const doc = root.ownerDocument;
  const used = new Map<string, number>();
  for (let el of [...root.querySelectorAll('*')]) {
    if (!root.contains(el)) continue; // inside something already removed
    let tag = el.tagName.toLowerCase();

    // The page already has its own h1, so authors' top-level headings become h2.
    if (tag === 'h1') {
      el = rename(el, 'h2');
      tag = 'h2';
    }

    const allowed = new Set([...GLOBAL_ATTRS, ...(ATTRS[tag] ?? []), ...(ALIGNABLE.has(tag) ? ['align'] : [])]);
    for (const a of [...el.attributes]) if (!allowed.has(a.name)) el.removeAttribute(a.name);
    const attr = (n: string) => el.getAttribute(n);
    const drop = (n: string) => el.removeAttribute(n);

    // Links and media pointing at sites found on a malware or phishing list after they were published.
    if (['a', 'img', 'video', 'audio', 'iframe'].includes(tag) && isBlocked(attr(tag === 'a' ? 'href' : 'src'), blocked)) {
      if (tag === 'a') {
        drop('href');
        el.setAttribute('title', t('Link removed: this site is on a malware or phishing list.'));
        el.setAttribute('class', 'blocked-link');
        continue;
      }
      el.remove();
      continue;
    }
    if (tag === 'source' && isBlocked(attr('srcset'), blocked)) {
      el.remove();
      continue;
    }

    if (attr('lang') !== null && !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(attr('lang')!)) drop('lang');
    if (attr('align') !== null && !['left', 'center', 'right'].includes(attr('align')!.toLowerCase())) drop('align');
    for (const n of ['width', 'height']) if (attr(n) !== null && !isNumber(attr(n), 4000)) drop(n);

    switch (tag) {
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        // Anchors for in-page links, prefixed so they can never clash with the site's own ids.
        const base = slugifyHeading(el.textContent ?? '');
        if (base) {
          const n = used.get(base) ?? 0;
          used.set(base, n + 1);
          el.setAttribute('id', `user-content-${base}${n ? `-${n}` : ''}`);
        }
        break;
      }
      case 'a': {
        const href = attr('href') ?? '';
        if (href.startsWith('#') && href.length > 1) el.setAttribute('href', `#user-content-${slugifyHeading(decodeURIComponent(href.slice(1)))}`);
        else if (/^https?:/i.test(href)) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer nofollow ugc');
        }
        break;
      }
      case 'img':
        if (!HTTPS.test(attr('src') ?? '')) drop('src');
        el.setAttribute('loading', 'lazy');
        el.setAttribute('decoding', 'async');
        el.setAttribute('referrerpolicy', 'no-referrer');
        break;
      case 'ol':
        if (attr('start') !== null && !isNumber(attr('start'), 100000)) drop('start');
        if (attr('type') !== null && !['1', 'a', 'A', 'i', 'I'].includes(attr('type')!)) drop('type');
        break;
      case 'th':
      case 'td':
        for (const n of ['colspan', 'rowspan']) if (attr(n) !== null && !isNumber(attr(n), 50)) drop(n);
        break;
      case 'input':
        // Task-list checkboxes only, and never clickable.
        if ((attr('type') ?? '').toLowerCase() !== 'checkbox') {
          el.remove();
          continue;
        }
        el.setAttribute('disabled', '');
        break;
      case 'source':
        // Only inside <picture>, only for dark/light variants, one https image each.
        if (el.parentElement?.tagName !== 'PICTURE' || !DARK_LIGHT.has((attr('media') ?? '').trim().toLowerCase()) || !HTTPS.test((attr('srcset') ?? '').trim())) {
          el.remove();
          continue;
        }
        el.setAttribute('media', attr('media')!.trim().toLowerCase());
        break;
      case 'picture':
        for (const child of [...el.children]) if (child.tagName !== 'SOURCE' && child.tagName !== 'IMG') child.remove();
        break;
      case 'video':
      case 'audio': {
        if (!HTTPS.test(attr('src') ?? '')) {
          el.remove();
          continue;
        }
        if (attr('poster') !== null && !HTTPS.test(attr('poster')!)) drop('poster');
        el.replaceChildren();
        el.setAttribute('controls', '');
        el.setAttribute('preload', 'none');
        if (tag === 'video') el.setAttribute('playsinline', '');
        break;
      }
      case 'iframe': {
        const embed = youtubeEmbed(attr('src'), doc);
        if (embed) el.replaceWith(embed);
        else el.remove();
        continue;
      }
      case 'progress':
      case 'meter':
        for (const n of ['value', 'min', 'max']) if (attr(n) !== null && !isNumber(attr(n), 1_000_000)) drop(n);
        el.replaceChildren();
        break;
    }
  }
}

export function renderMarkdown(source: string, blocked: BlockedLinks | null = null): string {
  const html = marked.parse(source.slice(0, 60_000)) as string;
  const fragment = DOMPurify.sanitize(html, PURIFY);
  enforce(fragment, blocked);
  const box = document.createElement('div');
  box.appendChild(document.importNode(fragment, true));
  return box.innerHTML;
}
