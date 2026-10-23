import site from '../config/site.json';

const origin = `https://${site.domain}`;

export const SITE = {
  name: site.name,
  domain: site.domain,
  url: origin,
  apiUrl: `https://${site.apiSubdomain}.${site.domain}`,
  tagline: site.tagline,
  description: site.description,
  email: (kind: keyof typeof site.emails) => `${site.emails[kind]}@${site.domain}`,
  github: site.github,
  turnstileSiteKey: site.turnstileSiteKey,
  scanPublicKey: site.scanPublicKey,
  limits: {
    fileMaxBytes: site.limits.fileMaxMB * 1024 * 1024,
    iconMaxBytes: site.limits.iconMaxKB * 1024,
    galleryMaxBytes: site.limits.galleryMaxKB * 1024,
    galleryMaxImages: site.limits.galleryMaxImages,
    descriptionMaxChars: site.limits.descriptionMaxChars,
    changelogMaxChars: site.limits.changelogMaxChars,
  },
  review: site.review,
} as const;

export type SiteConfig = typeof SITE;
