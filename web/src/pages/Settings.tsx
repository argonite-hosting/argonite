import { useState } from 'preact/hooks';
import { SCOPE, SCOPE_LABELS, has, type ScopeName } from '../../../shared/permissions';
import type { ApiTokenInfo, Me } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { RequireAuth } from '../components/RequireAuth';
import { Alert, Avatar, CopyField, Empty, Field, Modal, PageLoading, Spinner, Tabs, useAsync } from '../components/ui';
import { SITE } from '../config';
import { api, pub } from '../lib/api';
import { ago, date } from '../lib/format';
import { useHead } from '../lib/head';
import { LOCALES, setLocale, t, useLocale } from '../lib/i18n';
import { Link, navigate, setQuery, useLocation } from '../lib/router';
import { errorToast, refreshSession, toast } from '../lib/store';
import { Select } from '../components/Select';

type TabId = 'profile' | 'tokens' | 'notifications' | 'account';

function Profile({ user }: { user: Me }) {
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [bio, setBio] = useState(user.bio ?? '');
  const [busy, setBusy] = useState(false);
  const current = useAsync(() => pub<{ links: { label: string; url: string }[] }>(`/v1/users/${encodeURIComponent(user.username)}`), [user.username]);
  const [links, setLinks] = useState<{ label: string; url: string }[] | null>(null);
  const list = links ?? current.data?.links ?? [];
  const [linkBusy, setLinkBusy] = useState(false);

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('PATCH', '/api/me', { displayName: displayName.trim() || null, bio: bio.trim() || null });
      await refreshSession();
      toast('success', t('Profile saved'));
    } catch (err) {
      errorToast(err, t('Could not save'));
    } finally {
      setBusy(false);
    }
  };
  const saveLinks = async () => {
    setLinkBusy(true);
    try {
      await api('PUT', '/api/me/profile', { links: list.filter((l) => l.label.trim() || l.url.trim()) });
      toast('success', t('Links saved'), t('They’re stored in the {site} data repository on GitHub.', { site: SITE.name }));
    } catch (err) {
      errorToast(err, t('Could not save'));
    } finally {
      setLinkBusy(false);
    }
  };
  const update = (i: number, patch: Partial<{ label: string; url: string }>) => setLinks(list.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div class="stack-lg">
      <form class="card card-pad stack" onSubmit={save}>
        <div class="media-row">
          <Avatar src={user.avatarUrl} name={user.username} size="lg" />
          <div class="stack-sm">
            <h2 class="form-section-title">{t('Profile')}</h2>
            <p class="muted">{t('Your avatar and username come from GitHub and update each time you sign in.')}</p>
          </div>
        </div>
        <Field label={t('Display name')} optional>
          {(id) => <input id={id} class="input" value={displayName} maxLength={64} placeholder={user.username} onInput={(e) => setDisplayName(e.currentTarget.value)} />}
        </Field>
        <Field label={t('Bio')} optional hint={`${bio.length}/300`}>
          {(id, d) => <textarea id={id} class="textarea" rows={3} maxLength={300} value={bio} aria-describedby={d} onInput={(e) => setBio(e.currentTarget.value)} />}
        </Field>
        <div class="form-foot">
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy && <Spinner />} {t('Save profile')}
          </button>
        </div>
      </form>

      <section class="card card-pad stack">
        <h2 class="form-section-title">{t('Links')}</h2>
        <p class="muted">{t('Up to 6 links shown on your profile, like your website, Discord or YouTube.')}</p>
        {current.loading && !links ? (
          <Spinner />
        ) : (
          <>
            {list.map((l, i) => (
              <div key={i} class="form-row form-row-end">
                <Field label={t('Label')}>{(id) => <input id={id} class="input" maxLength={32} value={l.label} onInput={(e) => update(i, { label: e.currentTarget.value })} />}</Field>
                <Field label="URL">{(id) => <input id={id} class="input" type="url" placeholder="https://" value={l.url} onInput={(e) => update(i, { url: e.currentTarget.value.trim() })} />}</Field>
                <button type="button" class="btn btn-ghost btn-icon" aria-label={t('Remove link')} onClick={() => setLinks(list.filter((_, j) => j !== i))}>
                  <Icon name="trash" />
                </button>
              </div>
            ))}
            <div class="row-actions">
              {list.length < 6 && (
                <button type="button" class="btn" onClick={() => setLinks([...list, { label: '', url: '' }])}>
                  <Icon name="plus" /> {t('Add link')}
                </button>
              )}
              <button type="button" class="btn btn-primary" disabled={linkBusy || links === null} onClick={saveLinks}>
                {linkBusy && <Spinner />} {t('Save links')}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Tokens() {
  const { data, loading, reload } = useAsync(() => api<{ tokens: ApiTokenInfo[] }>('GET', '/api/me/tokens'), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<number>(SCOPE.VERSIONS_WRITE);
  const [days, setDays] = useState(90);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ token: string }>('POST', '/api/me/tokens', { name: name.trim(), scopes, expiresInDays: days || undefined });
      setFresh(r.token);
      setCreating(false);
      setName('');
      reload();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await api('DELETE', `/api/me/tokens/${id}`);
      toast('success', t('Token deleted'));
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="stack">
      <Alert kind="info">
        {t('Tokens let CI and scripts publish versions for you. Send one as “Authorization: Bearer …”. They never work for account settings, and each one only does what its scopes allow.')}{' '}
        <Link href="/api-docs#publishing">{t('API guide')}</Link>
      </Alert>
      {fresh && (
        <Alert kind="success" title={t('Copy your token now.')}>
          {t('It won’t be shown again.')}
          <CopyField value={fresh} label={t('Token')} />
        </Alert>
      )}
      {loading ? (
        <PageLoading />
      ) : data?.tokens.length ? (
        <ul class="manage-list card">
          {data.tokens.map((tk) => (
            <li key={tk.id} class="manage-row">
              <div class="manage-row-main">
                <div class="manage-row-title">
                  <Icon name="key" />
                  <strong>{tk.name}</strong>
                  <span class="mono muted">{tk.prefix}…</span>
                </div>
                <span class="field-hint">
                  {(Object.keys(SCOPE) as ScopeName[])
                    .filter((s) => has(tk.scopes, SCOPE[s]))
                    .map((s) => t(SCOPE_LABELS[s]))
                    .join(' · ')}
                </span>
                <span class="field-hint">
                  {t('Created {date}', { date: date(tk.createdAt) })} · {tk.lastUsedAt ? t('last used {when}', { when: ago(tk.lastUsedAt) }) : t('never used')}
                  {tk.expiresAt && ` · ${tk.expiresAt < Date.now() ? t('expired') : t('expires {date}', { date: date(tk.expiresAt) })}`}
                </span>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => remove(tk.id)}>
                {t('Delete')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div class="card">
          <Empty icon="key" title={t('No API tokens')} />
        </div>
      )}
      <div>
        <button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> {t('New token')}
        </button>
      </div>
      {creating && (
        <Modal
          title={t('New API token')}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setCreating(false)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-primary" disabled={busy || name.trim().length < 2 || !scopes} onClick={create}>
                {busy && <Spinner />} {t('Create token')}
              </button>
            </>
          }
        >
          <Field label={t('Name')} hint={t('Something you’ll recognise, like “GitHub Actions”.')}>
            {(id, d) => <input id={id} class="input" maxLength={64} value={name} aria-describedby={d} onInput={(e) => setName(e.currentTarget.value)} />}
          </Field>
          <div class="field">
            <span class="field-label">{t('Scopes')}</span>
            {(Object.keys(SCOPE) as ScopeName[]).map((s) => (
              <label key={s} class="check">
                <input type="checkbox" checked={has(scopes, SCOPE[s])} onChange={(e) => setScopes(e.currentTarget.checked ? scopes | SCOPE[s] : scopes & ~SCOPE[s])} />
                <span>{t(SCOPE_LABELS[s])}</span>
              </label>
            ))}
          </div>
          <Field label={t('Expires')}>
            {(id) => (
              <Select id={id} class="select" value={days} onChange={(v) => setDays(Number(v))}>
                <option value={30}>{t('{n} days', { n: 30 })}</option>
                <option value={90}>{t('{n} days', { n: 90 })}</option>
                <option value={365}>{t('1 year')}</option>
                <option value={0}>{t('Never')}</option>
              </Select>
            )}
          </Field>
        </Modal>
      )}
    </div>
  );
}

function Notifications() {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rotate = async () => {
    setBusy(true);
    try {
      setUrl((await api<{ url: string }>('POST', '/api/me/feed')).url);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    try {
      await api('DELETE', '/api/me/feed');
      setUrl(null);
      toast('success', t('Feed link turned off'));
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="stack">
      <section class="card card-pad stack">
        <h2 class="form-section-title">{t('On the site')}</h2>
        <p class="muted">{t('The bell in the header shows new versions of projects you follow, replies, invites, comments on your projects and updates on your uploads.')}</p>
        <Link href="/notifications" class="btn">
          <Icon name="bell" /> {t('All notifications')}
        </Link>
      </section>
      <section class="card card-pad stack">
        <h2 class="form-section-title">{t('RSS feed of everything you follow')}</h2>
        <p class="muted">{t('A private feed link for your reader. Anyone with the link can see what you follow, so treat it like a password. Making a new one turns the old one off.')}</p>
        {url && <CopyField value={url} label={t('Feed link')} />}
        <div class="row-actions">
          <button type="button" class="btn btn-primary" disabled={busy} onClick={rotate}>
            {busy && <Spinner />} {url ? t('Make a new link') : t('Create feed link')}
          </button>
          <button type="button" class="btn btn-ghost" onClick={revoke}>
            {t('Turn off')}
          </button>
        </div>
      </section>
    </div>
  );
}

function Account({ user }: { user: Me }) {
  const lang = useLocale();
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState('');
  const signOutEverywhere = async () => {
    try {
      await api('POST', '/api/me/sessions/revoke');
      await refreshSession();
      toast('success', t('Signed out everywhere'));
      navigate('/');
    } catch (e) {
      errorToast(e);
    }
  };
  const deleteAccount = async () => {
    try {
      await api('DELETE', '/api/me', { confirm });
      await refreshSession();
      toast('success', t('Account deleted'));
      navigate('/');
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="stack-lg">
      <section class="card card-pad stack">
        <h2 class="form-section-title">{t('Language')}</h2>
        <Select class="select" value={lang} aria-label={t('Language')} onChange={(v) => void setLocale(v)}>
          {LOCALES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <p class="field-hint">{t('Project descriptions and comments stay in the language their authors wrote them in.')}</p>
      </section>
      <section class="card card-pad stack">
        <h2 class="form-section-title">{t('GitHub access')}</h2>
        <p class="muted">{t('{site} uses a GitHub app that can only touch repositories you grant it. You can change which repositories it sees, or remove it, at any time.', { site: SITE.name })}</p>
        <div class="row-actions">
          <a class="btn" href={`https://github.com/apps/${SITE.github.appSlug}/installations/new`} target="_blank" rel="noopener noreferrer">
            <Icon name="github" /> {t('Manage repository access')}
          </a>
          <a class="btn btn-ghost" href="https://github.com/settings/apps/authorizations" target="_blank" rel="noopener noreferrer">
            {t('Revoke authorization')} <Icon name="external" />
          </a>
        </div>
      </section>
      <section class="card card-pad stack">
        <h2 class="form-section-title">{t('Sessions')}</h2>
        <p class="muted">{t('Sign out of {site} on every device, including this one.', { site: SITE.name })}</p>
        <div>
          <button type="button" class="btn" onClick={signOutEverywhere}>
            <Icon name="logOut" /> {t('Sign out everywhere')}
          </button>
        </div>
      </section>
      <section class="card card-pad stack danger-zone">
        <h2 class="form-section-title">{t('Delete account')}</h2>
        <p class="muted">{t('Removes your profile, collections, tokens, follows and sessions, and your projects’ listings. Your GitHub repositories and releases are not touched.')}</p>
        {user.banned && <Alert kind="warning">{t('Your account is suspended. You can still delete it.')}</Alert>}
        <div>
          <button type="button" class="btn btn-danger" onClick={() => setDeleting(true)}>
            {t('Delete account')}
          </button>
        </div>
      </section>
      {deleting && (
        <Modal
          title={t('Delete your account?')}
          description={t('This can’t be undone. Type {name} to confirm.', { name: user.username })}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setDeleting(false)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-danger" disabled={confirm.toLowerCase() !== user.username.toLowerCase()} onClick={deleteAccount}>
                {t('Delete account')}
              </button>
            </>
          }
        >
          <input class="input" value={confirm} aria-label={t('Confirm username')} onInput={(e) => setConfirm(e.currentTarget.value)} />
        </Modal>
      )}
    </div>
  );
}

function Inner({ user }: { user: Me }) {
  useHead(t('Settings'), undefined, 'noindex');
  const loc = useLocation();
  const tabs: [TabId, string][] = [
    ['profile', t('Profile')],
    ['tokens', t('API tokens')],
    ['notifications', t('Notifications')],
    ['account', t('Account')],
  ];
  const wanted = loc.query.get('tab') as TabId | null;
  const tab: TabId = tabs.find(([id]) => id === wanted)?.[0] ?? 'profile';
  return (
    <div class="container page page-narrow">
      <div class="page-head">
        <div>
          <h1>{t('Settings')}</h1>
          <p class="page-sub">{t('Manage your profile and account.')}</p>
        </div>
      </div>
      <Tabs current={tab} items={tabs.map(([id, label]) => ({ id, label, onClick: () => setQuery({ tab: id === 'profile' ? null : id }) }))} />
      <div class="settings-body">
        {tab === 'profile' && <Profile user={user} />}
        {tab === 'tokens' && <Tokens />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'account' && <Account user={user} />}
      </div>
    </div>
  );
}

export default function Settings() {
  return <RequireAuth>{(user) => <Inner user={user} />}</RequireAuth>;
}
