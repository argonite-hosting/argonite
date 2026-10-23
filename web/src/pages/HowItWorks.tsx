import { Icon, type IconName } from '../components/Icon';
import { SITE } from '../config';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link } from '../lib/router';

function flow(): { icon: IconName; title: string; body: string }[] {
  return [
    {
      icon: 'upload',
      title: t('1. The author uploads'),
      body: t('The files go into a draft release in the author’s own GitHub repository. {site} never stores them, and nobody can download a draft.', { site: SITE.name }),
    },
    {
      icon: 'shield',
      title: t('2. We scan the exact bytes'),
      body: t(
        'Every file is fetched through a short-lived private link and scanned for malware, including every jar packed inside it. When something looks off, moderators can also try a mod, plugin or modpack out in an isolated environment. Resource packs, data packs and shaders are rejected outright if they contain any code.',
      ),
    },
    {
      icon: 'layers',
      title: t('3. Modpacks are checked file by file'),
      body: t('Every mod a modpack downloads is fetched from its listed host, matched against the pack’s hashes and scanned too. Files already published here are recognised by their fingerprint.'),
    },
    {
      icon: 'fingerprint',
      title: t('4. The fingerprint is signed'),
      body: t('If a file passes, the scanner computes SHA-1, SHA-256 and SHA-512 and signs them, together with the project, release and asset ids, using an Ed25519 key that only the scanner holds.'),
    },
    {
      icon: 'eye',
      title: t('5. Humans look at anything unusual'),
      body: t('First uploads from new accounts, files that suddenly start running programs or loading code, and anything the scanner flags wait for a moderator. Only then is the GitHub release published.'),
    },
    {
      icon: 'shieldCheck',
      title: t('6. Your browser verifies the download'),
      body: t('Before saving, your browser checks the signature with our public key, downloads the file from GitHub, and recomputes both fingerprints. If anything differs, the download is blocked and flagged.'),
    },
  ];
}

export default function HowItWorks() {
  useHead(t('How verification works'), t('How {site} scans, signs and verifies every Minecraft file.', { site: SITE.name }));
  return (
    <div class="container page page-narrow">
      <div class="page-head">
        <div>
          <h1>{t('How verification works')}</h1>
          <p class="page-sub">{t('Files stay on the author’s GitHub. Trust comes from checks you can see.')}</p>
        </div>
      </div>
      <ol class="flow-list">
        {flow().map((s) => (
          <li key={s.title} class="flow-item">
            <span class="step-icon">
              <Icon name={s.icon} />
            </span>
            <div>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <section class="card card-pad prose section">
        <h2>{t('What this protects against')}</h2>
        <ul>
          <li>
            <strong>{t('Grabbing a file before it’s checked.')}</strong> {t('Releases stay drafts on GitHub until the scan and any review pass.')}
          </li>
          <li>
            <strong>{t('Swapped files.')}</strong> {t('If someone replaces a release asset on GitHub, its fingerprint no longer matches and the download is blocked.')}
          </li>
          <li>
            <strong>{t('Tampered records.')}</strong> {t('Fingerprints are signed by the scanner, so even someone with access to our database can’t forge a valid one. Comments and collections stored on GitHub are only shown if they still match the hash we recorded.')}
          </li>
          <li>
            <strong>{t('Known malware.')}</strong> {t('Our checks catch known malware and common tricks.')}
          </li>
          <li>
            <strong>{t('Bad files found later.')}</strong> {t('Moderators can revoke a version and every download stops immediately, including in launchers that use our API.')}
          </li>
        </ul>
        <h2>{t('What it can’t promise')}</h2>
        <p>
          {t('Scanning lowers risk but can’t prove a file is safe; brand-new malware can slip past any scanner. Files downloaded directly from GitHub, outside {site}, skip the browser check. Report anything suspicious from the project page and we’ll look at it quickly.', { site: SITE.name })}
        </p>
        <h2>{t('For launcher developers')}</h2>
        <p>
          {t('Every version in the')} <Link href="/api-docs">{t('public API')}</Link> {t('includes its hashes and signature. Verify the signature against our published key, then check the downloaded bytes before installing.')}
        </p>
      </section>
    </div>
  );
}
