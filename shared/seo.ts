// Page titles, descriptions and structured data shared by the app and the site worker,
// so what search engines see on first load matches what the app shows afterwards.
import { summarizeGameVersions } from './gameversions';
import { loaderLabel, typeInfo } from './taxonomy';
import type { Project, ProjectSummary, UserPublic, Version } from './types';

export type ProjectTab = 'overview' | 'versions' | 'gallery' | 'version' | 'changelog' | 'contents' | 'comments';

export interface PageHead {
  title: string;
  description: string;
  noindex?: boolean;
}

const DESCRIPTION_MAX = 160;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:–-]+$/, '')}…`;
}

export function typeLabel(type: string): string {
  return (typeInfo(type)?.label ?? 'Project').toLowerCase();
}

function loaderList(loaders: string[]): string {
  return loaders
    .filter((l) => l !== 'minecraft' && l !== 'datapack')
    .slice(0, 3)
    .map(loaderLabel)
    .join(', ');
}

// "Fabric, Quilt mod for Minecraft 1.20.1–1.21.4"
export function projectFacts(p: Pick<ProjectSummary, 'type' | 'loaders' | 'gameVersions'>): string {
  const loaders = loaderList(p.loaders);
  const versions = summarizeGameVersions(p.gameVersions);
  return `${loaders ? `${loaders} ` : ''}${typeLabel(p.type)} for Minecraft${versions ? ` ${versions}` : ''}`;
}

export function projectHead(project: Project | ProjectSummary, tab: ProjectTab, version?: Version | null): PageHead {
  const noindex = 'status' in project && project.status !== 'active';
  if (tab === 'version' && version) {
    const loaders = loaderList(version.loaders);
    const versions = summarizeGameVersions(version.gameVersions);
    return {
      title: `${project.name} ${version.versionNumber}`,
      description: clip(`${project.name} ${version.versionNumber}${loaders ? ` for ${loaders}` : ''}${versions ? ` on Minecraft ${versions}` : ''}. Scanned and signed before download.`, DESCRIPTION_MAX),
      noindex,
    };
  }
  if (tab === 'versions') {
    return { title: `${project.name} versions`, description: clip(`Every published version of ${project.name}, a ${projectFacts(project)}.`, DESCRIPTION_MAX), noindex };
  }
  if (tab === 'changelog') {
    return { title: `${project.name} changelog`, description: clip(`What changed in each version of ${project.name}, a ${projectFacts(project)}.`, DESCRIPTION_MAX), noindex };
  }
  if (tab === 'contents') {
    return { title: `${project.name} mod list`, description: clip(`Every mod and file in the ${project.name} modpack, each one checked and scanned.`, DESCRIPTION_MAX), noindex };
  }
  if (tab === 'comments') {
    return { title: `${project.name} comments`, description: clip(`Comments and questions about ${project.name}, a ${projectFacts(project)}.`, DESCRIPTION_MAX), noindex };
  }
  if (tab === 'gallery') {
    return { title: `${project.name} gallery`, description: clip(`Screenshots of ${project.name}, a ${projectFacts(project)}.`, DESCRIPTION_MAX), noindex };
  }
  const summary = project.summary.trim().replace(/[.!]?$/, '.');
  const facts = projectFacts(project);
  const description = summary.length < 110 ? `${summary} ${facts[0].toUpperCase()}${facts.slice(1)}.` : summary;
  return { title: `${project.name} · Minecraft ${typeLabel(project.type)}`, description: clip(description, DESCRIPTION_MAX), noindex };
}

export function userHead(user: UserPublic, projectCount: number, siteName: string): PageHead {
  const name = user.displayName && user.displayName !== user.username ? `${user.displayName} (@${user.username})` : user.username;
  const description = user.bio?.trim()
    ? clip(user.bio, DESCRIPTION_MAX)
    : `${projectCount ? `${projectCount} Minecraft project${projectCount === 1 ? '' : 's'}` : 'Minecraft projects'} by ${user.username} on ${siteName}.`;
  // A profile with nothing published has nothing worth indexing.
  return { title: name, description, noindex: projectCount === 0 };
}

// Rough plain text from Markdown, for crawlers that don't run the app. Not a renderer.
export function markdownToText(md: string, max = 4000): string[] {
  const text = md
    .slice(0, max * 2)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]{1,3}/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');
  const out: string[] = [];
  let total = 0;
  for (const block of text.split(/\n\s*\n/)) {
    const para = block.replace(/\s+/g, ' ').trim();
    if (!para) continue;
    if (total + para.length > max) {
      if (max - total > 80) out.push(clip(para, max - total));
      break;
    }
    out.push(para);
    total += para.length;
  }
  return out;
}
