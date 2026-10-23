import { useState } from 'preact/hooks';
import { SERVER_REGIONS, SERVER_TAGS } from '../../../shared/taxonomy';
import type { ProjectSummary, ServerListing } from '../../../shared/types';
import { slugify, validateHttpsUrl, validateName, validateSlug, validateSummary } from '../../../shared/validate';
import { Icon } from '../components/Icon';
import { MarkdownEditor } from '../components/Markdown';
import { RequireAuth } from '../components/RequireAuth';
import { Alert, Field, Modal, PageLoading, Spinner, useAsync } from '../components/ui';
import { SITE } from '../config';
import { ApiError, api, pub } from '../lib/api';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link, navigate } from '../lib/router';
import { errorToast, toast } from '../lib/store';

function Form({ existing }: { existing: ServerListing | null }) {
  useHead(existing ? t('Edit {name}', { name: existing.name }) : t('List a server'), undefined, 'noindex');
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!existing);
  const [summary, setSummary] = useState(existing?.summary ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [edition, setEdition] = useState<'java' | 'bedrock'>(existing?.edition ?? 'java');
  const [host, setHost] = useState(existing ? existing.address.replace(/:\d+$/, '') : '');
  const [port, setPort] = useState(existing && /:\d+$/.test(existing.address) ? existing.address.split(':').pop()! : '');
  const [region, setRegion] = useState(existing?.region ?? 'global');
  const [tags, setTags] = useState<string[]>(existing?.tags ?? []);
  const [website, setWebsite] = useState(existing?.links.website ?? '');
  const [discord, setDiscord] = useState(existing?.links.discord ?? '');
  const [modpackQuery, setModpackQuery] = useState('');
  const [modpack, setModpack] = useState<ProjectSummary | null>(existing?.modpack ?? null);
  const [results, setResults] = useState<ProjectSummary[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const searchPacks = async (q: string) => {
    setModpackQuery(q);
    if (q.trim().length < 2) return setResults([]);
    try {
      const r = await pub<{ hits: ProjectSummary[] }>(`/v1/search?type=modpack&limit=6&q=${encodeURIComponent(q.trim())}`);
      setResults(r.hits);
    } catch {
      setResults([]);
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const checks: [string, string | null][] = [
      ['name', validateName(name)],
      ['slug', validateSlug(slug)],
      ['summary', validateSummary(summary)],
      ['websiteUrl', validateHttpsUrl(website)],
      ['discordUrl', validateHttpsUrl(discord)],
    ];
    for (const [k, v] of checks) if (v) errs[k] = v;
    if (!host.trim()) errs.host = t('Enter the server address.');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      slug,
      summary: summary.trim(),
      description,
      edition,
      host: host.trim(),
      ...(port ? { port: Number(port) } : {}),
      region,
      tags,
      modpackId: modpack?.id ?? null,
      websiteUrl: website || null,
      discordUrl: discord || null,
    };
    try {
      if (existing) {
        await api('PATCH', `/api/servers/${existing.slug}`, body);
        toast('success', t('Server saved'));
        navigate(`/server/${slug}`);
      } else {
        const r = await api<{ slug: string }>('POST', '/api/servers', body);
        navigate(`/server/${r.slug}`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setError(err.message);
      } else setError(t('Could not save the server.'));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    try {
      await api('DELETE', `/api/servers/${existing!.slug}`);
      toast('success', t('Server removed'));
      navigate('/dashboard?tab=servers');
    } catch (e) {
      errorToast(e);
    }
  };

  return (
    <div class="container page page-narrow">
      <Link href={existing ? `/server/${existing.slug}` : '/servers'} class="back-link">
        <Icon name="chevronLeft" /> {existing ? existing.name : t('Servers')}
      </Link>
      <div class="page-head">
        <div>
          <h1>{existing ? t('Edit server') : t('List your server')}</h1>
          <p class="page-sub">{t('We check Java servers every few minutes with the same status request the multiplayer screen sends. Nothing else is ever sent.')}</p>
        </div>
      </div>
      <form class="stack-lg" onSubmit={submit} noValidate>
        <section class="card card-pad stack">
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
                <span class="input-prefix">{SITE.domain}/server/</span>
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
          <Field label={t('Summary')} hint={`${summary.length}/200`} error={errors.summary}>
            {(id, d) => <textarea id={id} class="textarea" rows={2} maxLength={200} value={summary} aria-describedby={d} onInput={(e) => setSummary(e.currentTarget.value)} />}
          </Field>
        </section>
        <section class="card card-pad stack">
          <h2 class="form-section-title">{t('Connection')}</h2>
          <div class="segmented" role="group" aria-label={t('Edition')}>
            <button type="button" aria-pressed={edition === 'java'} onClick={() => setEdition('java')}>
              Java
            </button>
            <button type="button" aria-pressed={edition === 'bedrock'} onClick={() => setEdition('bedrock')}>
              Bedrock
            </button>
          </div>
          <div class="form-row">
            <Field label={t('Address')} error={errors.host} hint={t('A hostname like play.example.com, or a public IPv4 address.')}>
              {(id, d) => <input id={id} class="input mono-ish" maxLength={253} value={host} aria-describedby={d} placeholder="play.example.com" onInput={(e) => setHost(e.currentTarget.value.trim())} />}
            </Field>
            <Field label={t('Port')} optional error={errors.port}>
              {(id, d) => (
                <input id={id} class="input mono-ish" inputMode="numeric" maxLength={5} value={port} aria-describedby={d} placeholder={edition === 'java' ? '25565' : '19132'} onInput={(e) => setPort(e.currentTarget.value.replace(/\D/g, ''))} />
              )}
            </Field>
          </div>
          {edition === 'bedrock' && <Alert kind="info">{t('Bedrock servers are listed without a live status, because their status check uses UDP.')}</Alert>}
          <Field label={t('Region')}>
            {(id) => (
              <select id={id} class="select" value={region} onChange={(e) => setRegion(e.currentTarget.value)}>
                {SERVER_REGIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {t(r.label)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div class="field">
            <span class="field-label">
              {t('Tags')} <span class="optional">{t('Up to 5')}</span>
            </span>
            <div class="chips">
              {SERVER_TAGS.map((tg) => (
                <button
                  key={tg.id}
                  type="button"
                  class="chip"
                  aria-pressed={tags.includes(tg.id)}
                  disabled={!tags.includes(tg.id) && tags.length >= 5}
                  onClick={() => setTags((cur) => (cur.includes(tg.id) ? cur.filter((x) => x !== tg.id) : [...cur, tg.id]))}
                >
                  {t(tg.label)}
                </button>
              ))}
            </div>
          </div>
        </section>
        <section class="card card-pad stack">
          <h2 class="form-section-title">{t('Modpack')}</h2>
          {modpack ? (
            <div class="row-actions">
              <span>
                <strong>{modpack.name}</strong>
              </span>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setModpack(null)}>
                {t('Remove')}
              </button>
            </div>
          ) : (
            <>
              <input class="input" type="search" value={modpackQuery} placeholder={t('Search published modpacks')} aria-label={t('Search published modpacks')} onInput={(e) => searchPacks(e.currentTarget.value)} />
              {results.length > 0 && (
                <ul class="pick-list">
                  {results.map((r) => (
                    <li key={r.id}>
                      <button type="button" class="menu-item" onClick={() => (setModpack(r), setResults([]), setModpackQuery(''))}>
                        {r.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
        <section class="card card-pad stack">
          <Field label={t('Description')} optional>
            {(id, d) => <MarkdownEditor id={id} describedBy={d} value={description} onInput={setDescription} maxLength={10_000} rows={10} />}
          </Field>
          <div class="form-row">
            <Field label={t('Website')} optional error={errors.websiteUrl}>
              {(id, d) => <input id={id} class="input" type="url" placeholder="https://" value={website} aria-describedby={d} onInput={(e) => setWebsite(e.currentTarget.value.trim())} />}
            </Field>
            <Field label={t('Discord invite')} optional error={errors.discordUrl}>
              {(id, d) => <input id={id} class="input" type="url" placeholder="https://" value={discord} aria-describedby={d} onInput={(e) => setDiscord(e.currentTarget.value.trim())} />}
            </Field>
          </div>
        </section>
        {error && <Alert kind="danger">{error}</Alert>}
        <div class="form-foot">
          {existing && (
            <button type="button" class="btn btn-danger-soft" onClick={() => setDeleting(true)}>
              {t('Remove listing')}
            </button>
          )}
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy && <Spinner />} {existing ? t('Save server') : t('List server')}
          </button>
        </div>
      </form>
      {deleting && (
        <Modal
          title={t('Remove this server listing?')}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setDeleting(false)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-danger" onClick={del}>
                {t('Remove')}
              </button>
            </>
          }
        >
          <span />
        </Modal>
      )}
    </div>
  );
}

function Edit({ slug }: { slug: string }) {
  const { data, loading, error } = useAsync(() => pub<ServerListing>(`/v1/servers/${encodeURIComponent(slug)}`), [slug]);
  if (loading) return <PageLoading />;
  if (error || !data) return <div class="container page">{error?.message}</div>;
  return <Form existing={data} />;
}

export default function ServerForm({ params }: { params: Record<string, string> }) {
  return <RequireAuth>{() => (params.slug ? <Edit slug={params.slug} /> : <Form existing={null} />)}</RequireAuth>;
}
