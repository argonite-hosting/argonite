// Site worker. Static files are served straight from the asset store; this script only runs for
// project pages, user pages and the sitemap (see run_worker_first in wrangler.template.toml).
// It fills the page head with that page's own title, description and structured data, and puts a
// plain-HTML version of the content in the body for crawlers that don't run JavaScript. The app
// replaces it as soon as it loads, and shows the same information.
import { SITE } from '../../shared/config';
import { sortGameVersionsDesc } from '../../shared/gameversions';
import { markdownToText, projectFacts, projectHead, typeLabel, userHead, type PageHead, type ProjectTab } from '../../shared/seo';
import { licenseLabel, loaderLabel, typeInfo } from '../../shared/taxonomy';
import type { CollectionDetail, Organization, Project, ProjectSummary, ServerListing, UserPublic, Version } from '../../shared/types';
import { isId } from '../../shared/validate';
import { esc, headTags, withBody, withHead, type HeadInput } from './tags';

interface Env {
  ASSETS: Fetcher;
  API: Fetcher;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number };

const SLUG = /^[A-Za-z0-9-]{1,48}$/;
const USERNAME = /^[A-Za-z0-9-]{1,39}$/;

async function api<T>(env: Env, request: Request, path: string): Promise<ApiResult<T>> {
  const headers = new Headers({ Accept: 'application/json' });
  // Rate limits on the API are per visitor, so pass the visitor's address along.
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) headers.set('CF-Connecting-IP', ip);
  try {
    const res = await env.API.fetch(new Request(SITE.apiUrl + path, { headers }));
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 502 };
  }
}

async function shell(env: Env, request: Request): Promise<{ html: string; headers: Headers }> {
  const res = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  const headers = new Headers(res.headers);
  for (const h of ['Content-Length', 'ETag', 'Last-Modified']) headers.delete(h);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  return { html: await res.text(), headers };
}

function baseHead(path: string, head: PageHead): HeadInput {
  return {
    url: SITE.url + path,
    title: `${head.title} · ${SITE.name}`,
    ogTitle: head.title,
    description: head.description,
    image: `${SITE.url}/og.png`,
    imageAlt: `${SITE.name} logo`,
    imageSize: [1200, 630],
    card: 'summary_large_image',
    type: 'website',
    noindex: head.noindex,
  };
}

async function page(env: Env, request: Request, head: HeadInput, body: string, status = 200): Promise<Response> {
  const { html, headers } = await shell(env, request);
  return new Response(withBody(withHead(html, headTags(head)), body), { status, headers });
}

async function notFound(env: Env, request: Request, what: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  const head = baseHead(path, { title: `${what} not found`, description: SITE.description, noindex: true });
  return page(env, request, head, '', 404);
}

// The API is down or busy. Tell crawlers to come back later; people still get the app.
async function unavailable(env: Env, request: Request): Promise<Response> {
  const { html, headers } = await shell(env, request);
  headers.set('Retry-After', '120');
  return new Response(html, { status: 503, headers });
}

function redirect(request: Request, path: string): Response {
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}${path}${url.search}`, 301);
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fmtCount = (n: number) => new Intl.NumberFormat('en', { notation: n >= 10_000 ? 'compact' : 'standard' }).format(n);

function paragraphs(md: string, max: number): string {
  return markdownToText(md, max)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
}

function projectBody(project: Project, versions: Version[], tab: ProjectTab, version: Version | undefined): string {
  const type = typeInfo(project.type);
  const base = `/project/${project.slug}`;
  const owners = project.members.filter((m) => m.accepted).map((m) => m.user);
  const authors = owners.length ? owners : [project.author];
  const crumbs = `<nav class="ssr-crumbs" aria-label="Breadcrumb"><a href="/">${esc(SITE.name)}</a> / <a href="/${type?.path ?? 'browse'}">${esc(type?.plural ?? 'Projects')}</a> / <a href="${base}">${esc(project.name)}</a></nav>`;
  const byline = `<p>By ${authors.map((a) => `<a href="/user/${esc(a.username)}">${esc(a.username)}</a>`).join(', ')} · ${esc(fmtCount(project.downloads))} downloads · updated ${fmtDate(project.updatedAt)}</p>`;
  const facts = [
    `<li>Type: ${esc(type?.label ?? project.type)}</li>`,
    project.loaders.length ? `<li>Loaders: ${esc(project.loaders.map(loaderLabel).join(', '))}</li>` : '',
    project.gameVersions.length ? `<li>Minecraft: ${esc(sortGameVersionsDesc(project.gameVersions).slice(0, 12).join(', '))}</li>` : '',
    `<li>License: ${esc(licenseLabel(project.license))}</li>`,
    project.links.source ? `<li><a href="${esc(project.links.source)}" rel="nofollow ugc">Source code</a></li>` : '',
  ].join('');
  const versionLink = (v: Version) =>
    `<li><a href="${base}/version/${esc(v.id)}">${esc(v.name || v.versionNumber)}</a> · ${esc(v.loaders.map(loaderLabel).join(', '))} · Minecraft ${esc(sortGameVersionsDesc(v.gameVersions).slice(0, 4).join(', '))}${v.publishedAt ? ` · ${fmtDate(v.publishedAt)}` : ''}</li>`;

  let main = '';
  if (tab === 'version' && version) {
    main = `<h2>${esc(version.name || version.versionNumber)}</h2>
      <ul><li>Version: ${esc(version.versionNumber)} (${esc(version.channel)})</li><li>Loaders: ${esc(version.loaders.map(loaderLabel).join(', '))}</li><li>Minecraft: ${esc(sortGameVersionsDesc(version.gameVersions).join(', '))}</li>${version.file ? `<li>File: ${esc(version.file.filename)}</li><li>SHA-256: <code>${esc(version.file.sha256)}</code></li>` : ''}</ul>
      ${version.changelog ? `<h3>Changelog</h3>${paragraphs(version.changelog, 3000)}` : ''}`;
  } else if (tab === 'versions') {
    main = `<h2>Versions</h2><ul>${versions.slice(0, 100).map(versionLink).join('')}</ul>`;
  } else if (tab === 'changelog') {
    main = `<h2>Changelog</h2>${versions
      .slice(0, 30)
      .map((v) => `<h3><a href="${base}/version/${esc(v.id)}">${esc(v.name || v.versionNumber)}</a></h3>${paragraphs(v.changelog || 'No changelog provided.', 1500)}`)
      .join('')}`;
  } else if (tab === 'contents') {
    main = `<h2>Mod list</h2><p>The full list of files in this modpack, each one checked and scanned, is shown on this page.</p>`;
  } else if (tab === 'comments') {
    main = `<h2>Comments</h2><p>Comments are stored in the project's GitHub repository and shown on this page.</p>`;
  } else if (tab === 'gallery') {
    main = `<h2>Gallery</h2>${project.gallery.map((g) => `<figure><img src="${esc(g.url)}" alt="${esc(g.title ?? `${project.name} screenshot`)}" loading="lazy" />${g.title ? `<figcaption>${esc(g.title)}</figcaption>` : ''}</figure>`).join('')}`;
  } else {
    main = `<h2>About</h2>${paragraphs(project.description, 4000)}${versions.length ? `<h2>Latest versions</h2><ul>${versions.slice(0, 8).map(versionLink).join('')}</ul><p><a href="${base}/versions">All versions</a></p>` : ''}`;
  }
  return `<main class="container page ssr-page">${crumbs}<h1>${esc(project.name)}</h1><p>${esc(project.summary)}</p>${byline}<ul>${facts}</ul>${main}</main>`;
}

function projectJsonLd(project: Project, versions: Version[], url: string): object[] {
  const type = typeInfo(project.type);
  const owners = project.members.filter((m) => m.accepted).map((m) => m.user);
  const authors = (owners.length ? owners : [project.author]).map((u) => ({ '@type': 'Person', name: u.username, url: `${SITE.url}/user/${u.username}` }));
  const latest = versions[0];
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: project.name,
      description: project.summary,
      url,
      ...(project.iconUrl ? { image: project.iconUrl } : {}),
      applicationCategory: 'GameApplication',
      applicationSubCategory: `Minecraft ${typeLabel(project.type)}`,
      keywords: projectFacts(project),
      ...(latest ? { softwareVersion: latest.versionNumber } : {}),
      ...(project.publishedAt ? { datePublished: new Date(project.publishedAt).toISOString() } : {}),
      dateModified: new Date(project.updatedAt).toISOString(),
      author: authors,
      license: project.links.license ?? licenseLabel(project.license),
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/DownloadAction', userInteractionCount: project.downloads },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: type?.plural ?? 'Projects', item: `${SITE.url}/${type?.path ?? 'browse'}` },
        { '@type': 'ListItem', position: 2, name: project.name, item: `${SITE.url}/project/${project.slug}` },
      ],
    },
  ];
}

async function projectPage(env: Env, request: Request, key: string, rest: string): Promise<Response> {
  const named: Record<string, ProjectTab> = { '': 'overview', '/versions': 'versions', '/gallery': 'gallery', '/changelog': 'changelog', '/contents': 'contents', '/comments': 'comments' };
  const tab: ProjectTab | null = named[rest] ?? (rest.startsWith('/version/') ? 'version' : null);
  if (!tab) return env.ASSETS.fetch(request);
  const versionId = tab === 'version' ? rest.slice('/version/'.length) : '';
  if (tab === 'version' && !isId(versionId)) return notFound(env, request, 'Version');

  const [p, v] = await Promise.all([
    api<Project>(env, request, `/v1/projects/${encodeURIComponent(key.toLowerCase())}`),
    api<{ versions: Version[] }>(env, request, `/v1/projects/${encodeURIComponent(key.toLowerCase())}/versions`),
  ]);
  if (!p.ok) return p.status === 404 ? notFound(env, request, 'Project') : unavailable(env, request);
  if (!v.ok) return unavailable(env, request);
  const project = p.data;
  if (key !== project.slug) return redirect(request, `/project/${project.slug}${rest}`);

  const versions = [...v.data.versions].sort((a, b) => (b.publishedAt ?? b.createdAt) - (a.publishedAt ?? a.createdAt));
  const version = tab === 'version' ? versions.find((x) => x.id === versionId) : undefined;
  if (tab === 'version' && !version) return notFound(env, request, 'Version');

  const path = `/project/${project.slug}${rest}`;
  const head = baseHead(path, projectHead(project, tab, version));
  const shot = project.gallery[0];
  if (shot) {
    head.image = shot.url;
    head.imageAlt = shot.title ?? `${project.name} screenshot`;
    head.imageSize = undefined;
  } else if (project.iconUrl) {
    head.image = project.iconUrl;
    head.imageAlt = `${project.name} icon`;
    head.imageSize = undefined;
    head.card = 'summary';
  }
  head.jsonLd = projectJsonLd(project, versions, SITE.url + path);
  return page(env, request, head, projectBody(project, versions, tab, version));
}

async function userPage(env: Env, request: Request, name: string): Promise<Response> {
  const res = await api<{ user: UserPublic; projects: ProjectSummary[] }>(env, request, `/v1/users/${encodeURIComponent(name)}`);
  if (!res.ok) return res.status === 404 ? notFound(env, request, 'User') : unavailable(env, request);
  const { user, projects } = res.data;
  if (name !== user.username) return redirect(request, `/user/${user.username}`);

  const path = `/user/${user.username}`;
  const head = baseHead(path, userHead(user, projects.length, SITE.name));
  head.type = 'profile';
  head.image = user.avatarUrl;
  head.imageAlt = `${user.username}'s avatar`;
  head.imageSize = undefined;
  head.card = 'summary';
  head.jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      dateCreated: new Date(user.createdAt).toISOString(),
      mainEntity: {
        '@type': 'Person',
        name: user.displayName || user.username,
        alternateName: user.username,
        url: SITE.url + path,
        image: user.avatarUrl,
        ...(user.bio ? { description: user.bio } : {}),
        sameAs: [`https://github.com/${user.username}`],
      },
    },
  ];
  const list = projects
    .map((p) => `<li><a href="/project/${esc(p.slug)}">${esc(p.name)}</a> · ${esc(projectFacts(p))} · ${esc(p.summary)}</li>`)
    .join('');
  const body = `<main class="container page ssr-page"><h1>${esc(user.displayName || user.username)}</h1><p>@${esc(user.username)}</p>${user.bio ? `<p>${esc(user.bio)}</p>` : ''}${list ? `<h2>Projects</h2><ul>${list}</ul>` : ''}</main>`;
  return page(env, request, head, body);
}

function projectList(projects: ProjectSummary[]): string {
  return projects.length
    ? `<h2>Projects</h2><ul>${projects.map((p) => `<li><a href="/project/${esc(p.slug)}">${esc(p.name)}</a> · ${esc(projectFacts(p))} · ${esc(p.summary)}</li>`).join('')}</ul>`
    : '';
}

async function orgPage(env: Env, request: Request, slug: string): Promise<Response> {
  const res = await api<Organization>(env, request, `/v1/organizations/${encodeURIComponent(slug.toLowerCase())}`);
  if (!res.ok) return res.status === 404 ? notFound(env, request, 'Organisation') : unavailable(env, request);
  const org = res.data;
  if (slug !== org.slug) return redirect(request, `/organization/${org.slug}`);
  const path = `/organization/${org.slug}`;
  const head = baseHead(path, {
    title: org.name,
    description: org.summary || `${org.projects.length} Minecraft project${org.projects.length === 1 ? '' : 's'} by ${org.name} on ${SITE.name}.`,
    noindex: org.projects.length === 0,
  });
  if (org.avatarUrl) {
    head.image = org.avatarUrl;
    head.imageAlt = `${org.name} logo`;
    head.imageSize = undefined;
    head.card = 'summary';
  }
  head.jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: org.name,
      url: SITE.url + path,
      ...(org.avatarUrl ? { logo: org.avatarUrl } : {}),
      ...(org.summary ? { description: org.summary } : {}),
      ...(org.githubLogin ? { sameAs: [`https://github.com/${org.githubLogin}`] } : {}),
      member: org.members.map((m) => ({ '@type': 'Person', name: m.user.username, url: `${SITE.url}/user/${m.user.username}` })),
    },
  ];
  const body = `<main class="container page ssr-page"><h1>${esc(org.name)}</h1>${org.summary ? `<p>${esc(org.summary)}</p>` : ''}${projectList(org.projects)}<h2>Members</h2><ul>${org.members
    .map((m) => `<li><a href="/user/${esc(m.user.username)}">${esc(m.user.username)}</a></li>`)
    .join('')}</ul></main>`;
  return page(env, request, head, body);
}

async function serverPage(env: Env, request: Request, slug: string): Promise<Response> {
  const res = await api<ServerListing>(env, request, `/v1/servers/${encodeURIComponent(slug.toLowerCase())}`);
  if (!res.ok) return res.status === 404 ? notFound(env, request, 'Server') : unavailable(env, request);
  const s = res.data;
  if (slug !== s.slug) return redirect(request, `/server/${s.slug}`);
  const path = `/server/${s.slug}`;
  const facts = [s.edition === 'java' ? 'Java Edition' : 'Bedrock Edition', s.gameVersion, s.online && s.playersOnline !== null ? `${s.playersOnline} players online` : null].filter(Boolean).join(' · ');
  const head = baseHead(path, { title: `${s.name} · Minecraft server`, description: `${s.summary} ${facts}.`.slice(0, 160), noindex: s.status !== 'active' });
  head.jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'GameServer',
      name: s.name,
      url: SITE.url + path,
      description: s.summary,
      serverStatus: s.online ? 'https://schema.org/Online' : 'https://schema.org/OfflineTemporarily',
      ...(s.playersOnline !== null ? { playersOnline: s.playersOnline } : {}),
      game: { '@type': 'VideoGame', name: 'Minecraft' },
    },
  ];
  const body = `<main class="container page ssr-page"><h1>${esc(s.name)}</h1><p>${esc(s.summary)}</p><ul><li>Address: <code>${esc(s.address)}</code></li><li>${esc(facts)}</li></ul>${
    s.modpack ? `<p>Runs the <a href="/project/${esc(s.modpack.slug)}">${esc(s.modpack.name)}</a> modpack.</p>` : ''
  }${paragraphs(s.description, 3000)}</main>`;
  return page(env, request, head, body);
}

async function collectionPage(env: Env, request: Request, id: string): Promise<Response> {
  const res = await api<CollectionDetail>(env, request, `/v1/collections/${id}`);
  // Private collections are only for their owner; the app loads those itself.
  if (!res.ok) return res.status === 404 ? shellOnly(env, request) : unavailable(env, request);
  const c = res.data;
  const path = `/collection/${c.id}`;
  const head = baseHead(path, {
    title: c.name,
    description: c.summary || `A collection of ${c.itemCount} Minecraft projects by ${c.owner.username}.`,
    noindex: c.visibility !== 'public' || c.itemCount === 0,
  });
  head.jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: c.name,
      url: SITE.url + path,
      author: { '@type': 'Person', name: c.owner.username, url: `${SITE.url}/user/${c.owner.username}` },
      hasPart: c.projects.map((p) => ({ '@type': 'SoftwareApplication', name: p.name, url: `${SITE.url}/project/${p.slug}` })),
    },
  ];
  const body = `<main class="container page ssr-page"><h1>${esc(c.name)}</h1><p>By <a href="/user/${esc(c.owner.username)}">${esc(c.owner.username)}</a></p>${c.summary ? `<p>${esc(c.summary)}</p>` : ''}${projectList(c.projects)}</main>`;
  return page(env, request, head, body);
}

// The plain app shell, marked noindex, for pages only the signed-in owner can load.
async function shellOnly(env: Env, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  return page(env, request, baseHead(path, { title: SITE.name, description: SITE.description, noindex: true }), '');
}

async function sitemapExtras(env: Env, request: Request): Promise<Response> {
  const res = await api<{ organizations: { slug: string; updatedAt: number }[]; servers: { slug: string; updatedAt: number }[] }>(env, request, '/v1/sitemap/extras');
  if (!res.ok) return new Response('Sitemap temporarily unavailable', { status: 503, headers: { 'Retry-After': '300' } });
  const urls = [
    ...res.data.organizations.map((o) => ({ loc: `${SITE.url}/organization/${o.slug}`, at: o.updatedAt })),
    ...res.data.servers.map((s) => ({ loc: `${SITE.url}/server/${s.slug}`, at: s.updatedAt })),
  ];
  return xml(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${new Date(u.at).toISOString()}</lastmod></url>`).join('\n')}\n</urlset>`,
  );
}

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=900', 'X-Content-Type-Options': 'nosniff' },
  });

async function sitemapIndex(env: Env, request: Request): Promise<Response> {
  const res = await api<{ projectPages: number; userPages: number }>(env, request, '/v1/sitemap');
  if (!res.ok) return new Response('Sitemap temporarily unavailable', { status: 503, headers: { 'Retry-After': '300' } });
  const files = ['pages.xml', 'extras.xml'];
  for (let i = 1; i <= res.data.projectPages; i++) files.push(`projects-${i}.xml`);
  for (let i = 1; i <= res.data.userPages; i++) files.push(`users-${i}.xml`);
  return xml(
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files.map((f) => `  <sitemap><loc>${SITE.url}/sitemaps/${f}</loc></sitemap>`).join('\n')}\n</sitemapindex>`,
  );
}

async function sitemapFile(env: Env, request: Request, kind: 'projects' | 'users', pageNo: number): Promise<Response> {
  const res = await api<{ items: { slug?: string; username?: string; updatedAt: number }[] }>(env, request, `/v1/sitemap/${kind}?page=${pageNo}`);
  if (!res.ok) return new Response('Sitemap temporarily unavailable', { status: res.status === 404 ? 404 : 503 });
  const urls = res.data.items.map((i) => {
    const path = kind === 'projects' ? `/project/${i.slug}` : `/user/${i.username}`;
    return `  <url><loc>${esc(SITE.url + path)}</loc><lastmod>${new Date(i.updatedAt).toISOString()}</lastmod></url>`;
  });
  return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request);
    const { pathname } = new URL(request.url);

    if (pathname === '/sitemap.xml') return sitemapIndex(env, request);
    if (pathname === '/sitemaps/extras.xml') return sitemapExtras(env, request);
    const sm = /^\/sitemaps\/(projects|users)-(\d{1,4})\.xml$/.exec(pathname);
    if (sm) return sitemapFile(env, request, sm[1] as 'projects' | 'users', Number(sm[2]));

    const pm = /^\/project\/([^/]+)(\/.*)?$/.exec(pathname);
    if (pm) {
      if (!SLUG.test(pm[1])) return notFound(env, request, 'Project');
      return projectPage(env, request, pm[1], pm[2] ?? '');
    }
    const om = /^\/organization\/([^/]+)$/.exec(pathname);
    if (om) return SLUG.test(om[1]) ? orgPage(env, request, om[1]) : notFound(env, request, 'Organisation');
    const svm = /^\/server\/([^/]+)$/.exec(pathname);
    if (svm) return SLUG.test(svm[1]) ? serverPage(env, request, svm[1]) : notFound(env, request, 'Server');
    const cm = /^\/collection\/([^/]+)$/.exec(pathname);
    if (cm) return isId(cm[1]) ? collectionPage(env, request, cm[1]) : notFound(env, request, 'Collection');
    const um = /^\/user\/([^/]+)$/.exec(pathname);
    if (um) return USERNAME.test(um[1]) ? userPage(env, request, um[1]) : notFound(env, request, 'User');

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
