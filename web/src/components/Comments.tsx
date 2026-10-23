// Project comments. Pages are fetched straight from the project's GitHub repository and only shown if
// their SHA-256 matches what the API recorded when it committed them.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { bytesToHex } from '../../../shared/signing';
import type { Comment, CommentPageFile, CommentPageRef } from '../../../shared/types';
import { api, ApiError, loginUrl, pub } from '../lib/api';
import { ago, date } from '../lib/format';
import { t } from '../lib/i18n';
import { Link, useLocation } from '../lib/router';
import { errorToast, isStaff, toast, useSession } from '../lib/store';
import { Icon } from './Icon';
import { ReportDialog } from './ReportDialog';
import { Alert, Avatar, Empty, Menu, Modal, Spinner } from './ui';
import { safeHref, useBlockedLinks } from '../lib/blockedLinks';

const MAX = 2000;
const EDIT_WINDOW_MS = 24 * 3600 * 1000;

interface Listing {
  mode: 'open' | 'members' | 'off';
  total: number;
  pages: CommentPageRef[];
}

async function loadPage(ref: CommentPageRef, projectId: string): Promise<Comment[] | 'tampered'> {
  if (ref.pending.length || !ref.url || !ref.sha256) return ref.pending;
  const res = await fetch(ref.url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error(t('Could not load comments from GitHub.'));
  const buf = new Uint8Array(await res.arrayBuffer());
  const hash = bytesToHex(await crypto.subtle.digest('SHA-256', buf));
  if (hash !== ref.sha256) return 'tampered';
  const file = JSON.parse(new TextDecoder().decode(buf)) as CommentPageFile;
  if (file.v !== 1 || file.project !== projectId || file.page !== ref.page) return 'tampered';
  return file.comments;
}

// Plain text with https links made clickable. Nothing is ever parsed as HTML.
function Body({ text }: { text: string }) {
  const blocked = useBlockedLinks();
  const parts = text.split(/(https:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g);
  return (
    <p class="comment-text">
      {parts.map((p, i) =>
        i % 2 === 1 && safeHref(p, blocked) ? (
          <a key={i} href={p} target="_blank" rel="nofollow ugc noopener noreferrer">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </p>
  );
}

function Composer({ placeholder, onSubmit, onCancel, initial = '', autoFocus }: { placeholder: string; onSubmit: (text: string) => Promise<void>; onCancel?: () => void; initial?: string; autoFocus?: boolean }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(text.trim());
      setText('');
    } catch (err) {
      errorToast(err, t('Could not post your comment'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="comment-composer" onSubmit={submit}>
      <textarea
        class="textarea"
        rows={3}
        maxLength={MAX}
        placeholder={placeholder}
        value={text}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
        }}
      />
      <div class="comment-composer-foot">
        <span class={`field-hint${text.length > MAX - 100 ? ' text-warning' : ''}`}>{t('{used} / {max}', { used: text.length, max: MAX })}</span>
        <div class="row-actions">
          {onCancel && (
            <button type="button" class="btn btn-sm" onClick={onCancel}>
              {t('Cancel')}
            </button>
          )}
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
            {busy ? <Spinner /> : <Icon name="message" />}
            {initial ? t('Save') : t('Post')}
          </button>
        </div>
      </div>
    </form>
  );
}

export function Comments({ projectId, projectName, canModerate, isMember }: { projectId: string; projectName: string; canModerate: boolean; isMember: boolean }) {
  const { user } = useSession();
  const loc = useLocation();
  const [listing, setListing] = useState<Listing | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loadedPages, setLoadedPages] = useState(0);
  const [tampered, setTampered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [reporting, setReporting] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState<Comment | null>(null);

  const loadMore = async (l: Listing, from: number, existing: Comment[]) => {
    setBusy(true);
    try {
      const batch = l.pages.slice(from, from + 2);
      const results = await Promise.all(batch.map((p) => loadPage(p, projectId)));
      let next = existing;
      for (const r of results) {
        if (r === 'tampered') setTampered(true);
        else next = [...next, ...r];
      }
      setComments(next);
      setLoadedPages(from + batch.length);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setError(null);
    setTampered(false);
    try {
      const l = await pub<Listing>(`/v1/projects/${projectId}/comments`);
      setListing(l);
      await loadMore(l, 0, []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Could not load comments.'));
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [projectId]);

  useEffect(() => {
    if (!loc.hash.startsWith('#comment-') || busy) return;
    document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [busy, loc.hash]);

  const threads = useMemo(() => {
    const byParent = new Map<string, Comment[]>();
    const roots: Comment[] = [];
    for (const c of comments) {
      if (c.parent) byParent.set(c.parent, [...(byParent.get(c.parent) ?? []), c]);
      else roots.push(c);
    }
    roots.sort((a, b) => b.createdAt - a.createdAt);
    for (const list of byParent.values()) list.sort((a, b) => a.createdAt - b.createdAt);
    return { roots, byParent };
  }, [comments]);

  const post = async (text: string, parent: string | null) => {
    const r = await api<{ comment: Comment }>('POST', `/api/projects/${projectId}/comments`, { body: text, parent });
    setComments((list) => [...list, r.comment]);
    setListing((l) => (l ? { ...l, total: l.total + 1 } : l));
    setReplyTo(null);
  };

  const edit = async (c: Comment, text: string) => {
    await api('PATCH', `/api/comments/${c.id}`, { body: text });
    setComments((list) => list.map((x) => (x.id === c.id ? { ...x, body: text, editedAt: Date.now() } : x)));
    setEditing(null);
  };

  const remove = async (c: Comment) => {
    setDeleting(null);
    try {
      await api('DELETE', `/api/comments/${c.id}`);
      setComments((list) => list.map((x) => (x.id === c.id ? { ...x, body: '', deleted: true } : x)));
      toast('success', t('Comment deleted'));
    } catch (e) {
      errorToast(e);
    }
  };

  const mode = listing?.mode ?? 'open';
  const canPost = !!user && !user.banned && (mode === 'open' || (mode === 'members' && isMember));

  const renderComment = (c: Comment, reply: boolean) => {
    const own = user?.id === c.author.id;
    const canEdit = own && !c.deleted && Date.now() - c.createdAt < EDIT_WINDOW_MS;
    const canDelete = !c.deleted && (own || canModerate || isStaff(user));
    const replies = reply ? [] : (threads.byParent.get(c.id) ?? []);
    if (c.deleted && !replies.length) return null;
    return (
      <li key={c.id} id={`comment-${c.id}`} class={`comment${reply ? ' comment-reply' : ''}`}>
        <div class="comment-main">
          {c.deleted ? (
            <span class="avatar avatar-sm avatar-fallback" aria-hidden="true">
              ?
            </span>
          ) : (
            <Avatar src={`https://github.com/${encodeURIComponent(c.author.username)}.png?size=64`} name={c.author.username} size="sm" />
          )}
          <div class="comment-content">
            <div class="comment-head">
              {c.deleted ? (
                <span class="muted">{t('Deleted comment')}</span>
              ) : (
                <Link href={`/user/${encodeURIComponent(c.author.username)}`} class="comment-author">
                  {c.author.username}
                </Link>
              )}
              <time dateTime={new Date(c.createdAt).toISOString()} title={date(c.createdAt)} class="muted">
                {ago(c.createdAt)}
              </time>
              {c.editedAt && !c.deleted && <span class="muted">· {t('edited')}</span>}
              {!c.deleted && user && (
                <span class="comment-menu">
                  <Menu label={t('Comment actions')} trigger={<Icon name="list" />} triggerClass="btn btn-ghost btn-sm btn-icon">
                    {(close) => (
                      <>
                        {canEdit && (
                          <button type="button" class="menu-item" onClick={() => (close(), setEditing(c.id))}>
                            <Icon name="edit" /> {t('Edit')}
                          </button>
                        )}
                        {canDelete && (
                          <button type="button" class="menu-item danger" onClick={() => (close(), setDeleting(c))}>
                            <Icon name="trash" /> {t('Delete')}
                          </button>
                        )}
                        {!own && (
                          <button type="button" class="menu-item" onClick={() => (close(), setReporting(c))}>
                            <Icon name="flag" /> {t('Report')}
                          </button>
                        )}
                      </>
                    )}
                  </Menu>
                </span>
              )}
            </div>
            {editing === c.id ? (
              <Composer placeholder={t('Edit your comment')} initial={c.body} onSubmit={(text) => edit(c, text)} onCancel={() => setEditing(null)} autoFocus />
            ) : (
              !c.deleted && <Body text={c.body} />
            )}
            {!reply && !c.deleted && canPost && replyTo !== c.id && (
              <button type="button" class="btn btn-ghost btn-sm comment-reply-btn" onClick={() => setReplyTo(c.id)}>
                <Icon name="message" /> {t('Reply')}
              </button>
            )}
          </div>
        </div>
        {(replies.length > 0 || replyTo === c.id) && (
          <ul class="comment-replies">
            {replies.map((r) => renderComment(r, true))}
            {replyTo === c.id && (
              <li class="comment comment-reply">
                <Composer placeholder={t('Write a reply')} onSubmit={(text) => post(text, c.id)} onCancel={() => setReplyTo(null)} autoFocus />
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section class="card card-pad comments" aria-labelledby="comments-title">
      <div class="comments-head">
        <h2 id="comments-title" class="section-title">
          {t('Comments')}
          {listing && listing.total > 0 && <span class="count">{listing.total}</span>}
        </h2>
        <span class="field-hint comments-note">
          <Icon name="shieldCheck" /> {t('Stored in the project’s GitHub repository and checked before display')}
        </span>
      </div>

      {mode === 'off' ? (
        <p class="muted">{t('Comments are turned off for this project.')}</p>
      ) : canPost ? (
        <Composer placeholder={t('Share feedback, ask a question or help someone out')} onSubmit={(text) => post(text, null)} />
      ) : !user ? (
        <p class="muted">
          <a href={loginUrl(loc.path + '#comments')}>{t('Sign in')}</a> {t('to join the conversation.')}
        </p>
      ) : mode === 'members' ? (
        <p class="muted">{t('Only project members can comment here.')}</p>
      ) : null}

      {tampered && (
        <Alert kind="danger" title={t('Some comments were hidden.')}>
          {t('A comment page on GitHub no longer matches its recorded fingerprint, so it was not shown.')}
        </Alert>
      )}
      {error && <Alert kind="warning">{error}</Alert>}

      {busy && !comments.length ? (
        <div class="page-loading">
          <Spinner />
        </div>
      ) : threads.roots.length ? (
        <ul class="comment-list">{threads.roots.map((c) => renderComment(c, false))}</ul>
      ) : (
        !error && mode !== 'off' && <Empty icon="message" title={t('No comments yet')} />
      )}

      {listing && loadedPages < listing.pages.length && (
        <button type="button" class="btn btn-block" disabled={busy} onClick={() => loadMore(listing, loadedPages, comments)}>
          {busy ? <Spinner /> : null}
          {t('Load older comments')}
        </button>
      )}
      {deleting && (
        <Modal
          title={t('Delete this comment?')}
          description={t('The text is removed from the page and from the data branch history.')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setDeleting(null)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-danger" onClick={() => remove(deleting)}>
                {t('Delete')}
              </button>
            </>
          }
        >
          <p class="comment-text muted">{deleting.body}</p>
        </Modal>
      )}
      {reporting && <ReportDialog targetType="comment" targetId={reporting.id} label={t('Comment by {name} on {project}', { name: reporting.author.username, project: projectName })} onClose={() => setReporting(null)} />}
    </section>
  );
}
