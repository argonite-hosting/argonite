// "Save to collection": a small menu of the viewer's collections with a quick way to make a new one.
import { useState } from 'preact/hooks';
import type { CollectionSummary } from '../../../shared/types';
import { api, loginUrl } from '../lib/api';
import { t, tn } from '../lib/i18n';
import { useLocation } from '../lib/router';
import { errorToast, toast, useSession } from '../lib/store';
import { Icon } from './Icon';
import { Field, Modal, Spinner } from './ui';

interface Mine {
  collections: CollectionSummary[];
  contains: Record<string, boolean>;
}

export function AddToCollection({ projectId }: { projectId: string }) {
  const { user } = useSession();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<Mine | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'unlisted' | 'private'>('private');

  if (!user) {
    return (
      <a class="btn" href={loginUrl(loc.path)}>
        <Icon name="plus" /> {t('Save')}
      </a>
    );
  }

  const load = async () => {
    setOpen(true);
    try {
      setMine(await api<Mine>('GET', `/api/me/collections?project=${projectId}`));
    } catch (e) {
      errorToast(e);
      setOpen(false);
    }
  };

  const toggle = async (c: CollectionSummary) => {
    const has = !!mine?.contains[c.id];
    setBusy(c.id);
    try {
      await api('PATCH', `/api/collections/${c.id}`, has ? { remove: projectId } : { add: projectId });
      setMine((m) => (m ? { ...m, contains: { ...m.contains, [c.id]: !has } } : m));
      toast('success', has ? t('Removed from {name}', { name: c.name }) : t('Saved to {name}', { name: c.name }), undefined, 2500);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };

  const create = async (e: Event) => {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setBusy('new');
    try {
      const r = await api<{ id: string }>('POST', '/api/collections', { name: name.trim(), visibility });
      await api('PATCH', `/api/collections/${r.id}`, { add: projectId });
      setName('');
      setMine(await api<Mine>('GET', `/api/me/collections?project=${projectId}`));
      toast('success', t('Saved to {name}', { name: name.trim() }), undefined, 2500);
    } catch (err) {
      errorToast(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" class="btn" onClick={load} aria-haspopup="dialog">
        <Icon name="plus" /> {t('Save')}
      </button>
      {open && (
        <Modal title={t('Save to a collection')} onClose={() => setOpen(false)}>
          {!mine ? (
            <div class="page-loading">
              <Spinner />
            </div>
          ) : (
            <div class="stack">
              {mine.collections.length > 0 && (
                <ul class="collection-pick">
                  {mine.collections.map((c) => (
                    <li key={c.id}>
                      <label class="check">
                        <input type="checkbox" checked={!!mine.contains[c.id]} disabled={busy === c.id} onChange={() => toggle(c)} />
                        <span>
                          {c.name}
                          <span class="field-hint">
                            {c.visibility === 'private' ? t('Private') : c.visibility === 'unlisted' ? t('Unlisted') : t('Public')} · {tn(c.itemCount, '{n} project', '{n} projects')}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <form class="stack-sm" onSubmit={create}>
                <Field label={t('New collection')}>
                  {(id) => <input id={id} class="input" maxLength={64} value={name} placeholder={t('e.g. Performance mods')} onInput={(e) => setName(e.currentTarget.value)} />}
                </Field>
                <div class="row-actions">
                  <select class="select" value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as typeof visibility)} aria-label={t('Visibility')}>
                    <option value="private">{t('Private')}</option>
                    <option value="unlisted">{t('Unlisted')}</option>
                    <option value="public">{t('Public')}</option>
                  </select>
                  <button type="submit" class="btn btn-primary" disabled={busy === 'new' || name.trim().length < 2}>
                    {busy === 'new' ? <Spinner /> : <Icon name="plus" />}
                    {t('Create and save')}
                  </button>
                </div>
              </form>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
