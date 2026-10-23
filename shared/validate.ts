const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
const INVISIBLE = /[­᠎​-‍⁠﻿]/g;

export const RESERVED_SLUGS = new Set([
  'new', 'create', 'edit', 'settings', 'upload', 'admin', 'api', 'auth', 'login', 'logout', 'dashboard', 'moderation',
  'browse', 'search', 'project', 'projects', 'user', 'users', 'mods', 'plugins', 'resourcepacks', 'shaders', 'datapacks',
  'modpacks', 'legal', 'about', 'help', 'support', 'security', 'argonite', 'official', 'staff', 'null', 'undefined',
]);

export function cleanText(input: string): string {
  return input.normalize('NFC').replace(BIDI, '').replace(INVISIBLE, '').trim();
}

export function hasControlChars(input: string): boolean {
  return CONTROL.test(input);
}

// Multi-line fields can keep newlines and tabs, nothing else from the control range.
export function cleanMultiline(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(BIDI, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

export function validateSlug(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/.test(slug)) return 'Use 3-48 lowercase letters, numbers or dashes, starting and ending with a letter or number.';
  if (slug.includes('--')) return 'Avoid double dashes.';
  if (/^[0-9a-z]{26}$/.test(slug)) return 'That URL looks like an internal ID. Add a dash or change its length.';
  if (RESERVED_SLUGS.has(slug)) return 'That URL is reserved.';
  return null;
}

export function slugify(input: string): string {
  return cleanText(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

export function validateName(name: string): string | null {
  if (hasControlChars(name)) return 'Name contains invalid characters.';
  const n = cleanText(name);
  if (n.length < 2 || n.length > 64) return 'Name must be 2-64 characters.';
  return null;
}

export function validateSummary(summary: string): string | null {
  if (hasControlChars(summary)) return 'Summary contains invalid characters.';
  const s = cleanText(summary);
  if (s.length < 10 || s.length > 200) return 'Summary must be 10-200 characters.';
  return null;
}

export function validateVersionNumber(v: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(v)) return 'Use letters, numbers, dots, dashes, underscores or plus signs (max 64).';
  if (v.includes('..') || v.endsWith('.') || v.toLowerCase().endsWith('.lock')) return 'That version number cannot be used as a release tag.';
  return null;
}

export function releaseTag(versionNumber: string): string {
  return /^v\d/i.test(versionNumber) ? versionNumber : `v${versionNumber}`;
}

export function validateHttpsUrl(url: string): string | null {
  if (!url) return null;
  if (url.length > 400) return 'Link is too long.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter a full link starting with https://';
  }
  if (parsed.protocol !== 'https:') return 'Links must use https://';
  if (parsed.username || parsed.password) return 'Links cannot contain credentials.';
  if (!parsed.hostname.includes('.')) return 'Enter a valid domain.';
  return null;
}

export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

// GitHub rewrites odd characters in asset names, so we keep to a set it leaves alone.
export function sanitizeFilename(input: string, allowedExtensions: string[]): string | null {
  const base = cleanText(input.split(/[\\/]/).pop() ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const ext = fileExtension(base);
  if (!allowedExtensions.includes(ext)) return null;
  let stem = base.slice(0, base.length - ext.length).replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/-{2,}/g, '-');
  stem = stem.replace(/^[.\-_]+|[.\-_]+$/g, '').slice(0, 120 - ext.length);
  if (!stem) return null;
  return stem + ext;
}

export function validateGameVersion(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,39}$/.test(v);
}

export function validateUsername(u: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(u);
}

export function isId(id: string): boolean {
  return /^[0-9a-z]{26}$/.test(id);
}
