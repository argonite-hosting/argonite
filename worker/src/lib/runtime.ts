import { SITE } from '../../../shared/config';

export function siteUrl(): string {
  return SITE.url;
}

export function apiUrl(): string {
  return SITE.apiUrl;
}

export function scanKey(): string {
  return SITE.scanPublicKey;
}

export function githubApi(): string {
  return 'https://api.github.com';
}

export function githubUploads(): string {
  return 'https://uploads.github.com/';
}

export function rawBase(): string {
  return 'https://raw.githubusercontent.com';
}

export function githubAppId(): number {
  return SITE.github.appId;
}
