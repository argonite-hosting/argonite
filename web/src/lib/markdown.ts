import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({ gfm: true, breaks: false, async: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow ugc');
    }
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    if (!/^https:\/\//i.test(src)) node.removeAttribute('src');
    node.setAttribute('loading', 'lazy');
    node.setAttribute('decoding', 'async');
    node.setAttribute('referrerpolicy', 'no-referrer');
  }
});

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'video', 'audio', 'source', 'base', 'link', 'meta'],
  FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset', 'formaction', 'action', 'background', 'ping'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/(?![/\\]))/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

export function renderMarkdown(source: string): string {
  const html = marked.parse(source.slice(0, 60_000)) as string;
  return DOMPurify.sanitize(html, PURIFY) as unknown as string;
}
