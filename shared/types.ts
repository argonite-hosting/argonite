import type { Channel, CommentMode, DependencyKind, FileKind, ProjectStatus, ProjectType, Side, VersionStatus } from './taxonomy';

export type Role = 'user' | 'moderator' | 'admin';

export interface UserRef {
  id: string;
  username: string;
  avatarUrl: string;
}

export interface UserPublic extends UserRef {
  displayName: string | null;
  bio: string | null;
  role: Role;
  createdAt: number;
}

export interface Me extends UserPublic {
  banned: boolean;
  githubId: number;
  pendingInvites: number;
  unreadNotifications: number;
}

export interface UserProfileRef {
  url: string;
  sha256: string;
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  summary: string;
  type: ProjectType;
  iconUrl: string | null;
  downloads: number;
  follows: number;
  categories: string[];
  loaders: string[];
  gameVersions: string[];
  createdAt: number;
  updatedAt: number;
  author: UserRef;
  org: OrgRef | null;
  archived: boolean;
}

export interface OrgRef {
  id: string;
  slug: string;
  name: string;
  avatarUrl: string | null;
}

export interface ProjectLinks {
  source: string | null;
  issues: string | null;
  wiki: string | null;
  discord: string | null;
  donation: string | null;
  license: string | null;
}

export interface RepoInfo {
  id: number;
  fullName: string;
  url: string;
  status: 'ok' | 'transferred' | 'deleted' | 'private' | 'no_access';
}

export interface Member {
  user: UserRef;
  role: 'owner' | 'maintainer';
  accepted: boolean;
  permissions: number;
}

export interface GalleryImage {
  id: string;
  url: string;
  title: string | null;
}

export interface Project extends ProjectSummary {
  description: string;
  status: ProjectStatus;
  license: string;
  links: ProjectLinks;
  clientSide: Side;
  serverSide: Side;
  repo: RepoInfo;
  members: Member[];
  gallery: GalleryImage[];
  publishedAt: number | null;
  bannerUrl: string | null;
  commentsMode: CommentMode;
  views: number;
}

export interface FileInfo {
  id: string;
  kind: FileKind;
  filename: string;
  size: number;
  sha1: string;
  sha256: string;
  sha512: string;
  signature: string;
  repoId: number;
  releaseId: number;
  assetId: number;
  scannedAt: number;
  // Native libraries or programs bundled inside the file. Code outside the Java sandbox.
  nativeFiles: number;
}

export interface NativeFile {
  path: string;
  sha256: string;
  size: number;
  platform: 'windows' | 'linux' | 'macos' | 'unknown';
}

export interface Dependency {
  projectId: string;
  projectSlug: string | null;
  projectName: string | null;
  versionId: string | null;
  versionNumber: string | null;
  kind: DependencyKind;
}

export interface Finding {
  rule: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  detail: string;
  path?: string;
  // The class the finding was made in, for findings that only carry over to identical code.
  sha256?: string;
}

export interface ScanSummary {
  verdict: 'clean' | 'suspicious' | 'malicious' | null;
  findings: Finding[];
  capabilities: string[];
  engines: string[];
  scannedAt: number | null;
  natives: NativeFile[];
  // Websites the file links to from its code and config.
  hosts: string[];
}

// One behaviour test: the file run inside real Minecraft on a fresh machine with the network cut off.
export interface SandboxSummary {
  os: 'linux' | 'windows' | 'macos';
  outcome: 'running' | 'tested' | 'unsupported' | 'error';
  note: string | null;
  gameVersion: string | null;
  loader: string | null;
  server: boolean;
  client: boolean;
  joined: boolean;
  dependencies: number;
  // Seconds the game was watched after it had booted into a world.
  watched: number;
  findings: Finding[];
  finishedAt: number | null;
}

export interface Version {
  id: string;
  projectId: string;
  versionNumber: string;
  name: string;
  changelog: string;
  channel: Channel;
  status: VersionStatus;
  statusReason: string | null;
  // Why the automatic checks held or rejected it; only sent to moderators.
  reviewDetail?: string | null;
  loaders: string[];
  gameVersions: string[];
  dependencies: Dependency[];
  downloads: number;
  createdAt: number;
  publishedAt: number | null;
  author: UserRef;
  featured: boolean;
  file: FileInfo | null;
  files: FileInfo[];
  releaseUrl: string | null;
  scan?: ScanSummary;
  scans?: Record<string, ScanSummary & { filename: string; kind: FileKind; uploaded: boolean }>;
  sandbox?: SandboxSummary[];
  publishPending?: boolean;
}

export interface PackEntry {
  path: string;
  size: number;
  env: { client: string; server: string } | null;
  source: 'argonite' | 'external' | 'curseforge' | 'bundled';
  host: string | null;
  project: { slug: string; name: string; type: ProjectType } | null;
  verdict: 'clean' | 'suspicious' | 'malicious' | 'unscanned';
}

export interface PackContents {
  minecraft: string | null;
  loaders: Record<string, string>;
  entries: PackEntry[];
  truncated: boolean;
}

export interface CommentPageRef {
  page: number;
  url: string | null;
  sha256: string | null;
  count: number;
  pending: Comment[];
}

export interface Comment {
  id: string;
  parent: string | null;
  author: { id: string; username: string };
  body: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
}

export interface CommentPageFile {
  v: 1;
  project: string;
  page: number;
  comments: Comment[];
}

export interface CollectionSummary {
  id: string;
  name: string;
  summary: string;
  visibility: 'public' | 'unlisted' | 'private';
  itemCount: number;
  owner: UserRef;
  updatedAt: number;
}

export interface CollectionDetail extends CollectionSummary {
  // Public collections: where to fetch the items and the hash they must match.
  source: { url: string; sha256: string } | null;
  items: string[] | null;
  projects: ProjectSummary[];
}

export interface CollectionFile {
  v: 1;
  id: string;
  owner: string;
  name: string;
  summary: string;
  items: string[];
}

export interface ProfileFile {
  v: 1;
  user: string;
  links: { label: string; url: string }[];
}

export type NotificationKind = 'version' | 'invite' | 'org_invite' | 'comment' | 'reply' | 'mod_message' | 'version_status';

export interface Notification {
  id: string;
  kind: NotificationKind;
  params: Record<string, string>;
  title: string;
  body: string;
  url: string;
  createdAt: number;
  unread: boolean;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: number;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export interface ModMessage {
  id: string;
  author: UserRef;
  staff: boolean;
  body: string;
  internal: boolean;
  createdAt: number;
}

export interface ProjectStats {
  days: { day: string; views: number; downloads: number }[];
  versions: { id: string; versionNumber: string; downloads: number }[];
  countries: { country: string; views: number; downloads: number }[];
  totals: { views: number; downloads: number };
}

export interface Organization {
  id: string;
  slug: string;
  name: string;
  summary: string;
  avatarUrl: string | null;
  githubLogin: string | null;
  createdAt: number;
  members: { user: UserRef; role: 'owner' | 'member'; accepted: boolean; permissions: number; orgPermissions: number }[];
  projects: ProjectSummary[];
}

export interface ServerListing {
  id: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  address: string;
  edition: 'java' | 'bedrock';
  region: string;
  tags: string[];
  favicon: string | null;
  online: boolean;
  playersOnline: number | null;
  playersMax: number | null;
  gameVersion: string | null;
  motd: string | null;
  uptime: number | null;
  lastPingAt: number | null;
  modpack: ProjectSummary | null;
  links: { website: string | null; discord: string | null };
  owner: UserRef;
  org: OrgRef | null;
  status: 'active' | 'delisted' | 'removed';
  createdAt: number;
  updatedAt: number;
}

export interface AutoPublishSettings {
  enabled: boolean;
  drafts: boolean;
  assetPattern: string;
  loaders: string[];
  gameVersions: string[];
}

export interface SearchResult {
  hits: ProjectSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GameVersion {
  id: string;
  type: 'release' | 'snapshot';
  releasedAt: number;
}

export interface Report {
  id: string;
  targetType: 'project' | 'version' | 'user' | 'comment' | 'collection' | 'organization' | 'server';
  targetId: string;
  targetLabel: string;
  targetUrl: string;
  reason: string;
  details: string;
  status: 'open' | 'resolved' | 'dismissed';
  reporter: UserRef;
  createdAt: number;
  resolution: string | null;
}

export interface ReviewItem {
  version: Version;
  project: ProjectSummary;
}

export interface AuditEntry {
  id: string;
  actor: UserRef | null;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  createdAt: number;
}

export interface Invite {
  project: ProjectSummary;
  role: 'owner' | 'maintainer';
}

export interface RepoChoice {
  id: number;
  fullName: string;
  private: boolean;
  url: string;
}

export interface InstallationInfo {
  installed: boolean;
  installUrl: string;
  repos: RepoChoice[];
  canCreate: boolean;
}

export interface ApiError {
  error: string;
  message: string;
  fields?: Record<string, string>;
}
