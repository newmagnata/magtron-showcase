import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Core } from './core.js';
import { normalizePhone } from './core.js';
import { cleanFilename, contentMatchesType, encrypt, hashPassword, newToken, UPLOAD_TYPES, verifyPassword } from './security.js';
import { audit, type LoginGuard } from './audit.js';
import { providers } from './providers.js';
import { createMetaTemplate, getPaymentStatus, metaInsights, syncMetaTemplates } from './integrations.js';

export interface ModuleHelpers {
  crud: (route: string, table: string, schema: z.ZodObject<any>, jsonCols?: string[], order?: string) => void;
  assertOwned: (table: string, id: unknown, aid: string) => Promise<void>;
  fail: (status: number, message: string) => never;
  secret: string;
  publicUrl: string;
  /** Trava por e-mail depois de várias senhas erradas (a mesma do login). */
  guard: LoginGuard;
  /** Resposta padrão para webhook com token errado: registra e, em rajada, responde 429. */
  badHook: (req: any, reply: any, provider: string) => unknown;
}

const DDD: Record<string, number[]> = {
  SP: [11, 12, 13, 14, 15, 16, 17, 18, 19], RJ: [21, 22, 24], ES: [27, 28], MG: [31, 32, 33, 34, 35, 37, 38], PR: [41, 42, 43, 44, 45, 46],
  SC: [47, 48, 49], RS: [51, 53, 54, 55], DF: [61], GO: [62, 64], TO: [63], MT: [65, 66], MS: [67], AC: [68], RO: [69], BA: [71, 73, 74, 75, 77],
  SE: [79], PE: [81, 87], AL: [82], PB: [83], RN: [84], CE: [85, 88], PI: [86, 89], PA: [91, 93, 94], AM: [92, 97], RR: [95], AP: [96], MA: [98, 99],
};
export function stateOf(phone: string): string {
  if (!phone.startsWith('55') || phone.length < 4) return 'Outros';
  const ddd = Number(phone.slice(2, 4));
  return Object.entries(DDD).find(([, l]) => l.includes(ddd))?.[0] ?? 'Outros';
}

const MEDIA_INLINE = /^(image\/(png|jpeg|webp|gif)|video\/mp4|audio\/(mpeg|ogg|mp4)|application\/pdf)$/;
const SIM_PHONE = '000000000000';
const FEATURED = ['text', 'options', 'cards'];

export function registerModules(app: FastifyInstance, core: Core, h: ModuleHelpers) {
  const { db } = core;
  const { crud, assertOwned, fail } = h;
  const inviteUrl = (token: string) => `${h.publicUrl}/convite/${token}`;
  const sign = (uid: string, aid: string) => app.jwt.sign({ uid, aid });
  const needAdmin = (req: any) => { if (req.user.role === 'agent') fail(403, 'Permissão insuficiente'); };

  crud('departments', 'departments', z.object({ name: z.string().min(1) }), [], 'name');
  crud('custom-fields', 'custom_fields', z.object({ key: z.string().regex(/^\w+$/), label: z.string().min(1) }), [], 'label');
  crud('products', 'products', z.object({ name: z.string().min(1), price: z.coerce.number().nonnegative().default(0) }), [], 'name');

  // Empresas
  app.get('/api/accounts', async (req) => db.query('SELECT a.id, a.name, m.role, a.id = $2 AS current FROM accounts a JOIN memberships m ON m.account_id = a.id WHERE m.user_id = $1 ORDER BY a.name', [req.user.uid, req.user.aid]));
  app.post('/api/accounts', async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    const [a] = await db.query('INSERT INTO accounts (name) VALUES ($1) RETURNING id', [name]);
    await db.query('INSERT INTO memberships (user_id, account_id) VALUES ($1,$2)', [req.user.uid, a.id]);
    return reply.code(201).send({ token: sign(req.user.uid, a.id) });
  });
  app.post('/api/accounts/:id/switch', async (req) => {
    const id = (req.params as any).id;
    if (!(await db.query('SELECT 1 FROM memberships WHERE user_id = $1 AND account_id = $2', [req.user.uid, id])).length) fail(403, 'Sem acesso a esta empresa');
    return { token: sign(req.user.uid, id) };
  });

  // Configurações da empresa
  const account = async (aid: string) => (await db.query('SELECT id, name, timezone, settings FROM accounts WHERE id = $1', [aid]))[0];
  app.get('/api/account', async (req) => account(req.user.aid));
  app.patch('/api/account', async (req) => {
    needAdmin(req);
    const b = z.object({
      name: z.string().min(1).optional(), timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Fuso inválido').optional(),
      business_hours: z.object({ days: z.array(z.object({ day: z.number().int().min(0).max(6), start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/) })) }).optional(),
      limits: z.object({ connections: z.number().int().positive().nullable(), dispatches: z.number().int().positive().nullable() }).optional(),
    }).parse(req.body);
    const cur = await account(req.user.aid);
    const settings = { ...cur.settings, ...(b.business_hours ? { business_hours: b.business_hours } : {}), ...(b.limits ? { limits: b.limits } : {}) };
    await db.query('UPDATE accounts SET name = $2, timezone = $3, settings = $4::jsonb WHERE id = $1', [req.user.aid, b.name ?? cur.name, b.timezone ?? cur.timezone, JSON.stringify(settings)]);
    return account(req.user.aid);
  });
  app.get('/api/usage', async (req) => {
    const aid = req.user.aid;
    const cur = await account(aid);
    const [c] = await db.query('SELECT COUNT(*)::int AS n FROM connections WHERE account_id = $1 AND NOT is_simulator', [aid]);
    const [d] = await db.query(`SELECT COUNT(i.*)::int AS n FROM dispatch_items i JOIN dispatches d ON d.id = i.dispatch_id WHERE d.account_id = $1 AND d.created_at >= date_trunc('month', now())`, [aid]);
    return { connections: c.n, dispatches: d.n, limits: cur.settings.limits ?? { connections: null, dispatches: null } };
  });

  // Equipe e convites
  app.get('/api/team', async (req) => db.query('SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.account_id = $1 ORDER BY u.name', [req.user.aid]));
  app.get('/api/team/invites', async (req) => {
    needAdmin(req);
    return (await db.query('SELECT id, email, role, token FROM invitations WHERE account_id = $1 AND accepted_at IS NULL ORDER BY created_at DESC', [req.user.aid]))
      .map(({ token, ...i }) => ({ ...i, url: inviteUrl(token) }));
  });
  app.post('/api/team/invites', async (req, reply) => {
    needAdmin(req);
    const b = z.object({ email: z.email().toLowerCase(), role: z.enum(['admin', 'agent']) }).parse(req.body);
    const token = newToken();
    const [row] = await db.query('INSERT INTO invitations (account_id, email, role, token) VALUES ($1,$2,$3,$4) RETURNING id, email, role', [req.user.aid, b.email, b.role, token]);
    return reply.code(201).send({ ...row, url: inviteUrl(token) });
  });
  app.delete('/api/team/invites/:id', async (req, reply) => {
    needAdmin(req);
    await db.query('DELETE FROM invitations WHERE id = $1 AND account_id = $2 AND accepted_at IS NULL', [(req.params as any).id, req.user.aid]);
    return reply.code(204).send();
  });
  const member = async (uid: string, aid: string) => (await db.query('SELECT role FROM memberships WHERE user_id = $1 AND account_id = $2', [uid, aid]))[0] ?? fail(404, 'Membro não encontrado');
  app.patch('/api/team/:uid', async (req) => {
    needAdmin(req);
    const uid = (req.params as any).uid;
    const { role } = z.object({ role: z.enum(['admin', 'agent']) }).parse(req.body);
    if ((await member(uid, req.user.aid)).role === 'owner') fail(400, 'O proprietário não pode ser alterado');
    await db.query('UPDATE memberships SET role = $3 WHERE user_id = $1 AND account_id = $2', [uid, req.user.aid, role]);
    return { role };
  });
  app.delete('/api/team/:uid', async (req, reply) => {
    needAdmin(req);
    const uid = (req.params as any).uid;
    if ((await member(uid, req.user.aid)).role === 'owner') fail(400, 'O proprietário não pode ser removido');
    await db.query('DELETE FROM memberships WHERE user_id = $1 AND account_id = $2', [uid, req.user.aid]);
    return reply.code(204).send();
  });
  const authLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };
  const openInvite = async (token: string) => (await db.query(
    `SELECT i.*, a.name AS company, EXISTS (SELECT 1 FROM users u WHERE u.email = i.email) AS has_user FROM invitations i JOIN accounts a ON a.id = i.account_id
     WHERE i.token = $1 AND i.accepted_at IS NULL AND i.created_at > now() - interval '7 days'`, [token]))[0] ?? fail(404, 'Convite inválido ou expirado');
  app.get('/api/auth/invite/:token', { config: authLimit }, async (req) => {
    const i = await openInvite((req.params as any).token);
    return { email: i.email, company: i.company, hasUser: i.has_user };
  });
  app.post('/api/auth/invite/:token', { config: authLimit }, async (req) => {
    const i = await openInvite((req.params as any).token);
    const b = z.object({ password: z.string().min(1).max(200), name: z.string().min(1).max(120).optional() }).parse(req.body);
    if (!i.has_user && b.password.length < 10) fail(400, 'A senha precisa ter pelo menos 10 caracteres');
    let [user] = await db.query('SELECT * FROM users WHERE email = $1', [i.email]);
    if (user) {
      // Conta que já existe: a senha é conferida com a mesma trava do login, senão o convite vira atalho para força bruta.
      if (h.guard.locked(i.email)) fail(429, 'Muitas tentativas. Tente de novo em alguns minutos.');
      if (!(await verifyPassword(b.password, user.password_hash))) {
        void audit(db, 'login_failed', { accountId: i.account_id, ip: req.ip, detail: { email: i.email, where: 'invite' } });
        if (h.guard.fail(i.email)) void audit(db, 'login_locked', { accountId: i.account_id, ip: req.ip, detail: { email: i.email, where: 'invite' } });
        fail(401, 'Senha incorreta');
      }
      h.guard.ok(i.email);
    }
    else [user] = await db.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING *', [i.email, b.name ?? i.email, await hashPassword(b.password)]);
    await db.query('INSERT INTO memberships (user_id, account_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [user.id, i.account_id, i.role]);
    await db.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [i.id]);
    return { token: sign(user.id, i.account_id) };
  });

  // Chats: atribuição, novo chat, agendamento e anexos
  const chatFor = async (id: string, aid: string) => (await db.query('SELECT * FROM chats WHERE id = $1 AND account_id = $2', [id, aid]))[0] ?? fail(404, 'Chat não encontrado');
  app.patch('/api/chats/:id/assign', async (req) => {
    const chat = await chatFor((req.params as any).id, req.user.aid);
    const b = z.object({ department: z.string().nullable().optional(), assigned_user_id: z.uuid().nullable().optional() }).parse(req.body);
    if (b.assigned_user_id) await member(b.assigned_user_id, req.user.aid);
    const [row] = await db.query('UPDATE chats SET department = $2, assigned_user_id = $3 WHERE id = $1 RETURNING *',
      [chat.id, b.department === undefined ? chat.department : b.department, b.assigned_user_id === undefined ? chat.assigned_user_id : b.assigned_user_id]);
    core.emit(req.user.aid, 'chat', { id: chat.id });
    return row;
  });
  app.post('/api/chats', async (req, reply) => {
    const b = z.object({ phone: z.string().min(8), name: z.string().optional(), connection_id: z.uuid() }).parse(req.body);
    await assertOwned('connections', b.connection_id, req.user.aid);
    const contact = await core.upsertContact(req.user.aid, normalizePhone(b.phone), b.name, 'manual');
    return reply.code(201).send(await core.ensureChat(req.user.aid, contact.id, b.connection_id));
  });
  app.get('/api/scheduled-messages', async (req) => db.query(
    `SELECT s.*, c.name AS contact_name, c.phone AS contact_phone FROM scheduled_messages s JOIN chats ch ON ch.id = s.chat_id JOIN contacts c ON c.id = ch.contact_id
     WHERE s.account_id = $1 AND s.status = 'pending' ORDER BY s.run_at`, [req.user.aid]));
  app.post('/api/chats/:id/schedule', async (req, reply) => {
    const chat = await chatFor((req.params as any).id, req.user.aid);
    const b = z.object({ text: z.string().min(1).max(4096), run_at: z.iso.datetime({ offset: true }) }).parse(req.body);
    const when = new Date(b.run_at);
    if (when.getTime() < Date.now()) fail(400, 'Escolha um horário futuro');
    const [row] = await db.query('INSERT INTO scheduled_messages (account_id, chat_id, body, run_at) VALUES ($1,$2,$3,$4) RETURNING *', [req.user.aid, chat.id, b.text, when.toISOString()]);
    await core.enqueue('message.scheduled', { id: row.id }, when.getTime() - Date.now());
    return reply.code(201).send(row);
  });
  app.delete('/api/scheduled-messages/:id', async (req, reply) => {
    await db.query(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1 AND account_id = $2 AND status = 'pending'`, [(req.params as any).id, req.user.aid]);
    return reply.code(204).send();
  });
  app.post('/api/media', async (req, reply) => {
    const b = z.object({ filename: z.string().min(1).max(200), mime: z.string().min(1).max(120), base64: z.string().min(1) }).parse(req.body);
    const mime = b.mime.toLowerCase().split(';')[0].trim();
    const reject = (status: number, message: string, why: string) => { void audit(db, 'upload_rejected', { accountId: req.user.aid, ip: req.ip, detail: { why, mime, filename: cleanFilename(b.filename) } }); fail(status, message); };
    if (!UPLOAD_TYPES.has(mime)) reject(415, 'Tipo de arquivo não permitido', 'tipo');
    const data = Buffer.from(b.base64, 'base64');
    if (data.length > 16 * 1024 * 1024) reject(413, 'Arquivo maior que 16 MB', 'tamanho');
    if (!data.length) reject(400, 'Arquivo vazio', 'vazio');
    if (!contentMatchesType(mime, data)) reject(415, 'O conteúdo do arquivo não corresponde ao tipo informado', 'conteudo');
    return reply.code(201).send(await core.saveMedia(req.user.aid, cleanFilename(b.filename), mime, data));
  });
  app.get('/media/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!z.uuid().safeParse(id).success) return reply.code(404).send();
    const [m] = await db.query('SELECT * FROM media WHERE id = $1', [id]);
    if (!m) return reply.code(404).send();
    const inline = MEDIA_INLINE.test(m.mime);
    reply.header('x-content-type-options', 'nosniff').header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(m.filename)}"`);
    return reply.type(inline ? m.mime : 'application/octet-stream').send(Buffer.from(m.data));
  });
  // Dispara um fluxo à mão para esta conversa (ex.: pós-venda depois de conferir o pagamento).
  app.post('/api/chats/:id/run-flow', async (req, reply) => {
    const chat = await chatFor((req.params as any).id, req.user.aid);
    const { flow_id } = z.object({ flow_id: z.uuid() }).parse(req.body);
    await assertOwned('flows', flow_id, req.user.aid);
    await db.query(`UPDATE flow_runs SET status = 'cancelled' WHERE chat_id = $1 AND status IN ('running','waiting')`, [chat.id]);
    const runId = await core.engine.start(flow_id, chat.id, req.user.aid).catch((e: Error) => fail(400, e.message));
    return reply.code(202).send({ runId });
  });
  app.post('/api/chats/:id/media', async (req, reply) => {
    const chat = await chatFor((req.params as any).id, req.user.aid);
    const b = z.object({ url: z.url(), mediaType: z.enum(['image', 'video', 'audio', 'document']), caption: z.string().max(1024).optional() }).parse(req.body);
    if (!b.url.startsWith(`${h.publicUrl}/media/`)) fail(400, 'Mídia inválida');
    await db.query(`UPDATE flow_runs SET status = 'cancelled' WHERE chat_id = $1 AND status IN ('running','waiting')`, [chat.id]);
    await db.query(`UPDATE chats SET status = 'open', unread = 0 WHERE id = $1`, [chat.id]);
    return reply.code(201).send(await core.send(chat.id, { type: 'media', url: b.url, mediaType: b.mediaType, caption: b.caption }).catch((e: Error) => fail(502, e.message)));
  });

  // Etiquetas de contato e importação do WhatsApp
  app.put('/api/contacts/:id/labels', async (req) => {
    const id = (req.params as any).id;
    await assertOwned('contacts', id, req.user.aid);
    const { labels } = z.object({ labels: z.array(z.uuid()) }).parse(req.body);
    for (const l of labels) await assertOwned('labels', l, req.user.aid);
    await db.query('DELETE FROM contact_labels WHERE contact_id = $1', [id]);
    for (const l of labels) await db.query('INSERT INTO contact_labels (contact_id, label_id) VALUES ($1,$2)', [id, l]);
    return { labels };
  });
  app.get('/api/contacts/:id/label-ids', async (req) => {
    await assertOwned('contacts', (req.params as any).id, req.user.aid);
    return (await db.query('SELECT label_id FROM contact_labels WHERE contact_id = $1', [(req.params as any).id])).map((r) => r.label_id);
  });
  app.post('/api/connections/:id/import-contacts', async (req) => {
    const [conn] = await db.query('SELECT * FROM connections WHERE id = $1 AND account_id = $2', [(req.params as any).id, req.user.aid]);
    if (!conn) fail(404, 'Conexão não encontrada');
    const list = providers[conn.provider].listContacts;
    if (!list) fail(400, 'Provedor não oferece importação de contatos');
    const contacts = await list!(core.connectionInfo(conn)).catch((e: Error) => fail(502, e.message));
    for (const c of contacts) await core.upsertContact(req.user.aid, normalizePhone(c.phone), c.name, 'whatsapp');
    return { imported: contacts.length };
  });

  // Templates WhatsApp
  app.get('/api/templates', async (req) => db.query('SELECT t.*, c.name AS connection_name FROM whatsapp_templates t JOIN connections c ON c.id = t.connection_id WHERE t.account_id = $1 ORDER BY t.name', [req.user.aid]));
  const metaConn = async (id: string, aid: string) => {
    const [conn] = await db.query(`SELECT * FROM connections WHERE id = $1 AND account_id = $2 AND provider = 'meta'`, [id, aid]);
    if (!conn) fail(400, 'Selecione uma conexão da API Oficial');
    const info = core.connectionInfo(conn);
    if (!info.config.wabaId || !info.apiKey) fail(400, 'Conexão sem WABA ID ou token');
    return info;
  };
  app.post('/api/templates/sync', async (req) => {
    needAdmin(req);
    const { connection_id } = z.object({ connection_id: z.uuid() }).parse(req.body);
    const info = await metaConn(connection_id, req.user.aid);
    const rows = await syncMetaTemplates(info.apiKey!, info.config.wabaId).catch((e: Error) => fail(502, e.message));
    for (const t of rows) await db.query(
      `INSERT INTO whatsapp_templates (account_id, connection_id, name, language, category, body, status) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (connection_id, name, language) DO UPDATE SET category = EXCLUDED.category, body = EXCLUDED.body, status = EXCLUDED.status`,
      [req.user.aid, connection_id, t.name, t.language, t.category, t.body, t.status]);
    return { synced: rows.length };
  });
  app.post('/api/templates', async (req, reply) => {
    needAdmin(req);
    const b = z.object({ connection_id: z.uuid(), name: z.string().regex(/^[a-z0-9_]+$/, 'Use minúsculas, números e _'), language: z.string().default('pt_BR'), category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']).default('UTILITY'), body: z.string().min(1).max(1024) }).parse(req.body);
    const info = await metaConn(b.connection_id, req.user.aid);
    const status = await createMetaTemplate(info.apiKey!, info.config.wabaId, b).catch((e: Error) => fail(502, e.message));
    const [row] = await db.query('INSERT INTO whatsapp_templates (account_id, connection_id, name, language, category, body, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.aid, b.connection_id, b.name, b.language, b.category, b.body, status ?? 'PENDING']);
    return reply.code(201).send(row);
  });

  // Integrações
  const KINDS = ['meta_ads', 'mercadopago', 'elevenlabs'] as const;
  app.get('/api/integrations', async (req) => {
    needAdmin(req);
    return (await db.query('SELECT kind, config, secret IS NOT NULL AS has_secret FROM integrations WHERE account_id = $1', [req.user.aid]))
      .map((i) => ({ ...i, webhookUrl: i.kind === 'mercadopago' ? `${h.publicUrl}/hooks/mercadopago/${i.config.webhookToken}` : undefined }));
  });
  app.put('/api/integrations/:kind', async (req) => {
    needAdmin(req);
    const kind = z.enum(KINDS).parse((req.params as any).kind);
    const b = z.object({ config: z.record(z.string(), z.string()).default({}), secret: z.string().min(1).optional() }).parse(req.body);
    const [cur] = await db.query('SELECT config, secret FROM integrations WHERE account_id = $1 AND kind = $2', [req.user.aid, kind]);
    const config = { ...b.config, ...(kind === 'mercadopago' ? { webhookToken: cur?.config.webhookToken ?? newToken() } : {}) };
    const secret = b.secret ? encrypt(b.secret, h.secret) : cur?.secret ?? null;
    await db.query(
      `INSERT INTO integrations (account_id, kind, config, secret) VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (account_id, kind) DO UPDATE SET config = EXCLUDED.config, secret = EXCLUDED.secret`, [req.user.aid, kind, JSON.stringify(config), secret]);
    return { ok: true };
  });
  app.delete('/api/integrations/:kind', async (req, reply) => {
    needAdmin(req);
    await db.query('DELETE FROM integrations WHERE account_id = $1 AND kind = $2', [req.user.aid, (req.params as any).kind]);
    return reply.code(204).send();
  });
  app.post('/hooks/mercadopago/:token', async (req, reply) => {
    const [row] = await db.query(`SELECT account_id FROM integrations WHERE kind = 'mercadopago' AND config->>'webhookToken' = $1`, [(req.params as any).token]);
    if (!row) return h.badHook(req, reply, 'mercadopago');
    const body = (req.body ?? {}) as any;
    const id = String(body.data?.id ?? (req.query as any)['data.id'] ?? '');
    if (!id || (body.type && body.type !== 'payment')) return { ignored: true };
    const mp = await core.integration(row.account_id, 'mercadopago');
    // O status vem da consulta ao Mercado Pago, nunca do corpo da notificação.
    const status = await getPaymentStatus(mp!.secret!, id);
    if (status !== 'approved') return { status };
    const [pay] = await db.query(`UPDATE payments SET status = 'approved' WHERE account_id = $1 AND external_id = $2 AND status = 'pending' RETURNING *`, [row.account_id, id]);
    if (!pay) return { status };
    const [chat] = await db.query('SELECT contact_id, connection_id FROM chats WHERE id = $1', [pay.chat_id]);
    await core.recordSale(row.account_id, { contactId: chat.contact_id, connectionId: chat.connection_id, product: pay.product, amount: Number(pay.amount) });
    if (pay.run_id) await core.engine.onPaid(pay.run_id);
    return { status };
  });

  // Webhooks de saída
  app.get('/api/outbound-webhooks', async (req) => { needAdmin(req); return db.query('SELECT * FROM outbound_webhooks WHERE account_id = $1 ORDER BY created_at DESC', [req.user.aid]); });
  app.post('/api/outbound-webhooks', async (req, reply) => {
    needAdmin(req);
    const b = z.object({ name: z.string().min(1), url: z.url(), events: z.array(z.string()).default(['sale.approved']) }).parse(req.body);
    const [row] = await db.query('INSERT INTO outbound_webhooks (account_id, name, url, secret, events) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *', [req.user.aid, b.name, b.url, newToken(), JSON.stringify(b.events)]);
    return reply.code(201).send(row);
  });
  app.delete('/api/outbound-webhooks/:id', async (req, reply) => {
    needAdmin(req);
    await db.query('DELETE FROM outbound_webhooks WHERE id = $1 AND account_id = $2', [(req.params as any).id, req.user.aid]);
    return reply.code(204).send();
  });

  // Facebook
  app.get('/api/facebook/insights', async (req) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).parse((req.query as any).days);
    const ads = await core.integration(req.user.aid, 'meta_ads');
    if (!ads?.secret || !ads.config.adAccountId) return { configured: false, campaigns: [], spend: 0 };
    const r = await metaInsights(ads.secret, ads.config.adAccountId, days).catch((e: Error) => fail(502, e.message));
    return { configured: true, ...r };
  });

  // Relatórios
  app.get('/api/dashboard/details', async (req) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).parse((req.query as any).days);
    const aid = req.user.aid;
    const { timezone } = await account(aid);
    const since = `s.account_id = $1 AND s.created_at > now() - ($2 || ' days')::interval`;
    const p = [aid, String(days)];
    const byHour = await db.query(`SELECT EXTRACT(hour FROM s.created_at AT TIME ZONE $3)::int AS hour, COUNT(*)::int AS n FROM sales s WHERE ${since} GROUP BY 1 ORDER BY 1`, [...p, timezone]);
    const byConnection = await db.query(`SELECT COALESCE(c.name, 'Sem conexão') AS name, COUNT(*)::int AS n, SUM(s.amount)::float AS revenue FROM sales s LEFT JOIN connections c ON c.id = s.connection_id WHERE ${since} GROUP BY 1 ORDER BY revenue DESC`, p);
    const byProduct = await db.query(`SELECT COALESCE(NULLIF(s.product, ''), 'Sem produto') AS name, COUNT(*)::int AS n, SUM(s.amount)::float AS revenue FROM sales s WHERE ${since} GROUP BY 1 ORDER BY revenue DESC`, p);
    const list = await db.query(`SELECT s.*, c.name AS contact_name, c.phone AS contact_phone, cn.name AS connection_name FROM sales s LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN connections cn ON cn.id = s.connection_id WHERE ${since} ORDER BY s.created_at DESC LIMIT 200`, p);
    const states: Record<string, number> = {};
    for (const s of list) { const uf = stateOf(s.contact_phone ?? ''); states[uf] = (states[uf] ?? 0) + 1; }
    return { byHour, byConnection, byProduct, sales: list, byState: Object.entries(states).map(([uf, n]) => ({ uf, n })).sort((a, b) => b.n - a.n) };
  });

  // Fluxos: duplicar, traduzir, simular
  const flowFor = async (id: string, aid: string) => (await db.query('SELECT * FROM flows WHERE id = $1 AND account_id = $2', [id, aid]))[0] ?? fail(404, 'Fluxo não encontrado');
  const insertCopy = async (f: any, aid: string, name: string, graph: unknown) => (await db.query('INSERT INTO flows (account_id, name, folder, graph) VALUES ($1,$2,$3,$4::jsonb) RETURNING *', [aid, name, f.folder, JSON.stringify(graph)]))[0];
  app.post('/api/flows/:id/duplicate', async (req, reply) => {
    const f = await flowFor((req.params as any).id, req.user.aid);
    return reply.code(201).send(await insertCopy(f, req.user.aid, `${f.name} (cópia)`, f.graph));
  });
  app.post('/api/flows/:id/translate', async (req, reply) => {
    const f = await flowFor((req.params as any).id, req.user.aid);
    const { language } = z.object({ language: z.string().min(2).max(40) }).parse(req.body);
    const graph = structuredClone(f.graph);
    const slots: { get: () => string; set: (v: string) => void }[] = [];
    for (const n of graph.nodes) for (const k of FEATURED) {
      const v = n.data?.[k];
      if (typeof v === 'string' && v.trim()) slots.push({ get: () => n.data[k], set: (t) => { n.data[k] = t; } });
      else if (Array.isArray(v)) v.forEach((s: string, i: number) => { if (s.trim()) slots.push({ get: () => n.data[k][i], set: (t) => { n.data[k][i] = t; } }); });
    }
    if (slots.length) {
      const raw = await core.generate({
        model: 'claude-opus-5-5',
        system: `Traduza para ${language} cada string do array JSON. Mantenha intactos os marcadores {{...}}. Responda somente com um array JSON do mesmo tamanho.`,
        messages: [{ role: 'user', content: JSON.stringify(slots.map((s) => s.get())) }],
      }).catch((e: Error) => fail(502, e.message));
      let out: unknown;
      try { out = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)); } catch { fail(502, 'Resposta de tradução inválida'); }
      if (!Array.isArray(out) || out.length !== slots.length) fail(502, 'Resposta de tradução inválida');
      slots.forEach((s, i) => s.set(String((out as unknown[])[i])));
    }
    return reply.code(201).send(await insertCopy(f, req.user.aid, `${f.name} (${language})`, graph));
  });

  const simulator = async (aid: string) => {
    let [conn] = await db.query('SELECT * FROM connections WHERE account_id = $1 AND is_simulator', [aid]);
    if (!conn) [conn] = await db.query(`INSERT INTO connections (account_id, name, provider, webhook_token, status, is_simulator) VALUES ($1,'Simulador','sandbox',$2,'connected',true) RETURNING *`, [aid, newToken()]);
    const contact = await core.upsertContact(aid, SIM_PHONE, 'Cliente de simulação', 'simulator');
    await db.query('UPDATE contacts SET is_simulator = true, opted_out = false WHERE id = $1', [contact.id]);
    const chat = await core.ensureChat(aid, contact.id, conn.id);
    return { conn, chat };
  };
  app.post('/api/flows/:id/simulate/start', async (req) => {
    const f = await flowFor((req.params as any).id, req.user.aid);
    const { chat } = await simulator(req.user.aid);
    await db.query(`UPDATE flow_runs SET status = 'cancelled' WHERE chat_id = $1 AND status IN ('running','waiting')`, [chat.id]);
    await db.query('DELETE FROM messages WHERE chat_id = $1', [chat.id]);
    await db.query(`UPDATE contacts SET fields = '{}' WHERE id = $1`, [chat.contact_id]);
    await core.engine.start(f.id, chat.id, req.user.aid, { __sim: true }).catch((e: Error) => fail(400, e.message));
    return { chatId: chat.id };
  });
  app.post('/api/flows/:id/simulate/say', async (req) => {
    await flowFor((req.params as any).id, req.user.aid);
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    const { conn } = await simulator(req.user.aid);
    await core.handleInbound(conn, providers.sandbox.parse({ phone: SIM_PHONE, text }));
    return { ok: true };
  });
}
