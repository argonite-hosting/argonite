export interface SignedFileRecord {
  fileId: string;
  versionId: string;
  projectId: string;
  repoId: number;
  releaseId: number;
  assetId: number;
  filename: string;
  size: number;
  sha1: string;
  sha256: string;
  sha512: string;
}

// The scanner signs exactly this byte string. scanner/argonite_scan/signing.py has to stay in lockstep.
export function canonicalFileRecord(r: SignedFileRecord): string {
  return [
    'argonite-file-v2',
    `file:${r.fileId}`,
    `version:${r.versionId}`,
    `project:${r.projectId}`,
    `repo:${r.repoId}`,
    `release:${r.releaseId}`,
    `asset:${r.assetId}`,
    `name:${r.filename}`,
    `size:${r.size}`,
    `sha1:${r.sha1}`,
    `sha256:${r.sha256}`,
    `sha512:${r.sha512}`,
  ].join('\n');
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function verifyFileRecord(publicKeyB64: string, record: SignedFileRecord, signatureB64: string): Promise<boolean> {
  if (!publicKeyB64 || !signatureB64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', base64ToBytes(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
    const data = new TextEncoder().encode(canonicalFileRecord(record));
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, base64ToBytes(signatureB64), data);
  } catch {
    return false;
  }
}
