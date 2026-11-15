import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Core } from './core.js';
import type { ModuleHelpers } from './modules.js';
import { encrypt } from './security.js';
import { audit } from './audit.js';
import { handleMcp } from './mcp.js';

const SLOTS = ['welcome', 'default', 'finished', 'ended'] as const;
const PLATFORMS = ['tiktok', 'kwai', 'google', 'meta'] as const;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Weighted draw among connections; callers pass only usable ones. */
export function pickWeighted<T extends { percent: number }>(items: T[], roll = Math.random()): T | undefined {
  const total = items.reduce((a, i) => a + i.percent, 0);
  if (!total) return items[0];
  let r = roll * total;
  return items.find((i) => (r -= i.percent) < 0) ?? items.at(-1);
}

/** Inserts the attribution code after the 5th character, as in "Olá, <code> gostaria…". */
export const withCode = (message: string, code: string) => `${message.slice(0, 5)}${code} ${message.slice(5).trimStart()}`;

export function registerModules2(app: FastifyInstance, core: Core, h: ModuleHelpers) {
  const { db } = core;
  const { assertOwned, fail } = h;
  const needAdmin = (req: any) => { if (req.user.role === 'agent') fail(403, 'Permissão insuficiente'); };
  const ownConn = async (id: string, aid: string) => (await db.query('SELECT * FROM connections WHERE id = $1 AND account_id = $2', [id, aid]))[0] ?? fail(404, 'Conexão não encontrada');

  // Fluxos padrões e palavras-chave
  app.get('/api/connection-flows', async (req) => db.query(
    `SELECT s.connection_id, s.slot, s.flow_id FROM connection_flows s JOIN connections c ON c.id = s.connection_id WHERE c.account_id = $1`, [req.user.aid]));
  app.get('/api/connection-keywords', async (req) => db.query(
    `SELECT k.id, k.connection_id, k.keyword, k.flow_id FROM connection_keywords k JOIN connections c ON c.id = k.connection_id WHERE c.account_id = $1 ORDER BY k.created_at`, [req.user.aid]));
  app.put('/api/connections/:id/flows', async (req) => {
    needAdmin(req);
    const conn = await ownConn((req.params as any).id, req.user.aid);
    const b = z.object({ welcome: z.uuid().nullable(), default: z.uuid().nullable(), finished: z.uuid().nullable(), ended: z.uuid().nullable() }).partial().parse(req.body);
    for (const slot of SLOTS) {
      if (!(slot in b)) continue;
      const flow = b[slot];
      await assertOwned('flows', flow, req.user.aid);
      if (flow) await db.query('INSERT INTO connection_flows (connection_id, slot, flow_id) VALUES ($1,$2,$3) ON CONFLICT (connection_id, slot) DO UPDATE SET flow_id = EXCLUDED.flow_id', [conn.id, slot, flow]);
      else await db.query('DELETE FROM connection_flows WHERE connection_id = $1 AND slot = $2', [conn.id, slot]);
      if (slot === 'welcome') await db.query('UPDATE connections SET default_flow_id = $2 WHERE id = $1', [conn.id, flow]);
    }
    return { ok: true };
  });
  app.post('/api/connections/:id/keywords', async (req, reply) => {
    needAdmin(req);
    const conn = await ownConn((req.params as any).id, req.user.aid);
    const b = z.object({ keyword: z.string().trim().min(2).max(60), flow_id: z.uuid() }).parse(req.body);
    await assertOwned('flows', b.flow_id, req.user.aid);
    const [row] = await db.query(
      `INSERT INTO connection_keywords (connection_id, keyword, flow_id) VALUES ($1,$2,$3)
       ON CONFLICT (connection_id, keyword) DO UPDATE SET flow_id = EXCLUDED.flow_id RETURNING id, connection_id, keyword, flow_id`, [conn.id, b.keyword.toLowerCase(), b.flow_id]);
    return reply.code(201).send(row);
  });
  app.delete('/api/connection-keywords/:id', async (req, reply) => {
    needAdmin(req);
    await db.query('DELETE FROM connection_keywords k USING connections c WHERE k.id = $1 AND c.id = k.connection_id AND c.account_id = $2', [(req.params as any).id, req.user.aid]);
    return reply.code(204).send();
  });

  // Pastas de fluxos
  app.get('/api/flow-folders', async (req) => (await db.query(
    `SELECT name FROM flow_folders WHERE account_id = $1 UNION SELECT folder FROM flows WHERE account_id = $1 AND folder IS NOT NULL ORDER BY 1`, [req.user.aid])).map((r) => r.name as string));
  app.post('/api/flow-folders', async (req, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    await db.query('INSERT INTO flow_folders (account_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.aid, name]);
    return reply.code(201).send({ name });
  });
  app.delete('/api/flow-folders/:name', async (req, reply) => {
    const name = (req.params as any).name as string;
    await db.query('UPDATE flows SET folder = NULL WHERE account_id = $1 AND folder = $2', [req.user.aid, name]);
    await db.query('DELETE FROM flow_folders WHERE account_id = $1 AND name = $2', [req.user.aid, name]);
    return reply.code(204).send();
  });

  // Trackeamento
  app.get('/api/tracking/pixels', async (req) => { needAdmin(req); return db.query('SELECT id, name, platform, pixel_code, secret IS NOT NULL AS has_token FROM tracking_pixels WHERE account_id = $1 ORDER BY created_at DESC', [req.user.aid]); });
  app.post('/api/tracking/pixels', async (req, reply) => {
    needAdmin(req);
    const b = z.object({ name: z.string().trim().min(1).max(80), platform: z.enum(PLATFORMS), pixel_code: z.string().trim().min(1).max(120), token: z.string().min(1).optional() }).parse(req.body);
    const [row] = await db.query('INSERT INTO tracking_pixels (account_id, name, platform, pixel_code, secret) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, platform, pixel_code', [req.user.aid, b.name, b.platform, b.pixel_code, b.token ? encrypt(b.token, h.secret) : null]);
    return reply.code(201).send(row);
  });
  app.delete('/api/tracking/pixels/:id', async (req, reply) => { needAdmin(req); await db.query('DELETE FROM tracking_pixels WHERE id = $1 AND account_id = $2', [(req.params as any).id, req.user.aid]); return reply.code(204).send(); });

  app.get('/api/tracking/links', async (req) => {
    needAdmin(req);
    return (await db.query(
      `SELECT l.*, (SELECT count(*)::int FROM tracking_clicks c WHERE c.link_id = l.id) AS clicks,
              (SELECT count(*)::int FROM tracking_clicks c WHERE c.link_id = l.id AND c.contact_id IS NOT NULL) AS leads
       FROM tracking_links l WHERE l.account_id = $1 ORDER BY l.created_at DESC`, [req.user.aid])).map((l) => ({ ...l, url: `${h.publicUrl}/t/${l.slug}` }));
  });
  app.post('/api/tracking/links', async (req, reply) => {
    needAdmin(req);
    const b = z.object({
      name: z.string().trim().min(1).max(80), platform: z.enum(PLATFORMS), pixel_id: z.uuid().nullable().optional(),
      message: z.string().trim().min(6, 'A frase precisa ter pelo menos 6 caracteres').max(300),
      distribution: z.array(z.object({ connection_id: z.uuid(), percent: z.number().int().min(1).max(100) })).min(1, 'Escolha ao menos uma conexão'),
      fallback: z.enum(['random', 'none']).default('random'),
    }).parse(req.body);
    if (b.distribution.reduce((a, d) => a + d.percent, 0) !== 100) fail(400, 'A soma dos percentuais tem que ser 100');
    for (const d of b.distribution) await assertOwned('connections', d.connection_id, req.user.aid);
    await assertOwned('tracking_pixels', b.pixel_id, req.user.aid);
    const slug = crypto.randomBytes(5).toString('hex');
    const [row] = await db.query(
      `INSERT INTO tracking_links (account_id, name, platform, pixel_id, slug, message, distribution, fallback) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [req.user.aid, b.name, b.platform, b.pixel_id ?? null, slug, b.message, JSON.stringify(b.distribution), b.fallback]);
    return reply.code(201).send({ ...row, url: `${h.publicUrl}/t/${slug}` });
  });
  app.delete('/api/tracking/links/:id', async (req, reply) => { needAdmin(req); await db.query('DELETE FROM tracking_links WHERE id = $1 AND account_id = $2', [(req.params as any).id, req.user.aid]); return reply.code(204).send(); });

  /** Public link used in ads: registers the click and sends the visitor to WhatsApp. */
  app.get('/t/:slug', async (req, reply) => {
    const [link] = await db.query('SELECT * FROM tracking_links WHERE slug = $1', [(req.params as any).slug]);
    if (!link) return reply.code(404).type('text/plain').send('Link não encontrado');
    const conns = await db.query('SELECT id, phone, status FROM connections WHERE account_id = $1 AND phone IS NOT NULL AND NOT is_simulator', [link.account_id]);
    const wanted = (link.distribution as { connection_id: string; percent: number }[]).map((d) => ({ ...d, conn: conns.find((c) => c.id === d.connection_id) })).filter((d) => d.conn);
    let target = pickWeighted(wanted.filter((d) => d.conn.status === 'connected'))?.conn;
    if (!target && link.fallback === 'random') target = conns.find((c) => c.status === 'connected') ?? wanted[0]?.conn;
    if (!target) return reply.code(503).type('text/plain').send('Nenhum número disponível no momento');
    const code = crypto.randomBytes(3).toString('hex');
    const params = Object.fromEntries(Object.entries(req.query as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 200)]).slice(0, 20));
    await db.query('INSERT INTO tracking_clicks (account_id, link_id, code, params) VALUES ($1,$2,$3,$4::jsonb)', [link.account_id, link.id, code, JSON.stringify(params)]);
    return reply.redirect(`https://wa.me/${String(target.phone).replace(/\D/g, '')}?text=${encodeURIComponent(withCode(link.message, code))}`, 302);
  });

  // Servidor MCP
  app.get('/api/mcp/info', async (req) => { needAdmin(req); return { url: `${h.publicUrl}/mcp` }; });
  app.get('/api/mcp/credentials', async (req) => { needAdmin(req); return db.query('SELECT id, name, token_prefix, last_used_at, created_at FROM mcp_credentials WHERE account_id = $1 ORDER BY created_at DESC', [req.user.aid]); });
  app.post('/api/mcp/credentials', async (req, reply) => {
    needAdmin(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const token = `mgt_${crypto.randomBytes(32).toString('base64url')}`;
    const [row] = await db.query('INSERT INTO mcp_credentials (account_id, name, token_hash, token_prefix) VALUES ($1,$2,$3,$4) RETURNING id, name, token_prefix, created_at', [req.user.aid, name, sha(token), token.slice(0, 8)]);
    return reply.code(201).send({ ...row, token });
  });
  app.delete('/api/mcp/credentials/:id', async (req, reply) => { needAdmin(req); await db.query('DELETE FROM mcp_credentials WHERE id = $1 AND account_id = $2', [(req.params as any).id, req.user.aid]); return reply.code(204).send(); });

  // Atividade suspeita registrada (logins errados, bloqueios, rotas proibidas, uploads recusados...). Só administradores.
  app.get('/api/security/events', async (req) => {
    needAdmin(req);
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse((req.query as any).limit);
    return db.query('SELECT id, kind, ip, detail, created_at FROM security_events WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2', [req.user.aid, limit]);
  });

  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST' }));
  app.post('/mcp', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const bearer = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const [cred] = bearer ? await db.query('UPDATE mcp_credentials SET last_used_at = now() WHERE token_hash = $1 RETURNING account_id', [sha(bearer)]) : [];
    if (!cred) {
      void audit(db, 'mcp_bad_credential', { ip: req.ip, detail: { had_token: Boolean(bearer) } });
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Credencial inválida' });
    }
    // Proteção contra DNS rebinding: o MCP é chamado por programas, não por páginas de outros sites.
    const origin = req.headers.origin;
    let sameHost = false;
    try { sameHost = Boolean(origin) && new URL(origin!).host === req.headers.host; } catch { /* Origin malformado: recusa com 403, não 500 */ }
    if (origin && origin !== h.publicUrl && !sameHost) return reply.code(403).send({ error: 'Origem não permitida' });
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.slice(0, 20).map((m) => handleMcp(core, cred.account_id, m)))).filter((x) => x !== null);
      return out.length ? out : reply.code(202).send();
    }
    const out = await handleMcp(core, cred.account_id, body);
    return out === null ? reply.code(202).send() : out;
  });
}
