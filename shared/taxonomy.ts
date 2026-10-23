export type ProjectType = 'mod' | 'plugin' | 'resourcepack' | 'shader' | 'datapack' | 'modpack';

export interface ProjectTypeInfo {
  id: ProjectType;
  label: string;
  plural: string;
  path: string;
  extensions: string[];
  loaders: string[];
}

export const PROJECT_TYPES: ProjectTypeInfo[] = [
  {
    id: 'mod',
    label: 'Mod',
    plural: 'Mods',
    path: 'mods',
    extensions: ['.jar'],
    loaders: ['fabric', 'neoforge', 'forge', 'quilt', 'legacy-fabric', 'ornithe', 'babric', 'bta-babric', 'nilloader', 'rift', 'liteloader', 'modloader', 'java-agent'],
  },
  {
    id: 'plugin',
    label: 'Plugin',
    plural: 'Plugins',
    path: 'plugins',
    extensions: ['.jar'],
    loaders: ['paper', 'purpur', 'folia', 'spigot', 'bukkit', 'sponge', 'velocity', 'bungeecord', 'waterfall', 'geyser'],
  },
  { id: 'resourcepack', label: 'Resource pack', plural: 'Resource packs', path: 'resourcepacks', extensions: ['.zip'], loaders: ['minecraft'] },
  { id: 'shader', label: 'Shader', plural: 'Shaders', path: 'shaders', extensions: ['.zip'], loaders: ['iris', 'optifine', 'canvas', 'vanilla'] },
  { id: 'datapack', label: 'Data pack', plural: 'Data packs', path: 'datapacks', extensions: ['.zip'], loaders: ['datapack'] },
  { id: 'modpack', label: 'Modpack', plural: 'Modpacks', path: 'modpacks', extensions: ['.mrpack', '.zip'], loaders: ['fabric', 'neoforge', 'forge', 'quilt'] },
];

export const LOADER_LABELS: Record<string, string> = {
  fabric: 'Fabric',
  neoforge: 'NeoForge',
  forge: 'Forge',
  quilt: 'Quilt',
  'legacy-fabric': 'Legacy Fabric',
  ornithe: 'Ornithe',
  babric: 'Babric',
  'bta-babric': 'BTA (Babric)',
  nilloader: 'NilLoader',
  rift: 'Rift',
  liteloader: 'LiteLoader',
  modloader: 'ModLoader',
  'java-agent': 'Java Agent',
  paper: 'Paper',
  purpur: 'Purpur',
  folia: 'Folia',
  spigot: 'Spigot',
  bukkit: 'Bukkit',
  sponge: 'Sponge',
  velocity: 'Velocity',
  bungeecord: 'BungeeCord',
  waterfall: 'Waterfall',
  geyser: 'Geyser extension',
  minecraft: 'Minecraft',
  iris: 'Iris',
  optifine: 'OptiFine',
  canvas: 'Canvas',
  vanilla: 'Vanilla',
  datapack: 'Data pack',
};

export interface Category {
  id: string;
  label: string;
  types: ProjectType[];
}

const content: ProjectType[] = ['mod', 'plugin', 'datapack'];

export const CATEGORIES: Category[] = [
  { id: 'adventure', label: 'Adventure', types: [...content, 'modpack'] },
  { id: 'decoration', label: 'Decoration', types: content },
  { id: 'economy', label: 'Economy', types: content },
  { id: 'equipment', label: 'Equipment', types: content },
  { id: 'food', label: 'Food', types: content },
  { id: 'game-mechanics', label: 'Game mechanics', types: content },
  { id: 'library', label: 'Library', types: content },
  { id: 'magic', label: 'Magic', types: [...content, 'modpack'] },
  { id: 'management', label: 'Management', types: content },
  { id: 'minigame', label: 'Minigame', types: content },
  { id: 'mobs', label: 'Mobs', types: content },
  { id: 'optimization', label: 'Optimization', types: [...content, 'modpack'] },
  { id: 'social', label: 'Social', types: content },
  { id: 'storage', label: 'Storage', types: content },
  { id: 'technology', label: 'Technology', types: [...content, 'modpack'] },
  { id: 'transportation', label: 'Transportation', types: content },
  { id: 'utility', label: 'Utility', types: [...content, 'resourcepack'] },
  { id: 'worldgen', label: 'World generation', types: content },
  { id: 'combat', label: 'Combat', types: [...content, 'modpack'] },
  { id: 'kitchen-sink', label: 'Kitchen sink', types: ['modpack'] },
  { id: 'lightweight', label: 'Lightweight', types: ['modpack'] },
  { id: 'multiplayer', label: 'Multiplayer', types: ['modpack'] },
  { id: 'quests', label: 'Quests', types: ['modpack'] },
  { id: 'challenging', label: 'Challenging', types: ['modpack'] },
  { id: 'vanilla-like', label: 'Vanilla-like', types: ['resourcepack', 'shader', 'modpack'] },
  { id: 'realistic', label: 'Realistic', types: ['resourcepack', 'shader'] },
  { id: 'simplistic', label: 'Simplistic', types: ['resourcepack'] },
  { id: 'themed', label: 'Themed', types: ['resourcepack'] },
  { id: 'gui', label: 'GUI', types: ['resourcepack'] },
  { id: 'fonts', label: 'Fonts', types: ['resourcepack'] },
  { id: 'models', label: 'Models', types: ['resourcepack'] },
  { id: 'audio', label: 'Audio', types: ['resourcepack'] },
  { id: 'res-16', label: '16x', types: ['resourcepack'] },
  { id: 'res-32', label: '32x', types: ['resourcepack'] },
  { id: 'res-64', label: '64x', types: ['resourcepack'] },
  { id: 'res-128', label: '128x+', types: ['resourcepack'] },
  { id: 'fantasy', label: 'Fantasy', types: ['shader'] },
  { id: 'cartoon', label: 'Cartoon', types: ['shader'] },
  { id: 'semi-realistic', label: 'Semi-realistic', types: ['shader'] },
  { id: 'potato', label: 'Low-end friendly', types: ['shader'] },
  { id: 'high', label: 'High-end', types: ['shader'] },
];

export const LICENSES: { id: string; label: string }[] = [
  { id: 'MIT', label: 'MIT' },
  { id: 'Apache-2.0', label: 'Apache 2.0' },
  { id: 'MPL-2.0', label: 'Mozilla Public License 2.0' },
  { id: 'GPL-3.0-only', label: 'GPL 3.0 only' },
  { id: 'GPL-3.0-or-later', label: 'GPL 3.0 or later' },
  { id: 'LGPL-3.0-only', label: 'LGPL 3.0 only' },
  { id: 'LGPL-3.0-or-later', label: 'LGPL 3.0 or later' },
  { id: 'AGPL-3.0-only', label: 'AGPL 3.0 only' },
  { id: 'BSD-2-Clause', label: 'BSD 2-Clause' },
  { id: 'BSD-3-Clause', label: 'BSD 3-Clause' },
  { id: 'Unlicense', label: 'The Unlicense' },
  { id: 'CC0-1.0', label: 'CC0 1.0' },
  { id: 'CC-BY-4.0', label: 'CC BY 4.0' },
  { id: 'CC-BY-SA-4.0', label: 'CC BY-SA 4.0' },
  { id: 'CC-BY-NC-4.0', label: 'CC BY-NC 4.0' },
  { id: 'CC-BY-NC-SA-4.0', label: 'CC BY-NC-SA 4.0' },
  { id: 'LicenseRef-All-Rights-Reserved', label: 'All rights reserved' },
  { id: 'LicenseRef-Custom', label: 'Custom license (link required)' },
];

export const SIDES = ['required', 'optional', 'unsupported', 'unknown'] as const;
export type Side = (typeof SIDES)[number];

export const CHANNELS = ['release', 'beta', 'alpha'] as const;
export type Channel = (typeof CHANNELS)[number];

export const DEPENDENCY_KINDS = ['required', 'optional', 'incompatible', 'embedded'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export const REPORT_REASONS: { id: string; label: string }[] = [
  { id: 'malware', label: 'Malware or suspicious code' },
  { id: 'copyright', label: 'Copyright or reupload' },
  { id: 'impersonation', label: 'Impersonation' },
  { id: 'spam', label: 'Spam or misleading' },
  { id: 'inappropriate', label: 'Inappropriate content' },
  { id: 'broken', label: 'Broken or unavailable file' },
  { id: 'other', label: 'Something else' },
];

export const VERSION_STATUSES = ['uploading', 'scanning', 'review', 'live', 'rejected', 'revoked', 'unavailable', 'deleted'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const PROJECT_STATUSES = ['draft', 'active', 'delisted', 'removed'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SORTS = ['relevance', 'downloads', 'follows', 'updated', 'newest'] as const;
export type Sort = (typeof SORTS)[number];

export function typeInfo(type: string): ProjectTypeInfo | undefined {
  return PROJECT_TYPES.find((t) => t.id === type);
}

export function typeByPath(path: string): ProjectTypeInfo | undefined {
  return PROJECT_TYPES.find((t) => t.path === path);
}

export function categoriesFor(type: ProjectType | undefined): Category[] {
  return type ? CATEGORIES.filter((c) => c.types.includes(type)) : CATEGORIES;
}

export function categoryLabel(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function loaderLabel(id: string): string {
  return LOADER_LABELS[id] ?? id;
}

export function licenseLabel(id: string): string {
  return LICENSES.find((l) => l.id === id)?.label ?? id;
}

export const FILE_KINDS = ['primary', 'sources', 'javadoc', 'dev', 'server', 'client', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const FILE_KIND_LABELS: Record<FileKind, string> = {
  primary: 'Main file',
  sources: 'Sources',
  javadoc: 'Javadoc',
  dev: 'Development build',
  server: 'Server pack',
  client: 'Client pack',
  other: 'Other file',
};

export const ENVIRONMENTS = ['client', 'server'] as const;

export const SERVER_REGIONS: { id: string; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'na', label: 'North America' },
  { id: 'sa', label: 'South America' },
  { id: 'eu', label: 'Europe' },
  { id: 'asia', label: 'Asia' },
  { id: 'oceania', label: 'Oceania' },
  { id: 'africa', label: 'Africa' },
];

export const SERVER_TAGS: { id: string; label: string }[] = [
  { id: 'survival', label: 'Survival' },
  { id: 'creative', label: 'Creative' },
  { id: 'smp', label: 'SMP' },
  { id: 'minigames', label: 'Minigames' },
  { id: 'pvp', label: 'PvP' },
  { id: 'skyblock', label: 'Skyblock' },
  { id: 'factions', label: 'Factions' },
  { id: 'roleplay', label: 'Roleplay' },
  { id: 'modded', label: 'Modded' },
  { id: 'anarchy', label: 'Anarchy' },
  { id: 'economy', label: 'Economy' },
  { id: 'hardcore', label: 'Hardcore' },
];

export const COMMENT_MODES = ['open', 'members', 'off'] as const;
export type CommentMode = (typeof COMMENT_MODES)[number];
