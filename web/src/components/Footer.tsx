import { SITE } from '../config';
import { LOCALES, setLocale, t, useLocale } from '../lib/i18n';
import { Link } from '../lib/router';
import { Icon } from './Icon';
import { LogoMark } from './Logo';

export function Footer() {
  const lang = useLocale();
  const links: [string, string][] = [
    ['/how-it-works', t('How verification works')],
    ['/api-docs', 'API'],
    ['/servers', t('Servers')],
    ['/legal/rules', t('Content rules')],
    ['/legal/terms', t('Terms')],
    ['/legal/privacy', t('Privacy')],
    ['/legal/dmca', 'DMCA'],
    ['/legal/security', t('Security')],
  ];
  return (
    <footer class="site-footer">
      <div class="container footer-row">
        <span class="footer-mark">
          <LogoMark size={18} />
          <span>
            {SITE.name.toLowerCase()} <span class="footer-dim">· {t('every download checked against a signed fingerprint')}</span>
          </span>
        </span>
        <nav class="footer-links" aria-label={t('Footer')}>
          {links.map(([href, label]) => (
            <Link key={href} href={href}>
              {label}
            </Link>
          ))}
          <a href={`https://github.com/${SITE.github.sourceRepo}`} target="_blank" rel="noopener noreferrer">
            <Icon name="github" /> {t('Source')}
          </a>
        </nav>
      </div>
      <div class="container footer-legal">
        <span>
          © {new Date().getFullYear()} {SITE.name} · v{__APP_VERSION__}. {t('Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.')}
        </span>
        <label class="footer-lang">
          <Icon name="globe" />
          <span class="sr-only">{t('Language')}</span>
          <select class="select select-sm" value={lang} onChange={(e) => void setLocale(e.currentTarget.value)}>
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </footer>
  );
}
