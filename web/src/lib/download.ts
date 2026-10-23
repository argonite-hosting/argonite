import { bytesToHex, verifyFileRecord, type SignedFileRecord } from '../../../shared/signing';
import type { FileInfo, Version } from '../../../shared/types';
import { API_URL, SCAN_PUBLIC_KEY } from '../config';
import { downloadUrl, fileDownloadUrl } from './api';
import { t } from './i18n';

export type Phase = 'signature' | 'connecting' | 'downloading' | 'verifying' | 'saving' | 'done' | 'failed';

export interface DownloadState {
  phase: Phase;
  loaded: number;
  total: number;
  error?: string;
  tampered?: boolean;
}

export class VerificationError extends Error {
  constructor(
    message: string,
    public tampered: boolean,
  ) {
    super(message);
  }
}

let ed25519: Promise<boolean> | null = null;

export function ed25519Supported(): Promise<boolean> {
  ed25519 ??= crypto.subtle
    .importKey('raw', new Uint8Array(32), { name: 'Ed25519' }, false, ['verify'])
    .then(() => true)
    .catch((e: Error) => e.name !== 'NotSupportedError');
  return ed25519;
}

export function signedRecord(v: Version, file?: FileInfo): SignedFileRecord | null {
  const f = file ?? v.file;
  if (!f) return null;
  return {
    fileId: f.id,
    versionId: v.id,
    projectId: v.projectId,
    repoId: f.repoId,
    releaseId: f.releaseId,
    assetId: f.assetId,
    filename: f.filename,
    size: f.size,
    sha1: f.sha1,
    sha256: f.sha256,
    sha512: f.sha512,
  };
}

export async function signatureValid(v: Version, file?: FileInfo): Promise<boolean> {
  const f = file ?? v.file;
  const record = signedRecord(v, f ?? undefined);
  if (!record || !f || !SCAN_PUBLIC_KEY || !(await ed25519Supported())) return false;
  return verifyFileRecord(SCAN_PUBLIC_KEY, record, f.signature);
}

function reportIntegrity(versionId: string): void {
  fetch(`${API_URL}/v1/versions/${versionId}/integrity`, { method: 'POST', credentials: 'omit' }).catch(() => undefined);
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 150) || 'download.bin';
}

// The whole point of the site: never hand over bytes that don't match the scanned, signed fingerprint.
export async function verifiedDownload(v: Version, onState: (s: DownloadState) => void, signal?: AbortSignal, which?: FileInfo): Promise<void> {
  const file = which ?? v.file;
  const record = file ? signedRecord(v, file) : null;
  if (!record || !file) throw new VerificationError(t('This version has no verified file.'), false);
  const total = record.size;

  onState({ phase: 'signature', loaded: 0, total });
  if (!(await ed25519Supported())) {
    throw new VerificationError(t('Your browser is too old to check download signatures. Update it and try again.'), false);
  }
  if (!SCAN_PUBLIC_KEY || !(await verifyFileRecord(SCAN_PUBLIC_KEY, record, file.signature))) {
    reportIntegrity(v.id);
    throw new VerificationError(t('The fingerprint for this file is not signed by our scanner, so the download was blocked.'), true);
  }

  onState({ phase: 'connecting', loaded: 0, total });
  const res = await fetch(file.kind === 'primary' ? downloadUrl(v.id) : fileDownloadUrl(file.id), { credentials: 'omit', signal });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new VerificationError(body?.message ?? t('Download failed ({status}).', { status: res.status }), false);
  }

  const reader = res.body.getReader();
  const buffer = new Uint8Array(total);
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.byteLength > total) {
      await reader.cancel();
      reportIntegrity(v.id);
      throw new VerificationError(t('The file is larger than the scanned original, so the download was blocked.'), true);
    }
    buffer.set(value, loaded);
    loaded += value.byteLength;
    onState({ phase: 'downloading', loaded, total });
  }
  if (loaded !== total) {
    reportIntegrity(v.id);
    throw new VerificationError(t('The file is smaller than the scanned original, so the download was blocked.'), true);
  }

  onState({ phase: 'verifying', loaded, total });
  const [h256, h512] = await Promise.all([crypto.subtle.digest('SHA-256', buffer), crypto.subtle.digest('SHA-512', buffer)]);
  if (bytesToHex(h256) !== record.sha256 || bytesToHex(h512) !== record.sha512) {
    reportIntegrity(v.id);
    throw new VerificationError(t('The file does not match its scanned fingerprint. It may have been changed on GitHub, so the download was blocked.'), true);
  }

  onState({ phase: 'saving', loaded, total });
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName(record.filename);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  onState({ phase: 'done', loaded, total });
}
