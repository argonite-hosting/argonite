import { useEffect } from 'preact/hooks';
import { SITE } from '../config';

function setMeta(selector: string, attr: string, value: string): void {
  const el = document.head.querySelector<HTMLMetaElement | HTMLLinkElement>(selector);
  if (el) el.setAttribute(attr, value);
}

// The server adds page-specific extras (structured data, preview image) for the URL that was loaded.
// Once the app navigates somewhere else they no longer apply.
const firstPath = typeof window === 'undefined' ? '' : window.location.pathname;

function dropServerExtras(): void {
  if (window.location.pathname === firstPath) return;
  for (const el of document.head.querySelectorAll('[data-page]')) el.remove();
  setMeta('meta[property="og:image"]', 'content', `${SITE.url}/og.png`);
}

export function useHead(title: string | null, description?: string, robots?: 'noindex'): void {
  useEffect(() => {
    if (title === null) return;
    const full = title ? `${title} · ${SITE.name}` : `${SITE.name} · ${SITE.tagline}`;
    document.title = full;
    dropServerExtras();
    setMeta('meta[property="og:title"]', 'content', title || SITE.name);
    const desc = description ?? SITE.description;
    setMeta('meta[name="description"]', 'content', desc);
    setMeta('meta[property="og:description"]', 'content', desc);
    const url = SITE.url + window.location.pathname;
    setMeta('link[rel="canonical"]', 'href', url);
    setMeta('meta[property="og:url"]', 'content', url);
    let tag = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (robots) {
      if (!tag) {
        tag = document.createElement('meta');
        tag.name = 'robots';
        document.head.appendChild(tag);
      }
      tag.content = robots;
    } else {
      tag?.remove();
    }
  }, [title, description, robots]);
}
