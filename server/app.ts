import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { Core, normalizePhone, type Generate } from './core.js';
import type { Db } from './db.js';
import { assertPublicUrl, decrypt, DUMMY_HASH, encrypt, hashPassword, newToken, verifyPassword } from './security.js';
import { audit, LoginGuard } from './audit.js';
import { providers } from './providers.js';
import { registerModules } from './modules.js';
import { registerModules2 } from './modules2.js';

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { uid: string; aid: string }; user: { uid: string; aid: string; role?: string } }
}

const AGENT_WRITE = ['/api/chats', '/api/contacts', '/api/kanban', '/api/accounts', '/api/media', '/api/scheduled-messages'];

const anyObject = z.record(z.string(), z.any());
const REFS: Record<string, string> = { flow_id: 'flows', connection_id: 'connections', default_flow_id: 'flows', contact_id: 'contacts' };
const authLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

export interface AppOptions { db: Db; secret: string; publicUrl: string; internalUrl?: string; generate?: Generate; distDir?: string; rateLimitMax?: number }

// Política de conteúdo do navegador: só código do próprio site, nada de iframe, nada de <object>.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:", "font-src 'self' data:", "connect-src 'self' ws: wss:", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; core: Core }> {
  // trustProxy só com TRUST_PROXY=true (atrás de Caddy/Tailscale): sem isso o IP vem do cabeçalho forjável.
  const app = Fastify({ logger: false, bodyLimit: 24 * 1024 * 1024, trustProxy: process.env.TRUST_PROXY === 'true' });
  const db = opts.db;
  const core = new Core(db, opts.secret, opts.publicUrl, opts.generate, opts.internalUrl);
  const guard = new LoginGuard();
  // Webhooks ficam fora do limite geral (a Evolution manda rajadas); só as tentativas com token errado são contadas.
  const hookGuard = new LoginGuard(30, 60_000);
  /** Token de webhook errado: registra e responde 404; depois de 30 erros por minuto do mesmo IP responde 429 sem gravar (não enche o banco). */
  const badHook = (req: any, reply: any, provider: string) => {
    if (hookGuard.locked(req.ip)) return reply.code(429).send();
    void audit(db, hookGuard.fail(req.ip) ? 'webhook_flood' : 'webhook_bad_token', { ip: req.ip, detail: { provider } });
    return reply.code(404).send();
  };
  const https = opts.publicUrl.startsWith('https://');

  await app.register(jwt, { secret: opts.secret, sign: { expiresIn: '7d' } });
  // Limite geral por IP; webhooks (Evolution manda rajadas) e mídia ficam de fora, e as rotas de login têm limite próprio.
  await app.register(rateLimit, {
    global: false,
    onExceeded: (req) => void audit(db, 'rate_limited', { ip: req.ip, detail: { method: req.method, path: req.url.split('?')[0] } }),
  });
  // Roda antes da checagem de login (hooks da aplicação vêm antes dos da rota), para contar até quem chega sem token.
  app.addHook('onRequest', app.rateLimit({
    max: opts.rateLimitMax ?? Number(process.env.RATE_LIMIT_MAX ?? 300), timeWindow: '1 minute',
    allowList: (req: any) => /^\/(hooks|media)\//.test(req.url),
  }));

  // HTTPS: com PUBLIC_URL https, pedidos que chegam como http pelo proxy são redirecionados.
  app.addHook('onRequest', async (req, reply) => {
    if (https && req.headers['x-forwarded-proto'] === 'http' && !req.url.startsWith('/hooks/')) {
      return reply.code(308).header('location', `${opts.publicUrl}${req.url}`).send();
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff').header('x-frame-options', 'DENY').header('referrer-policy', 'no-referrer')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()').header('cross-origin-opener-policy', 'same-origin')
      .header('content-security-policy', req.url.startsWith('/media/') ? "default-src 'none'; sandbox" : CSP);
    if (!req.url.startsWith('/media/')) reply.header('cross-origin-resource-policy', 'same-origin');
    if (https || req.headers['x-forwarded-proto'] === 'https') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Dados inválidos', issues: err.issues });
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    if (status === 403 || (status === 401 && req.headers.authorization)) void audit(db, status === 403 ? 'forbidden' : 'auth_invalid', { accountId: (req.user as any)?.aid, ip: req.ip, detail: { method: req.method, path: req.url.split('?')[0] } });
    // 502 traz a resposta do serviço externo, que ajuda a resolver o problema.
    return reply.code(status).send({ error: status >= 500 && status !== 502 ? 'Erro interno' : err.message });
  });

  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || url.startsWith('/api/auth/')) return;
    await req.jwtVerify();
    const [m] = await db.query('SELECT role FROM memberships WHERE user_id = $1 AND account_id = $2', [req.user.uid, req.user.aid]);
    if (!m) throw Object.assign(new Error('Sem acesso a esta empresa'), { statusCode: 401 });
    req.user.role = m.role;
    if (req.method !== 'GET' && m.role === 'agent' && !AGENT_WRITE.some((p) => url.startsWith(p))) {
      throw Object.assign(new Error('Permissão insuficiente'), { statusCode: 403 });
    }
  });

  const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { statusCode: status }); };
  const assertOwned = async (table: string, id: unknown, aid: string) => {
    if (id == null) return;
    const rows = await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND account_id = $2`, [id, aid]);
    if (!rows.length) fail(400, 'Referência inválida');
  };

  function crud(route: string, table: string, schema: z.ZodObject<any>, jsonCols: string[] = [], order = 'created_at DESC') {
    const cast = (k: string, i: number) => `$${i}${jsonCols.includes(k) ? '::jsonb' : ''}`;
    const value = (k: string, v: unknown) => (jsonCols.includes(k) ? JSON.stringify(v) : v);
    const checkRefs = async (body: Record<string, unknown>, aid: string) => {
      for (const [k, t] of Object.entries(REFS)) if (k in body) await assertOwned(t, body[k], aid);
    };
    app.get(`/api/${route}`, async (req) => db.query(`SELECT * FROM ${table} WHERE account_id = $1 ORDER BY ${order} LIMIT 1000`, [req.user.aid]));
    app.get(`/api/${route}/:id`, async (req) => {
      const [row] = await db.query(`SELECT * FROM ${table} WHERE id = $1 AND account_id = $2`, [(req.params as any).id, req.user.aid]);
      return row ?? fail(404, 'Não encontrado');
    });
    app.post(`/api/${route}`, async (req, reply) => {
      const body = schema.parse(req.body) as Record<string, unknown>;
      await checkRefs(body, req.user.aid);
      const keys = Object.keys(body);
      const cols = ['account_id', ...keys].join(', ');
      const vals = ['$1', ...keys.map((k, i) => cast(k, i + 2))].join(', ');
      const [row] = await db.query(`INSERT INTO ${table} (${cols}) VALUES (${vals}) RETURNING *`, [req.user.aid, ...keys.map((k) => value(k, body[k]))]);
      return reply.code(201).send(row);
    });
    app.patch(`/api/${route}/:id`, async (req) => {
      const body = schema.partial().parse(req.body) as Record<string, unknown>;
      await checkRefs(body, req.user.aid);
      const keys = Object.keys(body);
      if (!keys.length) fail(400, 'Nada para atualizar');
      const set = keys.map((k, i) => `${k} = ${cast(k, i + 3)}`).join(', ');
      const [row] = await db.query(`UPDATE ${table} SET ${set} WHERE id = $1 AND account_id = $2 RETURNING *`,
        [(req.params as any).id, req.user.aid, ...keys.map((k) => value(k, body[k]))]);
      return row ?? fail(404, 'Não encontrado');
    });
    app.delete(`/api/${route}/:id`, async (req, reply) => {
      await db.query(`DELETE FROM ${table} WHERE id = $1 AND account_id = $2`, [(req.params as any).id, req.user.aid]);
      return reply.code(204).send();
    });
  }

  // Autenticação
  // Senha nova: mínimo 10 caracteres. No login a regra é frouxa de propósito, para quem já tem senha de 8.
  const strongPassword = z.string().min(10, 'A senha precisa ter pelo menos 10 caracteres').max(200);
  const loginBody = z.object({ email: z.email().toLowerCase(), password: z.string().min(1).max(200) });
  app.post('/api/auth/register', { config: authLimit }, async (req, reply) => {
    const body = z.object({ email: z.email().toLowerCase(), password: strongPassword, name: z.string().min(1).max(120), company: z.string().min(1).max(120) }).parse(req.body);
    // Cadastro aberto só na primeira instalação (nenhum usuário ainda) ou com ALLOW_REGISTRATION=true. Equipe entra por convite.
    const [{ n }] = await db.query('SELECT COUNT(*)::int AS n FROM users');
    if (n > 0 && process.env.ALLOW_REGISTRATION !== 'true') {
      void audit(db, 'register_blocked', { ip: req.ip });
      fail(403, 'Cadastro fechado. Peça um convite a quem administra o sistema.');
    }
    if ((await db.query('SELECT 1 FROM users WHERE email = $1', [body.email])).length) fail(409, 'E-mail já cadastrado');
    const [user] = await db.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [body.email, body.name, await hashPassword(body.password)]);
    const [account] = await db.query('INSERT INTO accounts (name) VALUES ($1) RETURNING id', [body.company]);
    await db.query('INSERT INTO memberships (user_id, account_id) VALUES ($1,$2)', [user.id, account.id]);
    return reply.code(201).send({ token: app.jwt.sign({ uid: user.id, aid: account.id }) });
  });
  app.post('/api/auth/login', { config: authLimit }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const wait = guard.locked(body.email);
    if (wait) return reply.code(429).header('retry-after', String(wait)).send({ error: 'Muitas tentativas. Tente de novo em alguns minutos.' });
    const [user] = await db.query('SELECT * FROM users WHERE email = $1', [body.email]);
    // Sempre calcula o hash (mesmo sem usuário) para o tempo de resposta não revelar se o e-mail existe.
    const valid = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      const [owner] = user ? await db.query('SELECT account_id FROM memberships WHERE user_id = $1 LIMIT 1', [user.id]) : [];
      void audit(db, 'login_failed', { accountId: owner?.account_id, ip: req.ip, detail: { email: body.email } });
      if (guard.fail(body.email) && owner) {
        await core.notify(owner.account_id, `Várias senhas erradas para ${user.email}. O login dele foi travado por 15 minutos.`);
        void audit(db, 'login_locked', { accountId: owner.account_id, ip: req.ip, detail: { email: body.email } });
      }
      fail(401, 'E-mail ou senha incorretos');
    }
    guard.ok(body.email);
    const [m] = await db.query('SELECT account_id FROM memberships WHERE user_id = $1 LIMIT 1', [user.id]);
    return { token: app.jwt.sign({ uid: user.id, aid: m.account_id }) };
  });
  app.get('/api/me', async (req) => {
    const [row] = await db.query(
      'SELECT u.name, u.email, a.name AS company, m.role FROM users u JOIN memberships m ON m.user_id = u.id JOIN accounts a ON a.id = m.account_id WHERE u.id = $1 AND a.id = $2',
      [req.user.uid, req.user.aid]);
    return row;
  });

  // Recursos simples
  crud('flows', 'flows', z.object({ name: z.string().min(1), folder: z.string().nullable().optional(), active: z.boolean().optional(), graph: anyObject.optional() }), ['graph']);
  crud('labels', 'labels', z.object({ name: z.string().min(1), color: z.string().optional() }));
  crud('quick-replies', 'quick_replies', z.object({ shortcut: z.string().min(1), body: z.string().min(1) }));
  crud('global-variables', 'global_variables', z.object({ key: z.string().regex(/^\w+$/), value: z.string() }));
  crud('ai-agents', 'ai_agents', z.object({ name: z.string().min(1), prompt: z.string().min(1), model: z.string().optional() }));
  crud('kanbans', 'kanbans', z.object({ name: z.string().min(1), columns: z.array(z.string()).min(1).optional() }), ['columns']);
  crud('sales', 'sales', z.object({ contact_id: z.uuid().nullable().optional(), product: z.string(), amount: z.number().nonnegative(), currency: z.string().length(3).optional() }));
  app.get('/api/notifications', async (req) => db.query('SELECT * FROM notifications WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.aid]));

  app.get('/api/flows/:id/stats', async (req) => {
    await assertOwned('flows', (req.params as any).id, req.user.aid);
    return db.query('SELECT node_id, entered, advanced FROM flow_node_stats WHERE flow_id = $1', [(req.params as any).id]);
  });

  // Contatos
  const contactBody = z.object({ name: z.string().default(''), phone: z.string().min(8), fields: anyObject.optional() });
  app.get('/api/contacts', async (req) => {
    const q = String((req.query as any).q ?? '');
    return db.query(
      `SELECT c.*, COALESCE((SELECT json_agg(l.name) FROM contact_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.contact_id = c.id), '[]') AS labels
       FROM contacts c WHERE c.account_id = $1 AND NOT c.is_simulator AND (c.name ILIKE $2 OR c.phone ILIKE $2) ORDER BY c.created_at DESC LIMIT 500`,
      [req.user.aid, `%${q}%`]);
  });
  app.post('/api/contacts', async (req, reply) => {
    const body = contactBody.parse(req.body);
    return reply.code(201).send(await core.upsertContact(req.user.aid, normalizePhone(body.phone), body.name, 'manual'));
  });
  app.patch('/api/contacts/:id', async (req) => {
    const body = z.object({ name: z.string().optional(), fields: anyObject.optional(), opted_out: z.boolean().optional() }).parse(req.body);
    const [row] = await db.query(
      `UPDATE contacts SET name = COALESCE($3, name), fields = COALESCE($4::jsonb, fields), opted_out = COALESCE($5, opted_out)
       WHERE id = $1 AND account_id = $2 RETURNING *`,
      [(req.params as any).id, req.user.aid, body.name ?? null, body.fields ? JSON.stringify(body.fields) : null, body.opted_out ?? null]);
    return row ?? fail(404, 'Não encontrado');
  });
  app.delete('/api/contacts/:id', async (req, reply) => {
    await db.query('DELETE FROM contacts WHERE id = $1 AND account_id = $2', [(req.params as any).id, req.user.aid]);
    return reply.code(204).send();
  });
  app.post('/api/contacts/import', async (req) => {
    const { csv } = z.object({ csv: z.string().max(5_000_000) }).parse(req.body);
    let imported = 0;
    for (const line of csv.split(/\r?\n/)) {
      const [a, b] = line.split(/[;,]/).map((s) => s.trim().replace(/^"|"$/g, ''));
      const [name, raw] = normalizePhone(b ?? '').length >= 8 ? [a, b] : ['', a];
      const phone = normalizePhone(raw ?? '');
      if (phone.length < 8) continue;
      await core.upsertContact(req.user.aid, phone, name, 'csv');
      imported++;
    }
    return { imported };
  });
  app.get('/api/contacts/export', async (req, reply) => {
    const rows = await db.query('SELECT name, phone FROM contacts WHERE account_id = $1 AND NOT is_simulator ORDER BY created_at', [req.user.aid]);
    const esc = (s: string) => `"${s.replaceAll('"', '""')}"`;
    return reply.type('text/csv').send(['nome,telefone', ...rows.map((r) => `${esc(r.name)},${esc(r.phone)}`)].join('\n'));
  });

  // Conexões
  // O App Secret da Meta fica cifrado dentro de config e nunca volta para o navegador.
  const safeConnection = (c: any) => {
    const { secret: _s, webhook_token: _t, ...rest } = c;
    const { app_secret_enc: appSecret, ...config } = c.config ?? {};
    return { ...rest, config, has_app_secret: Boolean(appSecret) };
  };
  const appSecretField = z.string().trim().min(8).max(200);
  const connectionFor = async (id: string, aid: string) => {
    const [c] = await db.query('SELECT * FROM connections WHERE id = $1 AND account_id = $2', [id, aid]);
    return c ?? fail(404, 'Conexão não encontrada');
  };
  app.get('/api/connections', async (req) => (await db.query('SELECT * FROM connections WHERE account_id = $1 AND NOT is_simulator ORDER BY created_at', [req.user.aid])).map(safeConnection));
  app.post('/api/connections', async (req, reply) => {
    const b = z.object({ name: z.string().min(1), provider: z.enum(['sandbox', 'evolution', 'meta']), config: anyObject.default({}), apiKey: z.string().optional(), appSecret: appSecretField.optional() }).parse(req.body);
    delete b.config.app_secret_enc; // só o servidor grava este campo
    if (b.appSecret) {
      if (b.provider !== 'meta') fail(400, 'App Secret só vale para a API Oficial (Meta)');
      b.config.app_secret_enc = encrypt(b.appSecret, opts.secret);
    }
    if (b.config.baseUrl !== undefined) {
      // Evolution própria: o servidor vai chamar esse endereço, então ele precisa ser público (barra rede interna e SSRF).
      if (b.provider !== 'evolution' || typeof b.config.baseUrl !== 'string' || !b.apiKey) fail(400, 'baseUrl só vale para Evolution própria e exige a chave dela');
      await assertPublicUrl(b.config.baseUrl).catch((e: Error) => { void audit(db, 'ssrf_blocked', { accountId: req.user.aid, ip: req.ip, detail: { where: 'connection.baseUrl' } }); fail(400, `Endereço da Evolution recusado: ${e.message}`); });
    }
    const limit = (await db.query('SELECT settings FROM accounts WHERE id = $1', [req.user.aid]))[0].settings.limits?.connections;
    if (limit) {
      const [c] = await db.query('SELECT COUNT(*)::int AS n FROM connections WHERE account_id = $1 AND NOT is_simulator', [req.user.aid]);
      if (c.n >= limit) fail(402, 'Limite de conexões do plano atingido');
    }
    const [row] = await db.query(
      `INSERT INTO connections (account_id, name, provider, config, secret, webhook_token, status) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
      [req.user.aid, b.name, b.provider, JSON.stringify(b.config), b.apiKey ? encrypt(b.apiKey, opts.secret) : null, newToken(), b.provider === 'sandbox' ? 'connected' : 'disconnected']);
    return reply.code(201).send(safeConnection(row));
  });
  app.patch('/api/connections/:id', async (req) => {
    const b = z.object({ name: z.string().optional(), default_flow_id: z.uuid().nullable().optional(), phone: z.string().regex(/^\d{8,15}$/, 'Use só números, com DDI').nullable().optional(), appSecret: appSecretField.optional() }).parse(req.body);
    await assertOwned('flows', b.default_flow_id, req.user.aid);
    const conn = await connectionFor((req.params as any).id, req.user.aid);
    if (b.appSecret) {
      if (conn.provider !== 'meta') fail(400, 'App Secret só vale para a API Oficial (Meta)');
      await db.query(`UPDATE connections SET config = config || jsonb_build_object('app_secret_enc', $2::text) WHERE id = $1`, [conn.id, encrypt(b.appSecret, opts.secret)]);
    }
    const welcome = b.default_flow_id === undefined ? conn.default_flow_id : b.default_flow_id;
    const [row] = await db.query('UPDATE connections SET name = $2, default_flow_id = $3, phone = $4 WHERE id = $1 RETURNING *',
      [conn.id, b.name ?? conn.name, welcome, b.phone === undefined ? conn.phone : b.phone]);
    if (b.default_flow_id !== undefined) {
      if (welcome) await db.query('INSERT INTO connection_flows (connection_id, slot, flow_id) VALUES ($1,$2,$3) ON CONFLICT (connection_id, slot) DO UPDATE SET flow_id = EXCLUDED.flow_id', [conn.id, 'welcome', welcome]);
      else await db.query(`DELETE FROM connection_flows WHERE connection_id = $1 AND slot = 'welcome'`, [conn.id]);
    }
    return safeConnection(row);
  });
  app.delete('/api/connections/:id', async (req, reply) => {
    const conn = await connectionFor((req.params as any).id, req.user.aid);
    await providers[conn.provider].remove?.(core.connectionInfo(conn)).catch((e: Error) => console.error('Falha ao remover instância:', e.message));
    await db.query('DELETE FROM connections WHERE id = $1 AND account_id = $2', [(req.params as any).id, req.user.aid]);
    return reply.code(204).send();
  });
  app.post('/api/connections/:id/connect', async (req) => {
    const conn = await connectionFor((req.params as any).id, req.user.aid);
    const result = await providers[conn.provider].connect(core.connectionInfo(conn)).catch((e: Error) => fail(502, e.message));
    await db.query('UPDATE connections SET status = $2 WHERE id = $1', [conn.id, result.status]);
    return { ...result, webhookUrl: conn.provider === 'meta' ? core.connectionInfo(conn).webhookUrl : undefined, verifyToken: conn.provider === 'meta' ? conn.webhook_token : undefined };
  });
  app.post('/api/connections/:id/refresh', async (req) => {
    const conn = await connectionFor((req.params as any).id, req.user.aid);
    const status = await providers[conn.provider].state(core.connectionInfo(conn)).catch((e: Error) => fail(502, e.message));
    await db.query('UPDATE connections SET status = $2 WHERE id = $1', [conn.id, status]);
    if (status === 'connected') await core.fillPhone(conn);
    return { status };
  });
  app.post('/api/connections/:id/disconnect', async (req) => {
    const conn = await connectionFor((req.params as any).id, req.user.aid);
    await providers[conn.provider].disconnect(core.connectionInfo(conn)).catch((e: Error) => fail(502, e.message));
    await db.query(`UPDATE connections SET status = 'disconnected' WHERE id = $1`, [conn.id]);
    return { status: 'disconnected' };
  });
  app.post('/api/connections/:id/simulate', async (req) => {
    const conn = await connectionFor((req.params as any).id, req.user.aid);
    if (conn.provider !== 'sandbox') fail(400, 'Disponível apenas no Sandbox');
    const b = z.object({ phone: z.string().min(8), name: z.string().optional(), text: z.string(), media: z.enum(['image', 'video', 'audio', 'document', 'sticker']).optional() }).parse(req.body);
    await core.handleInbound(conn, providers.sandbox.parse(b));
    return { ok: true };
  });

  // Webhooks de provedores
  app.get('/hooks/meta/:token', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const [c] = await db.query(`SELECT 1 FROM connections WHERE provider = 'meta' AND webhook_token = $1`, [(req.params as any).token]);
    if (!c || q['hub.verify_token'] !== (req.params as any).token) return reply.code(403).send();
    return reply.type('text/plain').send(q['hub.challenge']);
  });
  // Meta: confere a assinatura X-Hub-Signature-256 (HMAC do corpo bruto com o App Secret). Por isso esta rota lê o corpo sem converter.
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post('/hooks/meta/:token', async (req, reply) => {
      const [conn] = await db.query(`SELECT * FROM connections WHERE provider = 'meta' AND webhook_token = $1`, [(req.params as any).token]);
      if (!conn) return badHook(req, reply, 'meta');
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (conn.config?.app_secret_enc) {
        const expected = Buffer.from(`sha256=${nodeCrypto.createHmac('sha256', decrypt(conn.config.app_secret_enc, opts.secret)).update(raw).digest('hex')}`);
        const got = Buffer.from(String(req.headers['x-hub-signature-256'] ?? ''));
        if (got.length !== expected.length || !nodeCrypto.timingSafeEqual(got, expected)) {
          void audit(db, 'webhook_bad_signature', { accountId: conn.account_id, ip: req.ip, detail: { provider: 'meta' } });
          return reply.code(401).send();
        }
      }
      let body: unknown;
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return reply.code(400).send({ error: 'JSON inválido' }); }
      await core.handleInbound(conn, providers.meta.parse(body));
      return { ok: true };
    });
  });
  app.post('/hooks/in/:token', async (req, reply) => {
    const [hook] = await db.query('SELECT * FROM inbound_webhooks WHERE token = $1', [(req.params as any).token]);
    if (!hook) return badHook(req, reply, 'in');
    const body = (req.body ?? {}) as any;
    const pick = (p: string) => p.split('.').reduce((o: any, k) => o?.[k], body);
    const phone = normalizePhone(String(pick(hook.mapping.phone ?? 'phone') ?? ''));
    if (phone.length < 8) return reply.code(422).send({ error: 'Telefone não encontrado no payload' });
    const contact = await core.upsertContact(hook.account_id, phone, pick(hook.mapping.name ?? 'name'), 'webhook');
    if (contact.opted_out) return { skipped: 'opted_out' };
    const chat = await core.ensureChat(hook.account_id, contact.id, hook.connection_id);
    await core.engine.start(hook.flow_id, chat.id, hook.account_id, { webhook: body });
    return { ok: true };
  });
  app.post('/hooks/:provider/:token', async (req, reply) => {
    const { provider, token } = req.params as any;
    const p = providers[provider];
    if (!p || provider === 'sandbox') return reply.code(404).send();
    const [conn] = await db.query('SELECT * FROM connections WHERE provider = $1 AND webhook_token = $2', [provider, token]);
    if (!conn) return badHook(req, reply, provider);
    await core.handleInbound(conn, p.parse(req.body));
    return { ok: true };
  });

  // Chats
  app.get('/api/chats', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status || undefined;
    return db.query(
      `SELECT ch.*, c.name AS contact_name, c.phone AS contact_phone, cn.name AS connection_name
       FROM chats ch JOIN contacts c ON c.id = ch.contact_id JOIN connections cn ON cn.id = ch.connection_id
       WHERE ch.account_id = $1 AND NOT c.is_simulator AND ($2::text IS NULL OR ch.status = $2)
         AND ($3::text IS NULL OR ch.department = $3)
         AND (NOT $4::boolean OR ch.unread > 0)
         AND (NOT $5::boolean OR (SELECT m.direction FROM messages m WHERE m.chat_id = ch.id ORDER BY m.created_at DESC LIMIT 1) = 'in')
         AND ($6::text IS NULL OR c.name ILIKE $6 OR c.phone ILIKE $6)
       ORDER BY ch.last_message_at DESC NULLS LAST LIMIT 200`,
      [req.user.aid, status ?? null, q.department ?? null, q.filter === 'unread', q.filter === 'unanswered', q.q ? `%${q.q}%` : null]);
  });
  const chatFor = async (id: string, aid: string) => {
    const [c] = await db.query('SELECT * FROM chats WHERE id = $1 AND account_id = $2', [id, aid]);
    return c ?? fail(404, 'Chat não encontrado');
  };
  app.get('/api/chats/:id/messages', async (req) => {
    const chat = await chatFor((req.params as any).id, req.user.aid);
    await db.query('UPDATE chats SET unread = 0 WHERE id = $1', [chat.id]);
    return db.query('SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at LIMIT 500', [chat.id]);
  });
  app.post('/api/chats/:id/messages', async (req, reply) => {
    const chat = await chatFor((req.params as any).id, req.user.aid);
    const { text } = z.object({ text: z.string().min(1).max(4096) }).parse(req.body);
    await db.query(`UPDATE flow_runs SET status = 'cancelled' WHERE chat_id = $1 AND status IN ('running','waiting')`, [chat.id]);
    await db.query(`UPDATE chats SET status = 'open', unread = 0 WHERE id = $1`, [chat.id]);
    return reply.code(201).send(await core.send(chat.id, { type: 'text', text }).catch((e: Error) => fail(502, e.message)));
  });
  app.patch('/api/chats/:id', async (req) => {
    const chat = await chatFor((req.params as any).id, req.user.aid);
    const b = z.object({ status: z.enum(['waiting', 'open', 'resolved']) }).parse(req.body);
    const [row] = await db.query('UPDATE chats SET status = $2 WHERE id = $1 RETURNING *', [chat.id, b.status]);
    if (b.status === 'resolved') {
      await db.query(`UPDATE flow_runs SET status = 'cancelled' WHERE chat_id = $1 AND status IN ('running','waiting')`, [chat.id]);
      await core.engine.startSlot(chat.connection_id, 'ended', chat);
    }
    return row;
  });

  // Kanban
  app.get('/api/kanbans/:id/cards', async (req) => {
    await assertOwned('kanbans', (req.params as any).id, req.user.aid);
    return db.query(`SELECT k.*, c.name AS contact_name, c.phone AS contact_phone FROM kanban_cards k JOIN contacts c ON c.id = k.contact_id WHERE k.kanban_id = $1 ORDER BY k.created_at`, [(req.params as any).id]);
  });
  app.post('/api/kanbans/:id/cards', async (req, reply) => {
    const b = z.object({ contact_id: z.uuid(), column_name: z.string().min(1) }).parse(req.body);
    await assertOwned('kanbans', (req.params as any).id, req.user.aid);
    await assertOwned('contacts', b.contact_id, req.user.aid);
    const [row] = await db.query(
      `INSERT INTO kanban_cards (account_id, kanban_id, contact_id, column_name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (kanban_id, contact_id) DO UPDATE SET column_name = EXCLUDED.column_name RETURNING *`,
      [req.user.aid, (req.params as any).id, b.contact_id, b.column_name]);
    return reply.code(201).send(row);
  });
  app.patch('/api/kanban-cards/:id', async (req) => {
    const b = z.object({ column_name: z.string().min(1) }).parse(req.body);
    const [row] = await db.query('UPDATE kanban_cards SET column_name = $3 WHERE id = $1 AND account_id = $2 RETURNING *', [(req.params as any).id, req.user.aid, b.column_name]);
    return row ?? fail(404, 'Não encontrado');
  });

  // Disparos em massa
  app.get('/api/dispatches', async (req) => db.query(
    `SELECT d.*, f.name AS flow_name, COUNT(i.*)::int AS total,
       COUNT(*) FILTER (WHERE i.status = 'sent')::int AS sent,
       COUNT(*) FILTER (WHERE i.status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE i.status = 'skipped')::int AS skipped
     FROM dispatches d JOIN flows f ON f.id = d.flow_id LEFT JOIN dispatch_items i ON i.dispatch_id = d.id
     WHERE d.account_id = $1 GROUP BY d.id, f.name ORDER BY d.created_at DESC`, [req.user.aid]));
  app.post('/api/dispatches', async (req, reply) => {
    const b = z.object({ name: z.string().min(1), flow_id: z.uuid(), connection_id: z.uuid(), label_id: z.uuid().nullable().optional(), per_minute: z.number().int().min(1).max(60).default(20) }).parse(req.body);
    await assertOwned('flows', b.flow_id, req.user.aid);
    await assertOwned('connections', b.connection_id, req.user.aid);
    await assertOwned('labels', b.label_id, req.user.aid);
    const [d] = await db.query('INSERT INTO dispatches (account_id, name, flow_id, connection_id, per_minute) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.aid, b.name, b.flow_id, b.connection_id, b.per_minute]);
    await db.query(
      `INSERT INTO dispatch_items (dispatch_id, contact_id)
       SELECT $1, c.id FROM contacts c WHERE c.account_id = $2 AND NOT c.opted_out AND NOT c.is_simulator
       AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM contact_labels cl WHERE cl.contact_id = c.id AND cl.label_id = $3::uuid))`,
      [d.id, req.user.aid, b.label_id ?? null]);
    const quota = (await db.query('SELECT settings FROM accounts WHERE id = $1', [req.user.aid]))[0].settings.limits?.dispatches;
    if (quota) {
      const [used] = await db.query(`SELECT COUNT(i.*)::int AS n FROM dispatch_items i JOIN dispatches x ON x.id = i.dispatch_id WHERE x.account_id = $1 AND x.created_at >= date_trunc('month', now())`, [req.user.aid]);
      if (used.n > quota) {
        await db.query('DELETE FROM dispatches WHERE id = $1', [d.id]);
        fail(402, `Cota mensal de ${quota} disparos excedida`);
      }
    }
    await core.enqueue('dispatch.tick', { id: d.id });
    return reply.code(201).send(d);
  });
  app.post('/api/dispatches/:id/cancel', async (req) => {
    const [row] = await db.query(`UPDATE dispatches SET status = 'cancelled' WHERE id = $1 AND account_id = $2 RETURNING *`, [(req.params as any).id, req.user.aid]);
    return row ?? fail(404, 'Não encontrado');
  });

  // Webhooks de entrada
  app.get('/api/inbound-webhooks', async (req) => (await db.query('SELECT * FROM inbound_webhooks WHERE account_id = $1 ORDER BY created_at DESC', [req.user.aid]))
    .map((w) => ({ ...w, url: `${opts.publicUrl}/hooks/in/${w.token}` })));
  app.post('/api/inbound-webhooks', async (req, reply) => {
    const b = z.object({ name: z.string().min(1), flow_id: z.uuid(), connection_id: z.uuid(), mapping: anyObject.optional() }).parse(req.body);
    await assertOwned('flows', b.flow_id, req.user.aid);
    await assertOwned('connections', b.connection_id, req.user.aid);
    const [row] = await db.query(
      `INSERT INTO inbound_webhooks (account_id, name, token, flow_id, connection_id, mapping) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [req.user.aid, b.name, newToken(), b.flow_id, b.connection_id, JSON.stringify(b.mapping ?? { phone: 'phone', name: 'name' })]);
    return reply.code(201).send({ ...row, url: `${opts.publicUrl}/hooks/in/${row.token}` });
  });
  app.delete('/api/inbound-webhooks/:id', async (req, reply) => {
    await db.query('DELETE FROM inbound_webhooks WHERE id = $1 AND account_id = $2', [(req.params as any).id, req.user.aid]);
    return reply.code(204).send();
  });

  // Dashboard
  app.get('/api/dashboard', async (req) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).parse((req.query as any).days);
    const aid = req.user.aid;
    const [leads] = await db.query(`SELECT COUNT(*)::int AS n FROM contacts WHERE account_id = $1 AND NOT is_simulator AND created_at > now() - ($2 || ' days')::interval`, [aid, String(days)]);
    const [sales] = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS revenue FROM sales WHERE account_id = $1 AND created_at > now() - ($2 || ' days')::interval`, [aid, String(days)]);
    const byDay = await db.query(`SELECT to_char(created_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n, SUM(amount)::float AS revenue FROM sales WHERE account_id = $1 AND created_at > now() - ($2 || ' days')::interval GROUP BY 1 ORDER BY 1`, [aid, String(days)]);
    const chats = await db.query('SELECT status, COUNT(*)::int AS n FROM chats WHERE account_id = $1 GROUP BY status', [aid]);
    const [runs] = await db.query(`SELECT COUNT(*) FILTER (WHERE status IN ('running','waiting'))::int AS active, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed FROM flow_runs WHERE account_id = $1`, [aid]);
    return { leads: leads.n, sales: sales.n, revenue: sales.revenue, ticket: sales.n ? sales.revenue / sales.n : 0, conversion: leads.n ? sales.n / leads.n : 0, byDay, chats, runs };
  });

  const helpers = { crud, assertOwned, fail, secret: opts.secret, publicUrl: opts.publicUrl, guard, badHook };
  registerModules(app, core, helpers);
  registerModules2(app, core, helpers);

  // Frontend compilado
  if (opts.distDir && fs.existsSync(path.join(opts.distDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: opts.distDir });
    app.setNotFoundHandler((req, reply) => {
      // Pedido de arquivo (.env, .git, .php...) não vira a página do app: 404 seco, sem dar pista a scanners.
      if (req.url.startsWith('/api/') || req.url.startsWith('/hooks/') || /\.[a-z0-9]{1,8}$/i.test(req.url.split('?')[0]) || /(^|\/)\.[^/]/.test(req.url.split('?')[0])) return reply.code(404).send({ error: 'Não encontrado' });
      return reply.sendFile('index.html');
    });
  }

  return { app, core };
}
