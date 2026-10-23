// Links are checked against malware and phishing lists when they're saved. A site can land on a list
// later, so pages also fetch the current list of blocked sites and URLs and disable matching links.
import { useEffect, useState } from 'preact/hooks';
import { pub } from './api';

export interface BlockedLinks {
  hosts: Set<string>;
  urls: Set<string>;
}

const EMPTY: BlockedLinks = { hosts: new Set(), urls: new Set() };
let pending: Promise<BlockedLinks> | null = null;
let loaded: BlockedLinks | null = null;

export function loadBlockedLinks(): Promise<BlockedLinks> {
  pending ??= pub<{ hosts: string[]; urls: string[] }>('/v1/blocked-links')
    .then((r) => (loaded = { hosts: new Set(r.hosts), urls: new Set(r.urls) }))
    .catch(() => EMPTY);
  return pending;
}

export function isBlocked(href: string | null | undefined, list: BlockedLinks | null = loaded): boolean {
  if (!href || !list) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  url.hash = '';
  if (list.urls.has(url.href)) return true;
  // The site itself or any domain above it.
  const parts = url.hostname.toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < parts.length - 1; i++) if (list.hosts.has(parts.slice(i).join('.'))) return true;
  return false;
}

// The list once it has loaded; null before that.
export function useBlockedLinks(): BlockedLinks | null {
  const [list, setList] = useState<BlockedLinks | null>(loaded);
  useEffect(() => {
    if (!loaded) loadBlockedLinks().then(setList);
  }, []);
  return list;
}

// href to use for a stored link, or null when it has been found to be malicious.
export function safeHref(href: string | null | undefined, list: BlockedLinks | null): string | null {
  return href && !isBlocked(href, list) ? href : null;
}
