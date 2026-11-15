import nodeCrypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { Db } from './db.js';
import { assertPublicUrl, decrypt } from './security.js';
import { providers, type ConnectionInfo, type InboundEvent, type OutMessage } from './providers.js';
import { Engine } from './engine.js';

export type Generate = (a: { model: string; system: string; messages: { role: 'user' | 'assistant'; content: string }[] }) => Promise<string>;

export const claudeGenerate: Generate = async ({ model, system, messages }) => {
  const client = new Anthropic();
  const params: any = {
    model, max_tokens: 16000, system, messages,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low' },
  };
  const res: any = await client.beta.messages.create(params);
  if (res.stop_reason === 'refusal') throw new Error('O modelo recusou esta solicitação');
  return res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
};

export const MEDIA_NAME = { image: 'imagem', video: 'vídeo', audio: 'áudio', document: 'documento', sticker: 'sticker' } as const;
export const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|descadastrar)\s*$/i;
export const normalizePhone = (p: string) => p.replace(/\D/g, '');

/** Shared services: database, messaging, job queue, realtime events. */
export class Core {
  engine: Engine;
  emit: (accountId: string, event: string, data: unknown) => void = () => {};
  private timer?: NodeJS.Timeout;
  private ticking = false;

  /** internalUrl is how sibling containers reach this app; publicUrl is what people's browsers and external services use. */
  constructor(readonly db: Db, readonly secret: string, readonly publicUrl: string, readonly generate: Generate = claudeGenerate, readonly internalUrl: string = publicUrl) {
    this.engine = new Engine(this);
  }

  connectionInfo(conn: any): ConnectionInfo {
    return {
      id: conn.id, config: conn.config ?? {},
      apiKey: conn.secret ? decrypt(conn.secret, this.secret) : undefined,
      webhookUrl: `${conn.provider === 'evolution' ? this.internalUrl : this.publicUrl}/hooks/${conn.provider}/${conn.webhook_token}`,
    };
  }

  /** Sends through the chat's connection and stores the outgoing message. */
  async send(chatId: string, original: OutMessage) {
    const [contact] = await this.db.query('SELECT phone FROM contacts co JOIN chats ch ON ch.contact_id = co.id WHERE ch.id = $1', [chatId]);
    const [conn] = await this.db.query('SELECT c.* FROM connections c JOIN chats ch ON ch.connection_id = c.id WHERE ch.id = $1', [chatId]);
    if (!contact || !conn) throw new Error('Chat não encontrado');
    const msg: OutMessage = original.type === 'template' && conn.provider !== 'meta' ? { type: 'text', text: original.fallback } : original;
    let wire: OutMessage = msg;
    if (msg.type === 'media' && conn.provider === 'evolution' && msg.url.startsWith(`${this.publicUrl}/media/`)) {
      // Arquivo guardado aqui: vai em base64 (a Evolution não aceita o endereço interno "http://magtron:3333").
      const id = msg.url.slice(`${this.publicUrl}/media/`.length);
      const [file] = /^[0-9a-f-]{36}$/.test(id) ? await this.db.query('SELECT filename, mime, data FROM media WHERE id = $1', [id]) : [];
      wire = file
        ? { ...msg, inline: { base64: Buffer.from(file.data).toString('base64'), mime: file.mime, filename: file.filename } }
        : { ...msg, url: this.internalUrl + msg.url.slice(this.publicUrl.length) };
    }
    const { externalId } = await providers[conn.provider].send(this.connectionInfo(conn), contact.phone, wire);
    const body = msg.type === 'text' ? msg.text : msg.type === 'template' ? msg.fallback || `[template ${msg.name}]` : msg.type === 'contact' ? `[contato] ${msg.name}` : msg.caption ?? '';
    const [saved] = await this.db.query(
      `INSERT INTO messages (account_id, chat_id, direction, body, media_url, external_id) VALUES ($1,$2,'out',$3,$4,$5) RETURNING *`,
      [conn.account_id, chatId, body, msg.type === 'media' ? msg.url : null, externalId]);
    await this.db.query('UPDATE chats SET last_message = $2, last_message_at = now() WHERE id = $1', [chatId, body || '[mídia]']);
    this.emit(conn.account_id, 'message', saved);
    return saved;
  }

  async ensureChat(accountId: string, contactId: string, connectionId: string) {
    await this.db.query(
      'INSERT INTO chats (account_id, contact_id, connection_id) VALUES ($1,$2,$3) ON CONFLICT (contact_id, connection_id) DO NOTHING',
      [accountId, contactId, connectionId]);
    return (await this.db.query('SELECT * FROM chats WHERE contact_id = $1 AND connection_id = $2', [contactId, connectionId]))[0];
  }

  async upsertContact(accountId: string, phone: string, name: string | undefined, origin: string) {
    const [c] = await this.db.query(
      `INSERT INTO contacts (account_id, phone, name, origin) VALUES ($1,$2,COALESCE($3,''),$4)
       ON CONFLICT (account_id, phone) DO UPDATE SET name = CASE WHEN contacts.name = '' THEN COALESCE($3, '') ELSE contacts.name END
       RETURNING *`, [accountId, phone, name ?? null, origin]);
    return c;
  }

  async handleInbound(conn: any, events: InboundEvent[]) {
    for (const e of events) {
      if (e.kind === 'status') {
        await this.db.query('UPDATE connections SET status = $2 WHERE id = $1', [conn.id, e.status]);
        this.emit(conn.account_id, 'connection', { id: conn.id, status: e.status });
        if (e.status === 'disconnected' && conn.status !== 'disconnected') await this.notify(conn.account_id, `A conexão ${conn.name} caiu.`);
        if (e.status === 'connected') await this.fillPhone(conn);
        conn.status = e.status;
        continue;
      }
      const phone = normalizePhone(e.phone);
      if (!phone) continue;
      const contact = await this.upsertContact(conn.account_id, phone, e.name, 'whatsapp');
      const existing = await this.db.query('SELECT status FROM chats WHERE contact_id = $1 AND connection_id = $2', [contact.id, conn.id]);
      const chat = await this.ensureChat(conn.account_id, contact.id, conn.id);
      // Mensagem só com arquivo aparece no chat como [imagem], [documento]...
      const shown = e.text || (e.media ? `[${MEDIA_NAME[e.media]}]` : '');
      const inserted = await this.db.query(
        `INSERT INTO messages (account_id, chat_id, direction, body, external_id) VALUES ($1,$2,'in',$3,$4)
         ON CONFLICT (chat_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING *`,
        [conn.account_id, chat.id, shown, e.externalId]);
      if (!inserted.length) continue; // webhook repetido
      const fresh = !existing.length || existing[0].status === 'resolved';
      await this.db.query(
        `UPDATE chats SET last_message = $2, last_message_at = now(), unread = unread + 1,
         status = CASE WHEN status = 'resolved' THEN 'waiting' ELSE status END WHERE id = $1`, [chat.id, shown]);
      this.emit(conn.account_id, 'message', inserted[0]);
      if (fresh) await this.attributeTracking(conn.account_id, contact.id, e.text);
      if (OPT_OUT.test(e.text)) {
        await this.db.query('UPDATE contacts SET opted_out = true WHERE id = $1', [contact.id]);
        await this.db.query(`UPDATE flow_runs SET status = 'cancelled' WHERE chat_id = $1 AND status IN ('running','waiting')`, [chat.id]);
        await this.send(chat.id, { type: 'text', text: 'Pronto, você não receberá mais mensagens automáticas.' });
        continue;
      }
      await this.engine.onInbound({ ...chat }, e.text, fresh, conn, e.media);
    }
  }

  /** Learns the connection's own number from the provider, unless it was set by hand. */
  async fillPhone(conn: any) {
    if (conn.phone) return;
    const phone = await providers[conn.provider].ownerPhone?.(this.connectionInfo(conn)).catch(() => undefined);
    if (phone) await this.db.query('UPDATE connections SET phone = $2 WHERE id = $1 AND phone IS NULL', [conn.id, phone]);
  }

  /** Ties a new contact to the ad click whose code appears in their first message. */
  async attributeTracking(accountId: string, contactId: string, text: string) {
    const codes = [...new Set(text.toLowerCase().match(/\b[0-9a-f]{6}\b/g) ?? [])].slice(0, 5);
    for (const code of codes) {
      const [click] = await this.db.query(
        `UPDATE tracking_clicks SET contact_id = $2 WHERE code = $1 AND account_id = $3 AND contact_id IS NULL AND created_at > now() - interval '6 hours'
         RETURNING params, (SELECT name FROM tracking_links WHERE id = tracking_clicks.link_id) AS link_name`, [code, contactId, accountId]);
      if (!click) continue;
      await this.db.query(`UPDATE contacts SET fields = fields || $2::jsonb WHERE id = $1`, [contactId, JSON.stringify({ ...click.params, tracking_link: click.link_name })]);
      return;
    }
  }

  async notify(accountId: string, body: string) {
    const [n] = await this.db.query('INSERT INTO notifications (account_id, body) VALUES ($1,$2) RETURNING *', [accountId, body]);
    this.emit(accountId, 'notification', n);
  }

  async integration(accountId: string, kind: string): Promise<{ config: any; secret?: string } | undefined> {
    const [row] = await this.db.query('SELECT config, secret FROM integrations WHERE account_id = $1 AND kind = $2', [accountId, kind]);
    return row ? { config: row.config, secret: row.secret ? decrypt(row.secret, this.secret) : undefined } : undefined;
  }

  async saveMedia(accountId: string, filename: string, mime: string, data: Uint8Array) {
    const [row] = await this.db.query('INSERT INTO media (account_id, filename, mime, data) VALUES ($1,$2,$3,$4) RETURNING id', [accountId, filename, mime, data]);
    return { id: row.id as string, url: `${this.publicUrl}/media/${row.id}` };
  }

  async recordSale(accountId: string, sale: { contactId: string | null; connectionId: string | null; product: string; amount: number; currency?: string }) {
    const [row] = await this.db.query('INSERT INTO sales (account_id, contact_id, connection_id, product, amount, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [accountId, sale.contactId, sale.connectionId, sale.product, sale.amount, sale.currency || 'BRL']);
    await this.fireEvent(accountId, 'sale.approved', row);
    return row;
  }

  /** Queues one signed delivery per outgoing webhook subscribed to the event. */
  async fireEvent(accountId: string, event: string, data: unknown) {
    const hooks = await this.db.query('SELECT id, events FROM outbound_webhooks WHERE account_id = $1', [accountId]);
    for (const h of hooks) if ((h.events as string[]).includes(event)) await this.enqueue('outbound', { webhookId: h.id, event, data });
  }

  async runExtraJob(kind: string, p: any) {
    if (kind === 'message.scheduled') {
      const [m] = await this.db.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1 AND status = 'pending' RETURNING *`, [p.id]);
      if (m) await this.send(m.chat_id, { type: 'text', text: m.body });
    } else if (kind === 'outbound') {
      const [h] = await this.db.query('SELECT * FROM outbound_webhooks WHERE id = $1', [p.webhookId]);
      if (!h) return;
      const url = await assertPublicUrl(h.url);
      const body = JSON.stringify({ event: p.event, data: p.data, sent_at: new Date().toISOString() });
      const signature = nodeCrypto.createHmac('sha256', h.secret).update(body).digest('hex');
      const res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', 'x-magtron-signature': signature }, body });
      if (!res.ok) throw new Error(`Webhook respondeu ${res.status}`);
    }
  }

  async enqueue(kind: string, payload: unknown, delayMs = 0) {
    await this.db.query(
      `INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2::jsonb, now() + ($3 || ' milliseconds')::interval)`,
      [kind, JSON.stringify(payload), String(Math.round(delayMs))]);
  }

  /** Runs every due job once. Safe across several server processes. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (;;) {
        const [job] = await this.db.query(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = (
             SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now() ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED
           ) RETURNING *`);
        if (!job) return;
        try {
          await this.engine.runJob(job.kind, job.payload);
          await this.db.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [job.id]);
        } catch (err: any) {
          const retry = job.attempts < 3;
          await this.db.query(
            `UPDATE jobs SET status = $2, error = $3, run_at = now() + interval '30 seconds' WHERE id = $1`,
            [job.id, retry ? 'pending' : 'failed', String(err?.message ?? err)]);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  startWorker(intervalMs = 1000) {
    this.timer = setInterval(() => void this.tick().catch(console.error), intervalMs);
  }
  stopWorker() { clearInterval(this.timer); }
}
