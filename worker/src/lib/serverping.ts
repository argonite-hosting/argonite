// Minecraft Java "server list ping" over a raw TCP socket: the same handshake the multiplayer screen
// does. Only status is read; nothing is ever sent to the server beyond that.
import { connect } from 'cloudflare:sockets';

export interface PingResult {
  online: boolean;
  playersOnline: number | null;
  playersMax: number | null;
  version: string | null;
  motd: string | null;
  favicon: string | null;
}

const TIMEOUT_MS = 5000;
const MAX_RESPONSE = 256 * 1024;

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

function packet(id: number, body: number[]): Uint8Array {
  const payload = [...varint(id), ...body];
  return new Uint8Array([...varint(payload.length), ...payload]);
}

function readVarint(buf: Uint8Array, offset: number): [number, number] | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [value >>> 0, offset + i + 1];
  }
  throw new Error('bad varint');
}

type Chat = string | { text?: string; extra?: Chat[]; translate?: string };

function flatten(c: Chat | undefined, depth = 0): string {
  if (!c || depth > 8) return '';
  if (typeof c === 'string') return c;
  return `${c.text ?? ''}${(c.extra ?? []).map((e) => flatten(e, depth + 1)).join('')}`;
}

export function cleanMotd(raw: Chat | undefined): string {
  return flatten(raw)
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
}

// Rejects addresses that point at private or local networks.
export function validHost(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253) return 'Enter the server address.';
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return 'That address is not reachable from the internet.';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some((x) => Number(x) > 255)) return 'Invalid IP address.';
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224 || (a === 100 && b >= 64 && b <= 127)) {
      return 'That address is not reachable from the internet.';
    }
    return null;
  }
  if (h.includes(':')) return 'Use a hostname or IPv4 address.';
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return 'Enter a valid hostname, like play.example.com.';
  return null;
}

async function srv(host: string): Promise<{ host: string; port: number } | null> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=_minecraft._tcp.${encodeURIComponent(host)}&type=SRV`, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
    const rec = data.Answer?.find((a) => a.type === 33);
    if (!rec) return null;
    const [, , port, target] = rec.data.split(' ');
    const p = Number(port);
    const t = (target ?? '').replace(/\.$/, '');
    return t && p > 0 && p < 65536 ? { host: t, port: p } : null;
  } catch {
    return null;
  }
}

export async function pingJava(host: string, port: number): Promise<PingResult> {
  const offline: PingResult = { online: false, playersOnline: null, playersMax: null, version: null, motd: null, favicon: null };
  const viaSrv = port === 25565 ? await srv(host) : null;
  const target = viaSrv && !validHost(viaSrv.host) ? viaSrv : { host, port };
  let socket: ReturnType<typeof connect> | null = null;
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS));
  try {
    socket = connect({ hostname: target.host, port: target.port });
    const writer = socket.writable.getWriter();
    const hostBytes = [...new TextEncoder().encode(host.slice(0, 255))];
    await Promise.race([
      writer.write(packet(0, [...varint(767), ...varint(hostBytes.length), ...hostBytes, (port >> 8) & 0xff, port & 0xff, ...varint(1)])),
      timer,
    ]);
    await Promise.race([writer.write(packet(0, [])), timer]);
    const reader = socket.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timer]);
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
      if (total > MAX_RESPONSE) throw new Error('response too large');
      const buf = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        buf.set(c, o);
        o += c.length;
      }
      const len = readVarint(buf, 0);
      if (!len || buf.length < len[1] + len[0]) continue;
      const id = readVarint(buf, len[1]);
      const strLen = id ? readVarint(buf, id[1]) : null;
      if (!id || id[0] !== 0 || !strLen) throw new Error('unexpected packet');
      const json = JSON.parse(new TextDecoder().decode(buf.subarray(strLen[1], strLen[1] + strLen[0]))) as {
        players?: { online?: number; max?: number };
        version?: { name?: string };
        description?: Chat;
        favicon?: string;
      };
      const favicon = typeof json.favicon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(json.favicon) && json.favicon.length <= 24_000 ? json.favicon : null;
      return {
        online: true,
        playersOnline: Number.isFinite(json.players?.online) ? Math.max(0, Math.min(1_000_000, json.players!.online!)) : null,
        playersMax: Number.isFinite(json.players?.max) ? Math.max(0, Math.min(1_000_000, json.players!.max!)) : null,
        version: typeof json.version?.name === 'string' ? cleanMotd(json.version.name).slice(0, 64) : null,
        motd: cleanMotd(json.description),
        favicon,
      };
    }
    return offline;
  } catch {
    return offline;
  } finally {
    socket?.close().catch(() => undefined);
  }
}
