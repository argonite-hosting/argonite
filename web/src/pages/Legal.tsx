import type { JSX } from 'preact';
import { Empty } from '../components/ui';
import { SITE } from '../config';
import { useHead } from '../lib/head';
import { Link } from '../lib/router';

const UPDATED = 'October 22, 2026';
const mail = (kind: 'support' | 'security' | 'legal') => <a href={`mailto:${SITE.email(kind)}`}>{SITE.email(kind)}</a>;

const PAGES: Record<string, { title: string; body: () => JSX.Element }> = {
  terms: {
    title: 'Terms of Service',
    body: () => (
      <>
        <p>
          These terms cover your use of {SITE.name} ({SITE.domain}). By using the site you agree to them.
        </p>
        <h2>Accounts</h2>
        <p>You sign in with GitHub. You're responsible for what happens under your account and for keeping your GitHub account secure (we strongly recommend two-factor authentication).</p>
        <h2>Your content</h2>
        <p>
          Files you publish stay in GitHub repositories you control. You keep ownership of everything you upload. By publishing, you let {SITE.name} display your project information, scan your files, record their fingerprints and send downloads through to your GitHub releases.
        </p>
        <p>
          You must have the right to distribute what you upload, and it must follow our <Link href="/legal/rules">content rules</Link>.
        </p>
        <h2>Scanning and moderation</h2>
        <p>We scan every upload and may hold, reject, revoke or remove content, or suspend accounts, to protect players. Scanning reduces risk but is not a guarantee; you use downloaded content at your own risk.</p>
        <h2>Availability</h2>
        <p>Files are hosted by authors on GitHub, so a project may become unavailable if its author removes or changes their repository. The service is provided as is, without warranties.</p>
        <h2>Contact</h2>
        <p>Questions about these terms: {mail('legal')}.</p>
      </>
    ),
  },
  privacy: {
    title: 'Privacy Policy',
    body: () => (
      <>
        <h2>What we collect</h2>
        <ul>
          <li>From GitHub when you sign in: your user id, username, display name, avatar URL and account creation date.</li>
          <li>GitHub access tokens for the {SITE.name} app, stored encrypted, used only to create releases and commit project images in repositories you choose.</li>
          <li>What you add: profile bio, projects, versions, follows and reports.</li>
          <li>For download counts: a one-way hash of your IP address with a salt that changes daily. We never store raw IP addresses.</li>
        </ul>
        <h2>What we don't do</h2>
        <p>No advertising, no third-party analytics, no selling data. Cookies are only used to keep you signed in.</p>
        <h2>Services we rely on</h2>
        <p>Cloudflare (hosting, database, bot protection) and GitHub (sign-in and file hosting). Images in project descriptions may load from third-party sites chosen by project authors.</p>
        <h2>Your choices</h2>
        <p>You can edit your profile, sign out everywhere, or delete your account from Settings. Deleting your account removes your profile and listings; audit records of moderation actions are kept without your personal details.</p>
        <p>Privacy questions: {mail('legal')}.</p>
      </>
    ),
  },
  rules: {
    title: 'Content rules',
    body: () => (
      <>
        <p>To keep {SITE.name} safe and useful, projects must follow these rules.</p>
        <ul>
          <li>No malware, spyware, token or credential grabbers, cryptominers, or code that downloads and runs hidden payloads.</li>
          <li>Obfuscation is allowed only when it doesn't hide what the project does. Moderators may ask for source.</li>
          <li>Network access, running programs or loading native code must be relevant to the project and mentioned in the description.</li>
          <li>Only upload content you have the right to distribute. No reuploads of other people's work without permission.</li>
          <li>No impersonating other creators or projects, and no misleading names, descriptions or images.</li>
          <li>No hateful, sexual or otherwise inappropriate content.</li>
          <li>One project per real project. No spam, placeholder or test projects.</li>
        </ul>
        <p>Breaking these rules can get versions revoked, projects removed and accounts suspended.</p>
      </>
    ),
  },
  security: {
    title: 'Security',
    body: () => (
      <>
        <p>
          Found a vulnerability in {SITE.name}, or a malicious file that got through? Email {mail('security')}. Please give us a reasonable chance to fix issues before sharing them publicly. We don't take legal action against good-faith research.
        </p>
        <h2>Reporting a malicious project</h2>
        <p>Use the report button on the project or version page and choose "Malware or suspicious code". Moderators can revoke a version instantly, which blocks every download.</p>
        <h2>How files are protected</h2>
        <p>
          See <Link href="/how-it-works">how verification works</Link> for the full chain: scanning, signed fingerprints and in-browser verification.
        </p>
      </>
    ),
  },
  dmca: {
    title: 'Copyright & DMCA',
    body: () => (
      <>
        <p>
          {SITE.name} doesn't host project files; they live in authors' GitHub repositories. If a project on {SITE.name} infringes your copyright, email {mail('legal')} with:
        </p>
        <ul>
          <li>The project URL on {SITE.domain} and a description of your work.</li>
          <li>Your contact details.</li>
          <li>A statement that you believe in good faith the use isn't authorised, and that your notice is accurate.</li>
          <li>Your physical or electronic signature.</li>
        </ul>
        <p>We'll remove the listing and block downloads while we look into it. Because the files live on GitHub, you may also want to file a notice with GitHub directly.</p>
      </>
    ),
  },
};

export default function Legal({ params }: { params: Record<string, string> }) {
  const page = PAGES[params.page];
  useHead(page ? page.title : 'Not found');
  if (!page) {
    return (
      <div class="container page">
        <Empty icon="search" title="Page not found" />
      </div>
    );
  }
  return (
    <div class="container page page-narrow">
      <div class="page-head">
        <div>
          <h1>{page.title}</h1>
          <p class="page-sub">Last updated {UPDATED}</p>
        </div>
      </div>
      <article class="card card-pad prose">{page.body()}</article>
    </div>
  );
}
