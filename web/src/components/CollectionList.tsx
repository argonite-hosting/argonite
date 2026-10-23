import type { CollectionSummary } from '../../../shared/types';
import { t, tn } from '../lib/i18n';
import { Link } from '../lib/router';
import { Icon } from './Icon';
import { Empty } from './ui';

export function CollectionList({ list, empty }: { list: CollectionSummary[]; empty: string }) {
  if (!list.length)
    return (
      <div class="card">
        <Empty icon="folder" title={empty} />
      </div>
    );
  return (
    <ul class="collection-grid">
      {list.map((c) => (
        <li key={c.id}>
          <Link href={`/collection/${c.id}`} class="card card-body collection-card">
            <Icon name="folder" />
            <span>
              <strong>{c.name}</strong>
              <span class="muted">
                {tn(c.itemCount, '{n} project', '{n} projects')} · {c.visibility === 'private' ? t('Private') : c.visibility === 'unlisted' ? t('Unlisted') : t('Public')}
              </span>
              {c.summary && <span class="collection-summary">{c.summary}</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
