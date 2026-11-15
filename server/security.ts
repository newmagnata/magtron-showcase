import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** scrypt assíncrono: não trava o servidor enquanto calcula a senha. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Hash de mentira: login de e-mail inexistente gasta o mesmo tempo que o de e-mail real (evita descobrir quem tem conta). */
export const DUMMY_HASH = `${'00'.repeat(16)}:${'00'.repeat(64)}`;

const key = (secret: string) => crypto.createHash('sha256').update(secret).digest();

export function encrypt(text: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function decrypt(value: string, secret: string): string {
  const [iv, tag, body] = value.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

export const newToken = () => crypto.randomBytes(24).toString('base64url');

function isPrivate(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Blocks flow HTTP blocks from reaching the server's own private network. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('URL inválida'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Protocolo não permitido');
  if (process.env.ALLOW_PRIVATE_URLS === 'true') return url; // só para testes e desenvolvimento
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (ips.some(isPrivate)) throw new Error('Endereço privado não permitido');
  return url;
}

// ---- Uploads -----------------------------------------------------------------------------------------------

/** Tipos aceitos no upload. O que não está aqui é recusado; só o que está em INLINE_OK abre no navegador. */
export const UPLOAD_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'video/mp4', 'video/quicktime', 'video/3gpp',
  'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/webm',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
]);

const ascii = (b: Uint8Array, from: number, to: number) => Buffer.from(b.subarray(from, to)).toString('latin1');

/** Confere os primeiros bytes do arquivo: o tipo declarado precisa bater com o conteúdo real. */
export function contentMatchesType(mime: string, b: Uint8Array): boolean {
  if (b.length < 12) return mime.startsWith('text/');
  switch (mime) {
    case 'image/png': return ascii(b, 1, 4) === 'PNG';
    case 'image/jpeg': return b[0] === 0xff && b[1] === 0xd8;
    case 'image/gif': return ascii(b, 0, 3) === 'GIF';
    case 'image/webp': return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP';
    case 'video/mp4': case 'video/quicktime': case 'video/3gpp': case 'audio/mp4': return ascii(b, 4, 8) === 'ftyp';
    case 'audio/mpeg': return ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case 'audio/ogg': return ascii(b, 0, 4) === 'OggS';
    case 'audio/wav': case 'audio/x-wav': return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE';
    case 'audio/aac': return (b[0] === 0xff && (b[1] & 0xf0) === 0xf0) || ascii(b, 4, 8) === 'ftyp';
    case 'audio/webm': return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case 'application/pdf': return ascii(b, 0, 4) === '%PDF';
    case 'application/zip': case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return ascii(b, 0, 2) === 'PK';
    case 'application/msword': case 'application/vnd.ms-excel': return b[0] === 0xd0 && b[1] === 0xcf;
    default: return true; // texto simples: não há assinatura
  }
}

/** Nome seguro para guardar e devolver em cabeçalhos: sem pasta, sem caracteres de controle. */
export const cleanFilename = (name: string) =>
  name.replace(/[\\/]+/g, '_').replace(/[\u0000-\u001f\u007f"<>|?*:]/g, '').replace(/^\.+/, '').trim().slice(0, 120) || 'arquivo';
