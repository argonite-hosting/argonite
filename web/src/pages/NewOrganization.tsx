import { useState } from 'preact/hooks';
import { slugify, validateName, validateSlug } from '../../../shared/validate';
import { Icon } from '../components/Icon';
import { RequireAuth } from '../components/RequireAuth';
import { Alert, Field, Spinner } from '../components/ui';
import { SITE } from '../config';
import { ApiError, api } from '../lib/api';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link, navigate } from '../lib/router';

function Inner() {
  useHead(t('New organisation'), undefined, 'noindex');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [summary, setSummary] = useState('');
  const [github, setGithub] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const n = validateName(name);
    if (n) errs.name = n;
    const s = validateSlug(slug);
    if (s) errs.slug = s;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ slug: string }>('POST', '/api/organizations', { name: name.trim(), slug, summary: summary.trim(), githubLogin: github.trim() || null });
      navigate(`/organization/${r.slug}?tab=manage`);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setError(err.message);
      } else setError(t('Could not create the organisation.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="container page page-narrow">
      <Link href="/dashboard?tab=organizations" class="back-link">
        <Icon name="chevronLeft" /> {t('Dashboard')}
      </Link>
      <div class="page-head">
        <div>
          <h1>{t('New organisation')}</h1>
          <p class="page-sub">{t('Share projects with a team. Members get the permissions you choose for every project the organisation owns.')}</p>
        </div>
      </div>
      <form class="card card-pad stack" onSubmit={submit} noValidate>
        <Field label={t('Name')} error={errors.name}>
          {(id, d) => (
            <input
              id={id}
              class="input"
              maxLength={64}
              value={name}
              aria-describedby={d}
              onInput={(e) => {
                setName(e.currentTarget.value);
                if (!slugTouched) setSlug(slugify(e.currentTarget.value));
              }}
            />
          )}
        </Field>
        <Field label="URL" error={errors.slug}>
          {(id, d) => (
            <div class="input-group">
              <span class="input-prefix">{SITE.domain}/organization/</span>
              <input
                id={id}
                class="input"
                maxLength={48}
                value={slug}
                aria-describedby={d}
                onInput={(e) => {
                  setSlugTouched(true);
                  setSlug(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                }}
              />
            </div>
          )}
        </Field>
        <Field label={t('Summary')} optional>
          {(id) => <textarea id={id} class="textarea" rows={2} maxLength={200} value={summary} onInput={(e) => setSummary(e.currentTarget.value)} />}
        </Field>
        <Field label={t('GitHub organisation')} optional hint={t('Uses its avatar. You must be an admin of it on GitHub.')}>
          {(id, d) => <input id={id} class="input" maxLength={39} value={github} aria-describedby={d} onInput={(e) => setGithub(e.currentTarget.value)} />}
        </Field>
        {error && <Alert kind="danger">{error}</Alert>}
        <div class="form-foot">
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy && <Spinner />} {t('Create organisation')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NewOrganization() {
  return <RequireAuth>{() => <Inner />}</RequireAuth>;
}
