import { useEffect, useRef, useState } from 'preact/hooks';
import { LICENSES, PROJECT_TYPES, categoriesFor, type ProjectType } from '../../../shared/taxonomy';
import type { InstallationInfo } from '../../../shared/types';
import { slugify, validateName, validateSlug, validateSummary } from '../../../shared/validate';
import { Icon } from '../components/Icon';
import { RequireAuth } from '../components/RequireAuth';
import { Turnstile, type TurnstileHandle } from '../components/Turnstile';
import { Alert, Field, Spinner, useAsync } from '../components/ui';
import { SITE } from '../config';
import { ApiError, api } from '../lib/api';
import { useHead } from '../lib/head';
import { navigate } from '../lib/router';
import { TYPE_BLURB, TYPE_ICON } from '../lib/typeIcons';
import { t } from '../lib/i18n';
import { Select } from '../components/Select';

function RepoPicker({ info, mode, setMode, repoId, setRepoId, repoName, setRepoName, error }: {
  info: InstallationInfo;
  mode: 'create' | 'existing';
  setMode: (m: 'create' | 'existing') => void;
  repoId: number | null;
  setRepoId: (id: number | null) => void;
  repoName: string;
  setRepoName: (n: string) => void;
  error?: string;
}) {
  const publicRepos = info.repos.filter((r) => !r.private);
  return (
    <div class="stack">
      <div class="segmented" role="group" aria-label={t('Repository')}>
        <button type="button" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>
          {t('Create a new repository')}
        </button>
        <button type="button" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>
          {t('Use an existing one')}
        </button>
      </div>
      {mode === 'create' ? (
        <>
          {!info.canCreate && (
            <Alert kind="warning" title={t('Limited access.')}>
              {t('The {site} app only has access to selected repositories, so it may not be able to create one.', { site: SITE.name })}{' '}
              <a href={info.installUrl} target="_blank" rel="noopener noreferrer">
                {t('Give it access to all repositories')}
              </a>{' '}
              {t('or create the repository on GitHub yourself (with a README so it has a first commit) and pick it here.')}
            </Alert>
          )}
          <Field label={t('Repository name')} hint={t('A new public repository on your GitHub account. Releases for each version go here.')} error={error}>
            {(id, d) => (
              <input
                id={id}
                class="input"
                value={repoName}
                maxLength={100}
                aria-describedby={d}
                aria-invalid={!!error}
                onInput={(e) => setRepoName(e.currentTarget.value.replace(/[^A-Za-z0-9._-]/g, '-'))}
              />
            )}
          </Field>
        </>
      ) : publicRepos.length ? (
        <Field label={t('Repository')} hint={t('Only public repositories the app can access are listed.')} error={error}>
          {(id, d) => (
            <Select id={id} class="select" value={repoId ?? ''} aria-describedby={d} onChange={(v) => setRepoId(v ? Number(v) : null)}>
              <option value="">{t('Choose a repository')}</option>
              {publicRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <Alert kind="info">
          {t('No public repositories are available to the app yet.')}{' '}
          <a href={info.installUrl} target="_blank" rel="noopener noreferrer">
            {t('Grant access to one on GitHub')}
          </a>
          {t(', then reload this page.')}
        </Alert>
      )}
    </div>
  );
}

function Form() {
  useHead(t('New project'), undefined, 'noindex');
  const gh = useAsync(() => api<InstallationInfo>('GET', '/api/me/github'), []);
  const [type, setType] = useState<ProjectType>('mod');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [summary, setSummary] = useState('');
  const [license, setLicense] = useState('MIT');
  const [categories, setCategories] = useState<string[]>([]);
  const [mode, setMode] = useState<'create' | 'existing'>('create');
  const [repoId, setRepoId] = useState<number | null>(null);
  const [repoName, setRepoName] = useState('');
  const [repoTouched, setRepoTouched] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
    if (!repoTouched) setRepoName(slugify(name) || '');
  }, [name]);
  useEffect(() => setCategories((c) => c.filter((id) => categoriesFor(type).some((x) => x.id === id))), [type]);

  const validate = () => {
    const e: Record<string, string> = {};
    const n = validateName(name);
    if (n) e.name = t(n);
    const s = validateSlug(slug);
    if (s) e.slug = t(s);
    const m = validateSummary(summary);
    if (m) e.summary = t(m);
    if (mode === 'existing' && !repoId) e.repo = t('Choose a repository.');
    if (mode === 'create' && !/^[A-Za-z0-9._-]{1,100}$/.test(repoName)) e.repoName = t('Enter a repository name.');
    setErrors(e);
    return !Object.keys(e).length;
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const res = await api<{ id: string; slug: string }>('POST', '/api/projects', {
        name,
        slug,
        summary,
        type,
        license,
        categories,
        repo: mode === 'create' ? { mode, name: repoName } : { mode, id: repoId },
        turnstileToken: token,
      });
      navigate(`/project/${res.slug}/upload?new=1`);
    } catch (err) {
      turnstile.current?.reset();
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setFormError(err.message);
      } else setFormError(t('Could not create the project.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="container page page-narrow">
      <div class="page-head">
        <div>
          <h1>{t('New project')}</h1>
          <p class="page-sub">{t('Your files live in a GitHub repository you own. {site} stores the details and the verified fingerprints.', { site: SITE.name })}</p>
        </div>
      </div>
      {gh.loading ? (
        <div class="page-loading">
          <Spinner />
        </div>
      ) : gh.error ? (
        <Alert kind="danger" title={t('Could not reach GitHub.')}>
          {gh.error.message}
        </Alert>
      ) : !gh.data!.installed ? (
        <section class="card card-pad install-card">
          <span class="install-icon">
            <Icon name="github" />
          </span>
          <h2>{t('Install the {site} GitHub app', { site: SITE.name })}</h2>
          <p>{t('The app creates releases in the repositories you choose. It can’t see anything else, and you can remove it at any time.')}</p>
          <div class="row-actions">
            <a class="btn btn-primary" href={gh.data!.installUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="github" /> {t('Install on GitHub')}
            </a>
            <button type="button" class="btn" onClick={gh.reload}>
              <Icon name="refresh" /> {t('I’ve installed it')}
            </button>
          </div>
        </section>
      ) : (
        <form class="stack-lg" onSubmit={submit} noValidate>
          <section class="card card-pad stack">
            <h2 class="form-section-title">{t('What are you publishing?')}</h2>
            <div class="type-picker">
              {PROJECT_TYPES.map((pt) => (
                <button key={pt.id} type="button" class="type-option" aria-pressed={type === pt.id} onClick={() => setType(pt.id)}>
                  <Icon name={TYPE_ICON[pt.id]} />
                  <span>
                    <strong>{t(pt.label)}</strong>
                    <span>{t(TYPE_BLURB[pt.id])}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section class="card card-pad stack">
            <h2 class="form-section-title">{t('Basics')}</h2>
            <Field label={t('Name')} error={errors.name}>
              {(id, d) => <input id={id} class="input" value={name} maxLength={64} aria-describedby={d} aria-invalid={!!errors.name} onInput={(e) => setName(e.currentTarget.value)} />}
            </Field>
            <Field label="URL" hint={t('Lowercase letters, numbers and dashes.')} error={errors.slug}>
              {(id, d) => (
                <div class="input-group">
                  <span class="input-prefix">{SITE.domain}/project/</span>
                  <input
                    id={id}
                    class="input"
                    value={slug}
                    maxLength={48}
                    aria-describedby={d}
                    aria-invalid={!!errors.slug}
                    onInput={(e) => {
                      setSlugTouched(true);
                      setSlug(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                    }}
                  />
                </div>
              )}
            </Field>
            <Field label={t('Summary')} hint={`${summary.length}/200 · ${t('shown in search results.')}`} error={errors.summary}>
              {(id, d) => <textarea id={id} class="textarea" rows={2} maxLength={200} value={summary} aria-describedby={d} aria-invalid={!!errors.summary} onInput={(e) => setSummary(e.currentTarget.value)} />}
            </Field>
            <div class="form-row">
              <Field label={t('License')}>
                {(id) => (
                  <Select id={id} class="select" value={license} onChange={(v) => setLicense(v)}>
                    {LICENSES.map((l) => (
                      <option key={l.id} value={l.id}>
                        {t(l.label)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div class="field">
              <span class="field-label">
                {t('Categories')} <span class="optional">{t('Up to 5')}</span>
              </span>
              <div class="chips">
                {categoriesFor(type).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    class="chip"
                    aria-pressed={categories.includes(c.id)}
                    disabled={!categories.includes(c.id) && categories.length >= 5}
                    onClick={() => setCategories((cur) => (cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]))}
                  >
                    {t(c.label)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section class="card card-pad stack">
            <h2 class="form-section-title">{t('Where your files live')}</h2>
            <RepoPicker
              info={gh.data!}
              mode={mode}
              setMode={setMode}
              repoId={repoId}
              setRepoId={setRepoId}
              repoName={repoName}
              setRepoName={(n) => {
                setRepoTouched(true);
                setRepoName(n);
              }}
              error={errors.repo ?? errors.repoName}
            />
          </section>

          {formError && <Alert kind="danger">{formError}</Alert>}
          <div class="form-foot">
            <Turnstile onToken={setToken} handle={turnstile} />
            <button type="submit" class="btn btn-primary btn-lg" disabled={busy || !token}>
              {busy ? <Spinner /> : <Icon name="plus" />}
              {t('Create project')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function NewProject() {
  return <RequireAuth>{() => <Form />}</RequireAuth>;
}
