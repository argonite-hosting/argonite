import { summarizeGameVersions } from '../../../shared/gameversions';
import { categoryLabel, loaderLabel, typeInfo } from '../../../shared/taxonomy';
import type { ProjectSummary } from '../../../shared/types';
import { ago, count } from '../lib/format';
import { t } from '../lib/i18n';
import { Link } from '../lib/router';
import { Icon } from './Icon';
import { ProjectIcon } from './ui';

function versionSummary(list: string[]): string {
  const releases = list.filter((v) => /^\d+(\.\d+)+$/.test(v));
  return releases.length ? summarizeGameVersions(releases) : list[0] ?? '';
}

export function ProjectCard({ p, showType = false }: { p: ProjectSummary; showType?: boolean }) {
  const versions = versionSummary(p.gameVersions);
  return (
    <article class="project-card">
      <Link href={`/project/${p.slug}`} class="project-card-link" aria-label={p.name} />
      <ProjectIcon src={p.iconUrl} name={p.name} size={56} />
      <div class="project-card-main">
        <div class="project-card-title">
          <h3>{p.name}</h3>
          <span class="project-card-author">
            {t('by')}{' '}
            {p.org ? (
              <Link href={`/organization/${p.org.slug}`} class="project-card-author-link">
                {p.org.name}
              </Link>
            ) : (
              <Link href={`/user/${p.author.username}`} class="project-card-author-link">
                {p.author.username}
              </Link>
            )}
          </span>
        </div>
        <p class="project-card-summary">{p.summary}</p>
        <div class="project-card-tags">
          {showType && <span class="chip chip-type">{t(typeInfo(p.type)?.label ?? '')}</span>}
          {p.archived && <span class="chip chip-muted">{t('Archived')}</span>}
          {p.loaders.slice(0, 3).map((l) => (
            <span key={l} class="chip">
              {loaderLabel(l)}
            </span>
          ))}
          {versions && <span class="chip chip-mono">{versions}</span>}
          {p.categories.slice(0, 2).map((c) => (
            <span key={c} class="chip chip-muted">
              {t(categoryLabel(c))}
            </span>
          ))}
        </div>
      </div>
      <dl class="project-card-stats">
        <div>
          <dt class="sr-only">{t('Downloads')}</dt>
          <dd>
            <Icon name="download" />
            <strong>{count(p.downloads)}</strong>
          </dd>
        </div>
        <div>
          <dt class="sr-only">{t('Followers')}</dt>
          <dd>
            <Icon name="heart" />
            {count(p.follows)}
          </dd>
        </div>
        <div>
          <dt class="sr-only">{t('Updated')}</dt>
          <dd>{ago(p.updatedAt)}</dd>
        </div>
      </dl>
    </article>
  );
}

export function ProjectCardSkeleton() {
  return (
    <div class="project-card" aria-hidden="true">
      <span class="skeleton project-icon sk-icon" />
      <div class="project-card-main">
        <span class="skeleton sk-line sk-w40" />
        <span class="skeleton sk-line sk-w90" />
        <span class="skeleton sk-line sk-w60" />
      </div>
    </div>
  );
}

export function ProjectRow({ p }: { p: ProjectSummary }) {
  return (
    <li class="row-item">
      <Link href={`/project/${p.slug}`} class="row-link">
        <ProjectIcon src={p.iconUrl} name={p.name} size={36} />
        <span class="row-text">
          <strong>{p.name}</strong>
          <span>{p.summary}</span>
        </span>
        <span class="row-meta">
          <span class="row-type">{t(typeInfo(p.type)?.label ?? '')}</span>
          <span class="row-count">
            <Icon name="download" />
            {count(p.downloads)}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function ProjectRowSkeleton() {
  return (
    <li class="row-item" aria-hidden="true">
      <span class="row-link">
        <span class="skeleton project-icon sk-icon-sm" />
        <span class="row-text">
          <span class="skeleton sk-line sk-w40" />
          <span class="skeleton sk-line sk-w90" />
        </span>
      </span>
    </li>
  );
}
