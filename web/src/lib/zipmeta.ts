// Reads a handful of metadata files straight out of the zip's central directory, so the upload form can
// prefill itself and warn about obvious problems without pulling the whole file into memory. Only a
// convenience; the scanner re-reads everything.

export interface DetectedMeta {
  versionNumber?: string;
  name?: string;
  loaders: string[];
  gameVersions: string[];
  // A single top-level folder that holds the real content (the "zipped the folder" mistake).
  wrappedFolder?: string;
  // Compiled code or programs, which resource packs, data packs and shaders may not contain.
  hasCode: boolean;
  packFormat?: { format: number; min?: number; max?: number };
  hasAssets: boolean;
  hasData: boolean;
  hasShaders: boolean;
}

const WANTED = new Set([
  'fabric.mod.json',
  'quilt.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
  'mcmod.info',
  'riftmod.json',
  'litemod.json',
  'plugin.yml',
  'paper-plugin.yml',
  'bungee.yml',
  'velocity-plugin.json',
  'META-INF/sponge_plugins.json',
  'extension.yml',
  'modrinth.index.json',
  'manifest.json',
  'pack.mcmeta',
]);
const MAX_ENTRY = 1024 * 1024;
const MAX_NAMES = 100_000;
const CODE = /\.(class|exe|dll|so|dylib|jnilib|bat|cmd|ps1|vbs|sh|command|jar|msi|scr)$/i;

interface CdEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  offset: number;
}

async function slice(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

async function centralDirectory(file: File): Promise<{ wanted: CdEntry[]; names: string[] }> {
  const tailSize = Math.min(file.size, 65_557);
  const tail = await slice(file, file.size - tailSize, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { wanted: [], names: [] };
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || cdOffset + cdSize > file.size || cdSize > 16 * 1024 * 1024) return { wanted: [], names: [] };
  const cd = await slice(file, cdOffset, cdOffset + cdSize);
  const wanted: CdEntry[] = [];
  const names: string[] = [];
  const dec = new TextDecoder();
  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50 && names.length < MAX_NAMES) {
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen)).replace(/\\/g, '/');
    names.push(name);
    const top = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    if (WANTED.has(name) || (WANTED.has(top) && (top === 'pack.mcmeta' || top === 'fabric.mod.json'))) {
      wanted.push({
        name,
        method: cd.getUint16(p + 10, true),
        compSize: cd.getUint32(p + 20, true),
        size: cd.getUint32(p + 24, true),
        offset: cd.getUint32(p + 42, true),
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { wanted, names };
}

async function readEntry(file: File, e: CdEntry): Promise<string | null> {
  if (e.size > MAX_ENTRY || e.compSize > MAX_ENTRY) return null;
  const header = await slice(file, e.offset, e.offset + 30);
  if (header.getUint32(0, true) !== 0x04034b50) return null;
  const start = e.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const raw = file.slice(start, start + e.compSize);
  if (e.method === 0) return raw.text();
  if (e.method !== 8 || typeof DecompressionStream === 'undefined') return null;
  const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const text = await new Response(stream).text();
  return text.length > MAX_ENTRY ? null : text;
}

function exactVersions(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().replace(/^[~=]/, ''))
    .filter((v) => /^\d+(\.\d+){1,2}$/.test(v));
}

function tomlValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text);
  return m?.[1];
}

function yamlValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*['"]?([^'"#\\n]+)`, 'm').exec(text);
  return m?.[1]?.trim();
}

function wrapped(names: string[]): string | undefined {
  const tops = new Set(names.filter((n) => n.includes('/')).map((n) => n.split('/')[0]));
  if (tops.size !== 1 || names.some((n) => !n.includes('/'))) return undefined;
  const folder = [...tops][0];
  const markers = ['pack.mcmeta', 'fabric.mod.json', 'META-INF/mods.toml', 'modrinth.index.json'];
  return markers.some((m) => names.includes(`${folder}/${m}`)) || names.some((n) => n.startsWith(`${folder}/shaders/`)) ? folder : undefined;
}

export async function detectMeta(file: File): Promise<DetectedMeta> {
  const meta: DetectedMeta = { loaders: [], gameVersions: [], hasCode: false, hasAssets: false, hasData: false, hasShaders: false };
  let cd: { wanted: CdEntry[]; names: string[] };
  try {
    cd = await centralDirectory(file);
  } catch {
    return meta;
  }
  meta.hasCode = cd.names.some((n) => CODE.test(n));
  meta.wrappedFolder = wrapped(cd.names);
  const prefix = meta.wrappedFolder ? `${meta.wrappedFolder}/` : '';
  meta.hasAssets = cd.names.some((n) => n.startsWith(`${prefix}assets/`));
  meta.hasData = cd.names.some((n) => n.startsWith(`${prefix}data/`));
  meta.hasShaders = cd.names.some((n) => n.startsWith(`${prefix}shaders/`));
  if (cd.names.some((n) => /^[^/]+\.nilmod\.css$/.test(n))) meta.loaders.push('nilloader');

  for (const e of cd.wanted) {
    const name = prefix && e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
    let text: string | null = null;
    try {
      text = await readEntry(file, e);
    } catch {
      text = null;
    }
    if (!text) continue;
    try {
      if (name === 'fabric.mod.json') {
        const j = JSON.parse(text);
        meta.loaders.push('fabric');
        meta.versionNumber ??= typeof j.version === 'string' ? j.version : undefined;
        meta.name ??= typeof j.name === 'string' ? j.name : undefined;
        meta.gameVersions.push(...exactVersions(j.depends?.minecraft));
      } else if (name === 'quilt.mod.json') {
        const j = JSON.parse(text).quilt_loader ?? {};
        meta.loaders.push('quilt');
        meta.versionNumber ??= typeof j.version === 'string' ? j.version : undefined;
        meta.name ??= typeof j.metadata?.name === 'string' ? j.metadata.name : undefined;
      } else if (name.endsWith('mods.toml')) {
        meta.loaders.push(name.includes('neoforge') ? 'neoforge' : 'forge');
        const v = tomlValue(text, 'version');
        if (v && !v.includes('$')) meta.versionNumber ??= v;
        const display = tomlValue(text, 'displayName');
        if (display) meta.name ??= display;
        const range = /modId\s*=\s*["']minecraft["'][\s\S]*?versionRange\s*=\s*["']\[([0-9.]+)\s*[,\]]/m.exec(text);
        if (range) meta.gameVersions.push(range[1]);
      } else if (name === 'mcmod.info') {
        const j = JSON.parse(text);
        const first = Array.isArray(j) ? j[0] : j.modList?.[0];
        meta.loaders.push('forge');
        if (typeof first?.version === 'string' && !first.version.includes('$')) meta.versionNumber ??= first.version;
        meta.name ??= typeof first?.name === 'string' ? first.name : undefined;
        meta.gameVersions.push(...exactVersions(first?.mcversion));
      } else if (name === 'riftmod.json') {
        meta.loaders.push('rift');
      } else if (name === 'litemod.json') {
        const j = JSON.parse(text);
        meta.loaders.push('liteloader');
        meta.versionNumber ??= typeof j.version === 'string' ? j.version : undefined;
        meta.gameVersions.push(...exactVersions(j.mcversion));
      } else if (name === 'plugin.yml' || name === 'paper-plugin.yml') {
        meta.loaders.push(...(name === 'paper-plugin.yml' ? ['paper'] : ['paper', 'spigot', 'bukkit']));
        if (/^folia-supported:\s*true/m.test(text)) meta.loaders.push('folia');
        const v = yamlValue(text, 'version');
        if (v && !v.includes('$')) meta.versionNumber ??= v;
        meta.name ??= yamlValue(text, 'name');
      } else if (name === 'bungee.yml') {
        meta.loaders.push('bungeecord', 'waterfall');
        meta.versionNumber ??= yamlValue(text, 'version');
      } else if (name === 'velocity-plugin.json') {
        const j = JSON.parse(text);
        meta.loaders.push('velocity');
        meta.versionNumber ??= typeof j.version === 'string' ? j.version : undefined;
      } else if (name === 'META-INF/sponge_plugins.json') {
        meta.loaders.push('sponge');
      } else if (name === 'extension.yml') {
        meta.loaders.push('geyser');
        meta.versionNumber ??= yamlValue(text, 'version');
      } else if (name === 'pack.mcmeta') {
        const pack = JSON.parse(text).pack ?? {};
        const num = (x: unknown) => (typeof x === 'number' ? x : Array.isArray(x) && typeof x[0] === 'number' ? x[0] : undefined);
        const format = num(pack.pack_format) ?? num(pack.min_format);
        if (format !== undefined) meta.packFormat = { format, min: num(pack.min_format) ?? num(pack.supported_formats?.min_inclusive ?? pack.supported_formats), max: num(pack.max_format) ?? num(pack.supported_formats?.max_inclusive) };
      } else if (name === 'modrinth.index.json') {
        const j = JSON.parse(text);
        meta.versionNumber ??= typeof j.versionId === 'string' ? j.versionId : undefined;
        meta.name ??= typeof j.name === 'string' ? j.name : undefined;
        const deps = j.dependencies ?? {};
        meta.gameVersions.push(...exactVersions(deps.minecraft));
        if (deps['fabric-loader']) meta.loaders.push('fabric');
        if (deps['quilt-loader']) meta.loaders.push('quilt');
        if (deps.forge) meta.loaders.push('forge');
        if (deps.neoforge) meta.loaders.push('neoforge');
      } else if (name === 'manifest.json') {
        const j = JSON.parse(text);
        if (j.manifestType !== 'minecraftModpack') continue;
        meta.versionNumber ??= typeof j.version === 'string' ? j.version : undefined;
        meta.name ??= typeof j.name === 'string' ? j.name : undefined;
        meta.gameVersions.push(...exactVersions(j.minecraft?.version));
        for (const l of j.minecraft?.modLoaders ?? []) {
          const id = String(l?.id ?? '').split('-')[0];
          if (['forge', 'neoforge', 'fabric', 'quilt'].includes(id)) meta.loaders.push(id);
        }
      }
    } catch {
      // A malformed metadata file just means less prefill.
    }
  }
  meta.loaders = [...new Set(meta.loaders)];
  meta.gameVersions = [...new Set(meta.gameVersions)];
  if (meta.versionNumber) meta.versionNumber = meta.versionNumber.slice(0, 64);
  if (meta.name) meta.name = meta.name.slice(0, 80);
  return meta;
}
