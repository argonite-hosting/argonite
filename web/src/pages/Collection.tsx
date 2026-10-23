import { useState } from 'preact/hooks';
import type { CollectionDetail } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { ProjectCard } from '../components/ProjectCard';
import { ReportDialog } from '../components/ReportDialog';
import { Alert, Avatar, Empty, Field, Menu, Modal, PageLoading, Spinner, useAsync } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { ago } from '../lib/format';
import { useHead } from '../lib/head';
import { t, tn } from '../lib/i18n';
import { Link, navigate } from '../lib/router';
import { errorToast, toast, useSession } from '../lib/store';
import { Select } from '../components/Select';

export default function CollectionPage({ params }: { params: Record<string, string> }) {
  const { user, ready } = useSession();
  // Owners can see their private collections, so this goes through the signed-in API when possible.
  const { data, error, loading, reload } = useAsync(
    () => (ready ? api<CollectionDetail>('GET', `/api/collections/${encodeURIComponent(params.id)}`) : new Promise<CollectionDetail>(() => undefined)),
    [params.id, ready],
  );
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [visibility, setVisibility] = useState<CollectionDetail['visibility']>('private');
  const [busy, setBusy] = useState(false);
  useHead(data ? data.name : null, data?.summary || (data ? t('A collection of {n} Minecraft projects', { n: data.itemCount }) : undefined), data?.visibility !== 'public' ? 'noindex' : undefined);

  if (loading && !data) return <PageLoading />;
  if (error || !data) {
    return (
      <div class="container page">
        <Empty icon="folder" title={error instanceof ApiError && error.status === 404 ? t('Collection not found') : t('Could not load this collection')}>
          <p>{error instanceof ApiError && error.status !== 404 ? error.message : t('It may be private or deleted.')}</p>
        </Empty>
      </div>
    );
  }
  const own = user?.id === data.owner.id;
  const startEdit = () => {
    setName(data.name);
    setSummary(data.summary);
    setVisibility(data.visibility);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('PATCH', `/api/collections/${data.id}`, { name, summary, visibility });
      toast('success', t('Collection saved'));
      setEditing(false);
      reload();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const removeItem = async (projectId: string) => {
    try {
      await api('PATCH', `/api/collections/${data.id}`, { remove: projectId });
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  const del = async () => {
    try {
      await api('DELETE', `/api/collections/${data.id}`);
      toast('success', t('Collection deleted'));
      navigate('/dashboard?tab=collections');
    } catch (e) {
      errorToast(e);
    }
  };

  return (
    <div class="container page">
      <header class="page-head">
        <div class="settings-title">
          <span class="collection-icon">
            <Icon name="folder" />
          </span>
          <div>
            <h1>{data.name}</h1>
            <p class="page-sub">
              <Link href={`/user/${data.owner.username}`} class="inline-user">
                <Avatar src={data.owner.avatarUrl} name={data.owner.username} size="sm" /> {data.owner.username}
              </Link>{' '}
              · {tn(data.itemCount, '{n} project', '{n} projects')} · {t('updated {when}', { when: ago(data.updatedAt) })} ·{' '}
              {data.visibility === 'private' ? t('Private') : data.visibility === 'unlisted' ? t('Unlisted') : t('Public')}
            </p>
          </div>
        </div>
        <div class="row-actions">
          {own && (
            <button type="button" class="btn" onClick={startEdit}>
              <Icon name="edit" /> {t('Edit')}
            </button>
          )}
          <Menu label={t('More actions')} trigger={<Icon name="list" />}>
            {(close) => (
              <>
                {data.source && (
                  <a class="menu-item" href={data.source.url} target="_blank" rel="noopener noreferrer" onClick={close}>
                    <Icon name="github" /> {t('Stored file on GitHub')}
                  </a>
                )}
                {own && (
                  <button type="button" class="menu-item danger" onClick={() => (close(), setDeleting(true))}>
                    <Icon name="trash" /> {t('Delete collection')}
                  </button>
                )}
                {user && !own && (
                  <button type="button" class="menu-item" onClick={() => (close(), setReporting(true))}>
                    <Icon name="flag" /> {t('Report collection')}
                  </button>
                )}
              </>
            )}
          </Menu>
        </div>
      </header>
      {data.summary && <p class="collection-lede">{data.summary}</p>}
      {data.source && (
        <p class="field-hint">
          <Icon name="shieldCheck" /> {t('Loaded from GitHub and matched against its recorded fingerprint.')}
        </p>
      )}
      {data.projects.length ? (
        <div class="result-list">
          {data.projects.map((p) => (
            <div key={p.id} class="collection-item">
              <ProjectCard p={p} showType />
              {own && (
                <button type="button" class="btn btn-ghost btn-sm btn-icon collection-remove" aria-label={t('Remove {name}', { name: p.name })} onClick={() => removeItem(p.id)}>
                  <Icon name="x" />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="folder" title={t('This collection is empty')}>
          {own && <p>{t('Use “Save” on any project page to add it here.')}</p>}
        </Empty>
      )}
      {data.items && data.items.length > data.projects.length && <Alert kind="info">{t('Some projects in this collection are no longer available.')}</Alert>}
      {editing && (
        <Modal
          title={t('Edit collection')}
          onClose={() => setEditing(false)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setEditing(false)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-primary" disabled={busy || name.trim().length < 2} onClick={save}>
                {busy && <Spinner />} {t('Save')}
              </button>
            </>
          }
        >
          <Field label={t('Name')}>{(id) => <input id={id} class="input" maxLength={64} value={name} onInput={(e) => setName(e.currentTarget.value)} />}</Field>
          <Field label={t('Description')} optional>
            {(id) => <textarea id={id} class="textarea" rows={3} maxLength={200} value={summary} onInput={(e) => setSummary(e.currentTarget.value)} />}
          </Field>
          <Field label={t('Visibility')} hint={t('Public collections are stored in the site’s public GitHub data repository, where anyone can read them. Unlisted and private ones never leave our database.')}>
            {(id, d) => (
              <Select id={id} class="select" value={visibility} aria-describedby={d} onChange={(v) => setVisibility(v as typeof visibility)}>
                <option value="public">{t('Public · on your profile')}</option>
                <option value="unlisted">{t('Unlisted · only people with the link')}</option>
                <option value="private">{t('Private · only you')}</option>
              </Select>
            )}
          </Field>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={t('Delete this collection?')}
          description={t('The projects themselves aren’t affected.')}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setDeleting(false)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-danger" onClick={del}>
                {t('Delete')}
              </button>
            </>
          }
        >
          <span />
        </Modal>
      )}
      {reporting && <ReportDialog targetType="collection" targetId={data.id} label={data.name} onClose={() => setReporting(false)} />}
    </div>
  );
}
