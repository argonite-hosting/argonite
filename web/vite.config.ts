import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import site from '../config/site.json';

const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const siteUrl = `https://${site.domain}`;
const apiUrl = `https://${site.apiSubdomain}.${site.domain}`;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function csp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src 'self' ${apiUrl} https://raw.githubusercontent.com https://challenges.cloudflare.com`,
    'frame-src https://challenges.cloudflare.com',
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

// Cloudflare serves these with every static response. Hashed assets never change, so they cache forever.
function headersFile(): string {
  return [
    '/*',
    `  Content-Security-Policy: ${csp()}`,
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
}

function siteHtml(): Plugin {
  let isBuild = false;
  let outDir = '';
  return {
    name: 'argonite-site',
    configResolved(config) {
      isBuild = config.command === 'build';
      outDir = config.build.outDir;
    },
    transformIndexHtml(html) {
      return html
        .replaceAll('%SITE_NAME%', escape(site.name))
        .replaceAll('%SITE_TAGLINE%', escape(site.tagline))
        .replaceAll('%SITE_DESCRIPTION%', escape(site.description))
        .replaceAll('%SITE_URL%', siteUrl);
    },
    closeBundle() {
      if (!isBuild) return;
      writeFileSync(resolve(outDir, '_headers'), headersFile());
      const robots = [
        'User-agent: *',
        'Allow: /',
        'Disallow: /dashboard',
        'Disallow: /settings',
        'Disallow: /moderation',
        'Disallow: /new',
        'Disallow: /auth/',
        'Disallow: /project/*/settings',
        'Disallow: /project/*/upload',
        '',
        `Sitemap: ${siteUrl}/sitemap.xml`,
        '',
      ];
      writeFileSync(resolve(outDir, 'robots.txt'), robots.join('\n'));
      const manifest = {
        name: site.name,
        short_name: site.name,
        description: site.description,
        start_url: '/',
        display: 'standalone',
        background_color: '#f6f8fc',
        theme_color: '#2563eb',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      };
      writeFileSync(resolve(outDir, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

export default defineConfig({
  plugins: [siteHtml()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    target: 'baseline-widely-available',
    assetsInlineLimit: 0,
    sourcemap: false,
    cssCodeSplit: true,
  },
});
