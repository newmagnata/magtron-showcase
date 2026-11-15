import crypto from 'node:crypto';
import type { Core } from './core.js';
import { assertPublicUrl } from './security.js';
import { audit } from './audit.js';
import { providers, type InboundMedia } from './providers.js';
import { createPixCharge, textToSpeech } from './integrations.js';
import { ITEM_LABEL, messageItems, pauseMs, recordingMs, typingMs } from './message-items.js';

/** Bloco "Aguarda resposta" configurado para aceitar só imagem ou PDF (comprovante). */
const isProofWait = (d: Record<string, any> | undefined) => d?.mediaOnly === 'yes' || d?.mediaOnly === true;

interface Node { id: string; type: string; data: Record<string, any> }
interface Edge { source: string; target: string; sourceHandle?: string | null }
interface Graph { nodes: Node[]; edges: Edge[] }

type Step =
  | { kind: 'next'; handle?: string }
  | { kind: 'wait'; timeoutMin?: number; waitKind?: string }
  | { kind: 'delay'; ms: number; handle?: string }
  | { kind: 'jump'; flowId: string }
  | { kind: 'end' };

interface Scope { run: any; chat: any; contact: any; globals: Record<string, string> }

const MAX_STEPS = 300;

export function render(template: string, s: Pick<Scope, 'contact' | 'globals'> & { run: { vars: any } }): string {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const [root, ...rest] = path.split('.');
    const key = rest.join('.');
    if (root === 'contact') {
      if (key === 'name' || key === 'phone') return s.contact[key] ?? '';
      if (key === 'labels') return (s.contact.labels ?? []).join(', ');
      return String(s.contact.fields?.[key] ?? '');
    }
    if (root === 'sys') {
      const timeZone = 'America/Sao_Paulo';
      if (key === 'date') return new Date().toLocaleDateString('pt-BR', { timeZone });
      if (key === 'time') return new Date().toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' });
      return '';
    }
    if (root === 'vars') return String(s.run.vars?.[key] ?? '');
    if (root === 'global') return String(s.globals[key] ?? '');
    return '';
  });
}

export function compare(left: string, op: string, right: string): boolean {
  const [a, b] = [Number(left), Number(right)];
  switch (op) {
    case 'eq': return left.trim().toLowerCase() === right.trim().toLowerCase();
    case 'neq': return left.trim().toLowerCase() !== right.trim().toLowerCase();
    case 'contains': return left.toLowerCase().includes(right.toLowerCase());
    case 'gt': return a > b;
    case 'lt': return a < b;
    case 'exists': return left.trim() !== '';
    default: return false;
  }
}

export interface BusinessHours { days: { day: number; start: string; end: string }[] }

/** True when the moment falls within the account's opening hours, in its timezone. */
export function isOpen(hours: BusinessHours | undefined, timeZone: string, now = new Date()): boolean {
  if (!hours?.days?.length) return true;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const time = `${get('hour')}:${get('minute')}`;
  return hours.days.some((d) => d.day === day && time >= d.start && time < d.end);
}

export class Engine {
  constructor(private core: Core) {}
  private get db() { return this.core.db; }

  /** Starts a flow unless the chat already has an active run. Returns the run id. */
  async start(flowId: string, chatId: string, accountId: string, vars: Record<string, unknown> = {}) {
    const [flow] = await this.db.query('SELECT * FROM flows WHERE id = $1 AND account_id = $2', [flowId, accountId]);
    if (!flow) throw new Error('Fluxo não encontrado');
    const start = (flow.graph as Graph).nodes.find((n) => n.type === 'start');
    if (!start) throw new Error('Fluxo sem bloco Início');
    const [run] = await this.db.query(
      `INSERT INTO flow_runs (account_id, flow_id, chat_id, current_node, vars) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (chat_id) WHERE status IN ('running','waiting') DO NOTHING RETURNING *`,
      [accountId, flowId, chatId, start.id, JSON.stringify(vars)]);
    if (!run) return null;
    await this.drive(run, start.id);
    return run.id as string;
  }

  async onInbound(chat: any, text: string, fresh: boolean, conn: any, media?: InboundMedia) {
    const [run] = await this.db.query(
      `UPDATE flow_runs SET status = 'running', updated_at = now()
       WHERE chat_id = $1 AND status = 'waiting' AND wait_kind = 'reply' RETURNING *`, [chat.id]);
    // Imagem ou PDF (possível comprovante): avisa a equipe, a não ser que o fluxo esteja esperando justamente um comprovante e avise sozinho.
    if (media === 'image' || media === 'document') {
      const waiting = run ? (await this.graph(run.flow_id))?.nodes.find((n) => n.id === run.current_node) : undefined;
      if (!(waiting?.type === 'wait_reply' && isProofWait(waiting.data))) {
        const [c] = await this.db.query('SELECT name, phone FROM contacts WHERE id = $1', [chat.contact_id]);
        await this.core.notify(chat.account_id, `📎 ${c?.name || c?.phone} (${c?.phone}) enviou ${media === 'image' ? 'uma imagem' : 'um PDF/documento'}. Pode ser um comprovante de pagamento: confira no WhatsApp.`);
      }
    }
    if (run) return this.resumeWithReply(run, text, media);
    const lower = text.toLowerCase();
    const keywords = await this.db.query('SELECT k.keyword, k.flow_id FROM connection_keywords k JOIN flows f ON f.id = k.flow_id WHERE k.connection_id = $1 AND f.active', [conn.id]);
    const hit = keywords.find((k) => lower.includes(k.keyword));
    if (hit) { await this.start(hit.flow_id, chat.id, chat.account_id, { first_message: text, keyword: hit.keyword }); return; }
    await this.startSlot(conn.id, fresh ? 'welcome' : 'default', chat, { first_message: text });
  }

  /** Starts the flow configured for a connection slot, if it is active and the chat is free. */
  async startSlot(connectionId: string, slot: string, chat: { id: string; account_id: string }, vars: Record<string, unknown> = {}) {
    const [row] = await this.db.query('SELECT f.id FROM connection_flows s JOIN flows f ON f.id = s.flow_id WHERE s.connection_id = $1 AND s.slot = $2 AND f.active', [connectionId, slot]);
    if (row) await this.start(row.id, chat.id, chat.account_id, vars);
  }

  private async resumeWithReply(run: any, text: string, media?: InboundMedia) {
    const graph = await this.graph(run.flow_id);
    const node = graph?.nodes.find((n) => n.id === run.current_node);
    if (!graph || !node) return this.finish(run.id, 'failed', 'Bloco não encontrado');
    run.vars = { ...run.vars, last_reply: text };
    if (node.type === 'menu') {
      const options: string[] = node.data.options ?? [];
      const n = Number(text.trim());
      const index = Number.isInteger(n) && n >= 1 && n <= options.length
        ? n - 1 : options.findIndex((o) => o.trim().toLowerCase() === text.trim().toLowerCase());
      if (index < 0) {
        if (graph.edges.some((e) => e.source === node.id && e.sourceHandle === 'invalid')) return this.follow(run, graph, node, 'invalid');
        await this.setWaiting(run, node.id, 'reply');
        return;
      }
      if (node.data.variable) run.vars[node.data.variable] = options[index];
      return this.follow(run, graph, node, `opt-${index}`);
    }
    if (node.type === 'wait_reply') {
      if (isProofWait(node.data)) {
        // "Só comprovante": imagem ou PDF segue por "out"; texto segue por "other" (se houver) ou continua esperando sem ruído.
        if (media === 'image' || media === 'document') { run.vars.last_media = media; return this.follow(run, graph, node, 'out'); }
        if (graph.edges.some((e) => e.source === node.id && e.sourceHandle === 'other')) return this.follow(run, graph, node, 'other');
        const token = await this.setWaiting(run, node.id, 'reply');
        if (node.data.timeoutMin) await this.core.enqueue('flow.timeout', { runId: run.id, token }, Number(node.data.timeoutMin) * 60_000);
        return;
      }
      if (node.data.variable) run.vars[node.data.variable] = text;
      return this.follow(run, graph, node, 'out');
    }
    if (node.type === 'ai_agent') {
      const scope = await this.scope(run);
      const step = await this.exec(node, scope).catch(() => ({ kind: 'next', handle: 'error' }) as Step);
      if (step.kind === 'wait') { await this.setWaiting(run, node.id, 'reply'); return; }
      return this.follow(run, graph, node, step.kind === 'next' ? step.handle ?? 'out' : 'out');
    }
    return this.follow(run, graph, node, 'out');
  }

  async runJob(kind: string, p: any) {
    if (kind === 'flow.resume') {
      const [run] = await this.db.query(
        `UPDATE flow_runs SET status = 'running' WHERE id = $1 AND status = 'waiting' AND wait_token = $2 RETURNING *`, [p.runId, p.token]);
      if (run) await this.drive(run, run.current_node);
    } else if (kind === 'flow.timeout') {
      const [run] = await this.db.query(
        `UPDATE flow_runs SET status = 'running' WHERE id = $1 AND status = 'waiting' AND wait_token = $2 RETURNING *`, [p.runId, p.token]);
      if (!run) return;
      const graph = await this.graph(run.flow_id);
      const node = graph?.nodes.find((n) => n.id === run.current_node);
      if (graph && node) await this.follow(run, graph, node, 'timeout');
    } else if (kind === 'dispatch.tick') {
      await this.dispatchTick(p.id);
    } else if (kind === 'flow.slot') {
      const [chat] = await this.db.query('SELECT * FROM chats WHERE id = $1', [p.chatId]);
      if (chat) await this.startSlot(chat.connection_id, p.slot, chat);
    } else {
      await this.core.runExtraJob(kind, p);
    }
  }

  /** Continues a flow that was waiting for this payment. */
  async onPaid(runId: string) {
    const [run] = await this.db.query(
      `UPDATE flow_runs SET status = 'running' WHERE id = $1 AND status = 'waiting' AND wait_kind = 'payment' RETURNING *`, [runId]);
    if (!run) return;
    const graph = await this.graph(run.flow_id);
    const node = graph?.nodes.find((n) => n.id === run.current_node);
    if (graph && node) await this.follow(run, graph, node, 'paid');
  }

  private async dispatchTick(id: string) {
    const [d] = await this.db.query(`SELECT * FROM dispatches WHERE id = $1 AND status = 'running'`, [id]);
    if (!d) return;
    const [item] = await this.db.query(
      `UPDATE dispatch_items SET status = 'processing' WHERE id = (
         SELECT id FROM dispatch_items WHERE dispatch_id = $1 AND status = 'pending' LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`, [id]);
    if (!item) {
      await this.db.query(`UPDATE dispatches SET status = 'done' WHERE id = $1`, [id]);
      this.core.emit(d.account_id, 'dispatch', { id, status: 'done' });
      return;
    }
    try {
      const [contact] = await this.db.query('SELECT * FROM contacts WHERE id = $1', [item.contact_id]);
      if (contact.opted_out) {
        await this.db.query(`UPDATE dispatch_items SET status = 'skipped' WHERE id = $1`, [item.id]);
      } else {
        const chat = await this.core.ensureChat(d.account_id, item.contact_id, d.connection_id);
        const started = await this.start(d.flow_id, chat.id, d.account_id, { dispatch: d.name });
        await this.db.query('UPDATE dispatch_items SET status = $2 WHERE id = $1', [item.id, started ? 'sent' : 'skipped']);
      }
    } catch (err: any) {
      await this.db.query(`UPDATE dispatch_items SET status = 'failed', error = $2 WHERE id = $1`, [item.id, String(err?.message ?? err)]);
    }
    const base = 60_000 / Math.max(1, d.per_minute);
    await this.core.enqueue('dispatch.tick', { id }, base * (0.8 + Math.random() * 0.4));
  }

  private async graph(flowId: string): Promise<Graph | undefined> {
    return (await this.db.query('SELECT graph FROM flows WHERE id = $1', [flowId]))[0]?.graph;
  }

  private async scope(run: any): Promise<Scope> {
    const [chat] = await this.db.query('SELECT * FROM chats WHERE id = $1', [run.chat_id]);
    const [contact] = await this.db.query('SELECT * FROM contacts WHERE id = $1', [chat.contact_id]);
    contact.labels = (await this.db.query('SELECT l.name FROM labels l JOIN contact_labels c ON c.label_id = l.id WHERE c.contact_id = $1', [contact.id])).map((l) => l.name);
    const rows = await this.db.query('SELECT key, value FROM global_variables WHERE account_id = $1', [run.account_id]);
    return { run, chat, contact, globals: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }

  private async stat(flowId: string, nodeId: string, column: 'entered' | 'advanced') {
    await this.db.query(
      `INSERT INTO flow_node_stats (flow_id, node_id, ${column}) VALUES ($1,$2,1)
       ON CONFLICT (flow_id, node_id) DO UPDATE SET ${column} = flow_node_stats.${column} + 1`, [flowId, nodeId]);
  }

  private async finish(runId: string, status: string, error?: string) {
    await this.db.query('UPDATE flow_runs SET status = $2, error = $3, updated_at = now() WHERE id = $1', [runId, status, error ?? null]);
  }

  private async setWaiting(run: any, nodeId: string, kind: string, token: string = crypto.randomUUID()) {
    await this.db.query(
      `UPDATE flow_runs SET status = 'waiting', wait_kind = $2, wait_token = $3, current_node = $4, vars = $5::jsonb, updated_at = now() WHERE id = $1`,
      [run.id, kind, token, nodeId, JSON.stringify(run.vars)]);
    return token;
  }

  private async follow(run: any, graph: Graph, node: Node, handle: string) {
    const next = graph.edges.find((e) => e.source === node.id && (e.sourceHandle ?? 'out') === handle);
    if (!next) return this.saveAndFinish(run);
    if (!run.vars.__sim) await this.stat(run.flow_id, node.id, 'advanced');
    return this.drive(run, next.target);
  }

  private async saveAndFinish(run: any) {
    await this.db.query('UPDATE flow_runs SET vars = $2::jsonb WHERE id = $1', [run.id, JSON.stringify(run.vars)]);
    await this.finish(run.id, 'done');
  }

  private async drive(run: any, firstNode: string) {
    let nodeId: string = firstNode;
    let flowId: string = run.flow_id;
    let graph = await this.graph(flowId);
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        const node = graph?.nodes.find((n) => n.id === nodeId);
        if (!graph || !node) return this.finish(run.id, 'failed', `Bloco ${nodeId} não encontrado`);
        if (!run.vars.__sim) await this.stat(flowId, node.id, 'entered');
        const step = await this.exec(node, await this.scope({ ...run, flow_id: flowId }).then((s) => ({ ...s, run })));
        if (step.kind === 'end') return this.saveAndFinish(run);
        if (step.kind === 'wait') {
          const token = await this.setWaiting(run, node.id, step.waitKind ?? 'reply');
          if (step.timeoutMin) await this.core.enqueue('flow.timeout', { runId: run.id, token }, step.timeoutMin * 60_000);
          return;
        }
        if (step.kind === 'jump') {
          const [target] = await this.db.query('SELECT id, graph FROM flows WHERE id = $1 AND account_id = $2', [step.flowId, run.account_id]);
          const start = (target?.graph as Graph | undefined)?.nodes.find((n) => n.type === 'start');
          if (!target || !start) return this.finish(run.id, 'failed', 'Fluxo de destino inválido');
          if (!run.vars.__sim) await this.stat(flowId, node.id, 'advanced');
          await this.db.query('UPDATE flow_runs SET flow_id = $2 WHERE id = $1', [run.id, target.id]);
          run.flow_id = flowId = target.id;
          graph = target.graph;
          nodeId = start.id;
          continue;
        }
        const handle = step.handle ?? 'out';
        const edge = graph.edges.find((e) => e.source === node.id && (e.sourceHandle ?? 'out') === handle);
        if (!edge) return this.saveAndFinish(run);
        if (!run.vars.__sim) await this.stat(flowId, node.id, 'advanced');
        if (step.kind === 'delay') {
          const token = await this.setWaiting(run, edge.target, 'timer');
          await this.core.enqueue('flow.resume', { runId: run.id, token }, step.ms);
          return;
        }
        nodeId = edge.target;
      }
      await this.finish(run.id, 'failed', 'Limite de passos excedido (possível laço)');
    } catch (err: any) {
      await this.finish(run.id, 'failed', String(err?.message ?? err));
    }
  }


  private async exec(node: Node, s: Scope): Promise<Step> {
    const d = node.data ?? {};
    const r = (t: unknown) => render(String(t ?? ''), s);
    const { chat, contact, run } = s;
    if (run.vars.__sim) {
      const mocked: Record<string, string> = { http: 'ok', pixel: 'out', sale: 'out', payment: 'paid', call: 'out', voice: 'out', notify: 'out', ai: 'out', ai_agent: 'out' };
      if (node.type in mocked) {
        await this.core.send(chat.id, { type: 'text', text: `[Simulação] bloco ${node.type} executado sem efeito real` });
        return { kind: 'next', handle: mocked[node.type] };
      }
    }
    switch (node.type) {
      case 'business_hours': {
        const [acc] = await this.db.query('SELECT timezone, settings FROM accounts WHERE id = $1', [run.account_id]);
        return { kind: 'next', handle: isOpen(acc.settings.business_hours, acc.timezone) ? 'open' : 'closed' };
      }
      case 'voice': {
        const eleven = await this.core.integration(run.account_id, 'elevenlabs');
        if (!eleven?.secret) return { kind: 'next', handle: 'error' };
        try {
          const audio = await textToSpeech(eleven.secret, r(d.voiceId) || eleven.config.voiceId, r(d.text));
          const media = await this.core.saveMedia(run.account_id, 'voz.mp3', 'audio/mpeg', audio);
          await this.core.send(chat.id, { type: 'media', url: media.url, mediaType: 'audio' });
          return { kind: 'next', handle: 'out' };
        } catch { return { kind: 'next', handle: 'error' }; }
      }
      case 'call': {
        const [conn] = await this.db.query('SELECT * FROM connections WHERE id = $1', [chat.connection_id]);
        const provider = providers[conn.provider];
        if (!provider.call) return { kind: 'next', handle: 'error' };
        try { await provider.call(this.core.connectionInfo(conn), contact.phone, Number(d.seconds) || 10); return { kind: 'next', handle: 'out' }; }
        catch { return { kind: 'next', handle: 'error' }; }
      }
      case 'payment': {
        const mp = await this.core.integration(run.account_id, 'mercadopago');
        const amount = Number(r(d.amount));
        if (!mp?.secret || !(amount > 0)) return { kind: 'next', handle: 'error' };
        try {
          const product = r(d.product);
          const charge = await createPixCharge(mp.secret, {
            amount, description: product || 'Pedido', email: r(d.email) || `${contact.phone}@cliente.magtron.app`, idempotency: `${run.id}-${node.id}`,
            notifyUrl: `${this.core.publicUrl}/hooks/mercadopago/${mp.config.webhookToken}`,
          });
          await this.db.query('INSERT INTO payments (account_id, run_id, chat_id, external_id, product, amount) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [run.account_id, run.id, chat.id, charge.id, product, amount]);
          await this.core.send(chat.id, { type: 'text', text: r(d.text) || 'Pague com o Pix copia e cola abaixo:' });
          await this.core.send(chat.id, { type: 'text', text: charge.code });
          return { kind: 'wait', waitKind: 'payment', timeoutMin: Number(d.timeoutMin) || undefined };
        } catch { return { kind: 'next', handle: 'error' }; }
      }
      case 'template':
        if (d.templateName) {
          await this.core.send(chat.id, { type: 'template', name: r(d.templateName), language: d.language || 'pt_BR', vars: ((d.vars ?? []) as string[]).map(r), fallback: r(d.text) });
          return { kind: 'next' };
        }
        await this.core.send(chat.id, { type: 'text', text: r(d.text) });
        return { kind: 'next' };
      case 'start': return { kind: 'next' };
      case 'message': {
        for (const [i, it] of messageItems(d).entries()) {
          const n = `${i + 1}º conteúdo (${ITEM_LABEL[it.type] ?? it.type})`;
          try {
            if (it.type === 'delay') {
              if (!run.vars.__sim) await new Promise((ok) => setTimeout(ok, pauseMs(it.seconds)));
            } else if (it.type === 'text') {
              if (r(it.text).trim()) await this.core.send(chat.id, { type: 'text', text: r(it.text), delayMs: run.vars.__sim ? 0 : typingMs(it.typingSec) });
            } else if (it.type === 'contact') {
              const phone = r(it.phone).replace(/\D/g, '');
              if (!phone) throw new Error('contato sem telefone');
              await this.core.send(chat.id, { type: 'contact', name: r(it.name) || phone, phone });
            } else {
              const url = r(it.url).trim();
              if (!url) throw new Error('sem arquivo ou URL');
              // Arquivo de fora: precisa ser http(s) público (barra javascript:, file: e a rede interna, onde a Evolution também chega).
              if (!url.startsWith(`${this.core.publicUrl}/media/`)) {
                await assertPublicUrl(url).catch((e: Error) => { void audit(this.db, 'ssrf_blocked', { accountId: run.account_id, detail: { where: 'flow.media' } }); throw e; });
              }
              const kind = it.type === 'file' ? 'document' : it.type;
              await this.core.send(chat.id, {
                type: 'media', url, mediaType: kind, caption: kind === 'sticker' || kind === 'audio' ? undefined : r(it.caption),
                ptv: kind === 'video' && it.mode === 'ptv', voice: kind === 'audio' ? it.asVoice !== false : undefined,
                delayMs: run.vars.__sim ? 0 : recordingMs(it.recordingSec),
              });
            }
          } catch (e: any) {
            // Sem isto o fluxo parava em silêncio: agora o aviso aparece nas notificações com o motivo.
            await this.core.notify(run.account_id, `Falha no bloco Mensagem, ${n}: ${String(e?.message ?? e).slice(0, 200)}`);
            throw e;
          }
        }
        return { kind: 'next' };
      }
      case 'pix':
        await this.core.send(chat.id, { type: 'text', text: r(d.text) });
        await this.core.send(chat.id, { type: 'text', text: r(d.code) });
        return { kind: 'next' };
      case 'carousel':
        for (const line of (d.cards ?? []) as string[]) await this.core.send(chat.id, { type: 'text', text: r(line) });
        return { kind: 'next' };
      case 'menu': {
        const options = ((d.options ?? []) as string[]).map((o, i) => `${i + 1}. ${r(o)}`).join('\n');
        await this.core.send(chat.id, { type: 'text', text: `${r(d.text)}\n\n${options}` });
        return { kind: 'wait' };
      }
      case 'wait_reply': return { kind: 'wait', timeoutMin: Number(d.timeoutMin) || undefined };
      case 'tags':
        for (const name of (d.add ?? []) as string[]) {
          const [label] = await this.db.query(
            `INSERT INTO labels (account_id, name) VALUES ($1,$2) ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [run.account_id, name]);
          await this.db.query('INSERT INTO contact_labels (contact_id, label_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [contact.id, label.id]);
        }
        return { kind: 'next' };
      case 'chat_control':
        await this.db.query('UPDATE chats SET status = $2 WHERE id = $1', [chat.id, d.status ?? 'open']);
        this.core.emit(run.account_id, 'chat', { id: chat.id });
        if (d.status === 'resolved' && !run.vars.__sim) await this.core.enqueue('flow.slot', { chatId: chat.id, slot: 'finished' });
        return { kind: 'next' };
      case 'department':
        await this.db.query('UPDATE chats SET department = $2 WHERE id = $1', [chat.id, r(d.department)]);
        return { kind: 'next' };
      case 'notify':
        await this.core.notify(run.account_id, r(d.text));
        if (d.phone) {
          const [conn] = await this.db.query('SELECT * FROM connections WHERE id = $1', [chat.connection_id]);
          await providers[conn.provider].send(this.core.connectionInfo(conn), r(d.phone).replace(/\D/g, ''), { type: 'text', text: r(d.text) }).catch((e: Error) => console.error('Aviso por WhatsApp falhou:', e.message));
        }
        return { kind: 'next' };
      case 'condition': return { kind: 'next', handle: compare(r(d.left), d.op ?? 'eq', r(d.right)) ? 'true' : 'false' };
      case 'distributor': {
        const weights = ((d.weights ?? []) as unknown[]).map((w) => Math.max(0, Number(w) || 0));
        const total = weights.reduce((a, b) => a + b, 0);
        let roll = Math.random() * total;
        const index = weights.findIndex((w) => (roll -= w) < 0);
        return { kind: 'next', handle: `opt-${Math.max(0, index)}` };
      }
      case 'flow_link': return { kind: 'jump', flowId: d.flowId };
      case 'delay': {
        const seconds = Math.max(0, Number(d.seconds) || 0);
        const jitter = Math.max(0, Number(d.jitter) || 0);
        return { kind: 'delay', ms: run.vars.__sim ? 0 : (seconds + Math.random() * jitter) * 1000 };
      }
      case 'kanban': {
        let board: any;
        if (d.kanbanName) {
          const column = d.column || 'Novo';
          [board] = await this.db.query('SELECT * FROM kanbans WHERE name = $1 AND account_id = $2', [d.kanbanName, run.account_id]);
          if (!board) [board] = await this.db.query('INSERT INTO kanbans (account_id, name, columns) VALUES ($1,$2,$3::jsonb) RETURNING *', [run.account_id, d.kanbanName, JSON.stringify([column])]);
          else if (!board.columns.includes(column)) [board] = await this.db.query('UPDATE kanbans SET columns = columns || $2::jsonb WHERE id = $1 RETURNING *', [board.id, JSON.stringify([column])]);
        } else if (d.kanbanId) {
          [board] = await this.db.query('SELECT * FROM kanbans WHERE id = $1 AND account_id = $2', [d.kanbanId, run.account_id]);
        }
        if (board) await this.db.query(
          `INSERT INTO kanban_cards (account_id, kanban_id, contact_id, column_name) VALUES ($1,$2,$3,$4)
           ON CONFLICT (kanban_id, contact_id) DO UPDATE SET column_name = EXCLUDED.column_name`,
          [run.account_id, board.id, contact.id, d.column || board.columns[0]]);
        return { kind: 'next' };
      }
      case 'manipulator':
        await this.db.query(`UPDATE contacts SET fields = fields || $2::jsonb WHERE id = $1`, [contact.id, JSON.stringify({ [d.field]: r(d.value) })]);
        return { kind: 'next' };
      case 'sale':
        await this.core.recordSale(run.account_id, { contactId: contact.id, connectionId: chat.connection_id, product: r(d.product), amount: Number(r(d.amount)) || 0, currency: d.currency });
        return { kind: 'next' };
      case 'http': return this.httpNode(d, s);
      case 'pixel': return this.pixelNode(d, s);
      case 'ai': {
        try {
          const routes = ((d.routes ?? []) as string[]).filter((l) => l.trim()).map((l) => {
            const [key, ...desc] = l.split('|');
            return { key: key.trim(), desc: desc.join('|').trim() };
          });
          const system = routes.length
            ? `${r(d.system)}\n\nAo final da resposta, em uma nova linha, escreva [[ROTA:chave]] se a mensagem se encaixar em uma destas situações, ou nada se nenhuma se aplicar:\n${routes.map((x) => `- ${x.key}: ${r(x.desc)}`).join('\n')}`
            : r(d.system);
          const history = d.keepContext
            ? (await this.db.query(`SELECT direction, body FROM messages WHERE chat_id = $1 AND body <> '' ORDER BY created_at DESC LIMIT 20`, [chat.id])).reverse().map((m) => ({ role: m.direction === 'in' ? 'user' as const : 'assistant' as const, content: m.body as string }))
            : [];
          while (history[0]?.role === 'assistant') history.shift();
          const raw = await this.core.generate({ model: d.model || 'claude-opus-5-5', system, messages: [...history, { role: 'user', content: r(d.prompt) || '(mensagem sem texto)' }] });
          const route = /\[\[ROTA:([\w-]+)\]\]/.exec(raw)?.[1];
          const text = raw.replace(/\[\[ROTA:[\w-]+\]\]/g, '').trim();
          if (d.variable) run.vars[d.variable] = text;
          if (d.autoSend && text) await this.core.send(chat.id, { type: 'text', text });
          return { kind: 'next', handle: route && routes.some((x) => x.key === route) ? `route-${route}` : 'out' };
        } catch { return { kind: 'next', handle: 'error' }; }
      }
      case 'ai_agent': {
        const [agent] = await this.db.query('SELECT * FROM ai_agents WHERE id = $1 AND account_id = $2', [d.agentId, run.account_id]);
        if (!agent) return { kind: 'next', handle: 'error' };
        const rows = await this.db.query(`SELECT direction, body FROM messages WHERE chat_id = $1 AND body <> '' ORDER BY created_at DESC LIMIT 30`, [chat.id]);
        const messages = rows.reverse().map((m) => ({ role: m.direction === 'in' ? 'user' as const : 'assistant' as const, content: m.body as string }));
        while (messages[0]?.role === 'assistant') messages.shift();
        if (!messages.length) messages.push({ role: 'user', content: 'Olá' });
        const system = `${agent.prompt}\n\nQuando o atendimento terminar ou precisar de uma pessoa, termine sua resposta com [[FIM]].`;
        const reply = await this.core.generate({ model: agent.model, system, messages });
        const done = reply.includes('[[FIM]]');
        const text = reply.replace('[[FIM]]', '').trim();
        if (text) await this.core.send(chat.id, { type: 'text', text });
        return done ? { kind: 'next' } : { kind: 'wait' };
      }
      default: return { kind: 'next' };
    }
  }

  private async httpNode(d: any, s: Scope): Promise<Step> {
    const r = (t: unknown) => render(String(t ?? ''), s);
    try {
      const url = await assertPublicUrl(r(d.url));
      const method = String(d.method || 'POST').toUpperCase();
      const res = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : r(d.body),
      });
      const text = (await res.text()).slice(0, 20_000);
      if (d.variable) s.run.vars[d.variable] = text;
      return { kind: 'next', handle: res.ok ? 'ok' : 'error' };
    } catch {
      return { kind: 'next', handle: 'error' };
    }
  }

  private async pixelNode(d: any, s: Scope): Promise<Step> {
    const r = (t: unknown) => render(String(t ?? ''), s);
    const hash = crypto.createHash('sha256').update(s.contact.phone).digest('hex');
    const ads = await this.core.integration(s.run.account_id, 'meta_ads');
    const pixelId = r(d.pixelId) || ads?.config.pixelId;
    if (!pixelId || !ads?.secret) return { kind: 'next' };
    await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(ads.secret)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ data: [{
        event_name: r(d.event) || 'Purchase', event_time: Math.floor(Date.now() / 1000), action_source: 'chat',
        user_data: { ph: [hash] }, custom_data: { value: Number(r(d.value)) || 0, currency: d.currency || 'BRL' },
      }] }),
    }).catch(() => undefined);
    return { kind: 'next' };
  }
}
