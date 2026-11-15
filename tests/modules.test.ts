import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import type { Core } from '../server/core';
import { isOpen } from '../server/engine';
import { stateOf } from '../server/modules';

let db: Db; let app: Awaited<ReturnType<typeof buildApp>>['app']; let core: Core;
let owner: string; let conn: any; let n = 0;
const translate = async ({ messages }: any) => JSON.stringify(JSON.parse(messages[0].content).map((s: string) => `EN:${s}`));

const call = async (method: any, url: string, body: unknown, t: string) => {
  const res = await app.inject({ method, url, payload: body as any, headers: { authorization: `Bearer ${t}` } });
  return { status: res.statusCode, body: res.body && res.headers['content-type']?.toString().includes('json') ? JSON.parse(res.body) : res.body, raw: res };
};
const api = (m: any, u: string, b?: unknown) => call(m, u, b, owner);
const register = async () => (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `m${++n}@teste.test`, password: 'senha-de-teste', name: 'T', company: 'C' } })).json().token as string;
const phone = () => `55219${String(20000000 + ++n)}`;
const edge = (source: string, target: string, sourceHandle = 'out') => ({ id: `${source}-${sourceHandle}`, source, target, sourceHandle });
const flow = async (nodes: any[], edges: any[]) => (await api('POST', '/api/flows', { name: `f${++n}`, active: true, graph: { nodes: [{ id: 's', type: 'start', data: {} }, ...nodes], edges } })).body;
const useFlow = (f: any) => api('PATCH', `/api/connections/${conn.id}`, { default_flow_id: f.id });
const say = (p: string, text: string) => api('POST', `/api/connections/${conn.id}/simulate`, { phone: p, name: 'Ana', text });
const chatOf = async (p: string) => (await api('GET', '/api/chats')).body.find((c: any) => c.contact_phone === p);
const outs = async (id: string) => (await api('GET', `/api/chats/${id}/messages`)).body.filter((m: any) => m.direction === 'out').map((m: any) => m.body);
const due = async () => { await db.query(`UPDATE jobs SET run_at = now() WHERE status = 'pending'`); await core.tick(); };

beforeAll(async () => {
  db = await openDb();
  ({ app, core } = await buildApp({ db, secret: 'x'.repeat(32), publicUrl: 'https://magtron.test', generate: translate }));
  owner = await register();
  conn = (await api('POST', '/api/connections', { name: 'S', provider: 'sandbox' })).body;
});
afterAll(async () => { await app.close(); await db.close(); });
afterEach(() => vi.unstubAllGlobals());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
describe('equipe e permissões', () => {
  let agent: string; let agentId: string;
  it('convida, aceita e entra na empresa', async () => {
    const inv = await api('POST', '/api/team/invites', { email: 'agente@teste.test', role: 'agent' });
    const path = new URL(inv.body.url).pathname.replace('/convite/', '/api/auth/invite/');
    expect((await app.inject({ url: path })).json().hasUser).toBe(false);
    const res = await app.inject({ method: 'POST', url: path, payload: { name: 'Agente', password: 'senha-do-agente' } });
    agent = res.json().token;
    agentId = (await api('GET', '/api/team')).body.find((m: any) => m.email === 'agente@teste.test').id;
    expect((await app.inject({ method: 'POST', url: path, payload: { password: 'senha-do-agente' } })).statusCode).toBe(404);
  });
  it('atendente usa chats mas não administra', async () => {
    expect((await call('GET', '/api/chats', undefined, agent)).status).toBe(200);
    expect((await call('POST', '/api/connections', { name: 'x', provider: 'sandbox' }, agent)).status).toBe(403);
    expect((await call('GET', '/api/integrations', undefined, agent)).status).toBe(403);
    expect((await call('POST', '/api/team/invites', { email: 'a@b.test', role: 'admin' }, agent)).status).toBe(403);
  });
  it('removido perde acesso mesmo com token válido', async () => {
    await api('DELETE', `/api/team/${agentId}`);
    expect((await call('GET', '/api/chats', undefined, agent)).status).toBe(401);
  });
  it('proprietário não pode ser removido', async () => {
    const me = (await api('GET', '/api/team')).body.find((m: any) => m.role === 'owner');
    expect((await api('DELETE', `/api/team/${me.id}`)).status).toBe(400);
  });
  it('alterna entre empresas só com vínculo', async () => {
    const created = await api('POST', '/api/accounts', { name: 'Segunda' });
    expect((await call('GET', '/api/connections', undefined, created.body.token)).body).toEqual([]);
    const accounts = (await api('GET', '/api/accounts')).body;
    expect(accounts).toHaveLength(2);
    const stranger = await register();
    expect((await call('POST', `/api/accounts/${accounts[0].id}/switch`, {}, stranger)).status).toBe(403);
  });
});

describe('horário comercial', () => {
  const hours = { days: [{ day: 1, start: '09:00', end: '18:00' }] };
  it('respeita o fuso', () => {
    expect(isOpen(hours, 'America/Sao_Paulo', new Date('2026-11-09T12:00:00Z'))).toBe(true);
    expect(isOpen(hours, 'America/Sao_Paulo', new Date('2026-11-09T22:00:00Z'))).toBe(false);
    expect(isOpen(hours, 'America/Sao_Paulo', new Date('2026-11-10T12:00:00Z'))).toBe(false);
    expect(isOpen(undefined, 'America/Sao_Paulo')).toBe(true);
  });
  it('bloco desvia fora do horário', async () => {
    await api('PATCH', '/api/account', { business_hours: { days: [] } });
    await useFlow(await flow([{ id: 'b', type: 'business_hours', data: {} }, { id: 'o', type: 'message', data: { text: 'aberto' } }], [edge('s', 'b'), edge('b', 'o', 'open')]));
    const p = phone(); await say(p, 'oi');
    expect(await outs((await chatOf(p)).id)).toEqual(['aberto']);
  });
  it('recusa fuso inválido', async () => expect((await api('PATCH', '/api/account', { timezone: 'Marte/Base' })).status).toBe(400));
});

describe('chats', () => {
  it('agenda, envia na hora e permite cancelar', async () => {
    const p = phone(); await say(p, 'oi');
    const c = await chatOf(p);
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const a = await api('POST', `/api/chats/${c.id}/schedule`, { text: 'lembrete', run_at: when });
    const b = await api('POST', `/api/chats/${c.id}/schedule`, { text: 'cancelada', run_at: when });
    await api('DELETE', `/api/scheduled-messages/${b.body.id}`);
    expect((await api('GET', '/api/scheduled-messages')).body.map((m: any) => m.id)).toEqual([a.body.id]);
    await due();
    expect(await outs(c.id)).toContain('lembrete');
    expect(await outs(c.id)).not.toContain('cancelada');
    expect((await api('POST', `/api/chats/${c.id}/schedule`, { text: 'x', run_at: '2020-01-01T00:00:00Z' })).status).toBe(400);
  });
  it('filtra não lidas e não respondidas', async () => {
    await api('PATCH', `/api/connections/${conn.id}`, { default_flow_id: null });
    const p = phone(); await say(p, 'oi');
    expect((await api('GET', '/api/chats?filter=unanswered')).body.some((c: any) => c.contact_phone === p)).toBe(true);
    const c = await chatOf(p);
    await api('POST', `/api/chats/${c.id}/messages`, { text: 'resposta' });
    expect((await api('GET', '/api/chats?filter=unanswered')).body.some((x: any) => x.contact_phone === p)).toBe(false);
    expect((await api('GET', '/api/chats?filter=unread')).body.some((x: any) => x.contact_phone === p)).toBe(false);
  });
  it('anexa mídia e serve com segurança', async () => {
    const up = await api('POST', '/api/media', { filename: 'a.png', mime: 'image/png', base64: PNG.toString('base64') });
    const res = await app.inject({ url: new URL(up.body.url).pathname });
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect((await api('POST', '/api/media', { filename: 'x.html', mime: 'text/html', base64: Buffer.from('<script>').toString('base64') })).status).toBe(415);
    const html = await api('POST', '/api/media', { filename: 'x.txt', mime: 'text/plain', base64: Buffer.from('<script>alert(1)</script>').toString('base64') });
    const r2 = await app.inject({ url: new URL(html.body.url).pathname });
    expect(r2.headers['content-disposition']).toContain('attachment');
    expect(r2.headers['content-type']).toContain('octet-stream');
    const p = phone(); await say(p, 'oi');
    const c = await chatOf(p);
    expect((await api('POST', `/api/chats/${c.id}/media`, { url: up.body.url, mediaType: 'image', caption: 'foto' })).status).toBe(201);
    expect((await api('POST', `/api/chats/${c.id}/media`, { url: 'https://evil.test/a.png', mediaType: 'image' })).status).toBe(400);
  });
});

describe('limites', () => {
  it('bloqueia conexões e cota de disparo', async () => {
    const t = await register();
    await call('PATCH', '/api/account', { limits: { connections: 1, dispatches: 1 } }, t);
    const c = (await call('POST', '/api/connections', { name: 'a', provider: 'sandbox' }, t)).body;
    expect((await call('POST', '/api/connections', { name: 'b', provider: 'sandbox' }, t)).status).toBe(402);
    await call('POST', '/api/contacts', { phone: phone() }, t);
    await call('POST', '/api/contacts', { phone: phone() }, t);
    const f = (await call('POST', '/api/flows', { name: 'f', graph: { nodes: [{ id: 's', type: 'start', data: {} }], edges: [] } }, t)).body;
    expect((await call('POST', '/api/dispatches', { name: 'd', flow_id: f.id, connection_id: c.id }, t)).status).toBe(402);
    expect((await call('GET', '/api/dispatches', undefined, t)).body).toEqual([]);
  });
});

describe('fluxos avançados', () => {
  it('simulador não gera venda, contadores nem aparece nas listas', async () => {
    const f = await flow([
      { id: 'q', type: 'menu', data: { text: 'Opção', options: ['A'] } },
      { id: 'v', type: 'sale', data: { product: 'X', amount: '500' } },
      { id: 'm', type: 'message', data: { text: 'fim' } },
    ], [edge('s', 'q'), edge('q', 'v', 'opt-0'), edge('v', 'm')]);
    const before = (await api('GET', '/api/dashboard')).body.sales;
    const { body } = await api('POST', `/api/flows/${f.id}/simulate/start`, {});
    await api('POST', `/api/flows/${f.id}/simulate/say`, { text: '1' });
    const out = await outs(body.chatId);
    expect(out[0]).toContain('Opção');
    expect(out.at(-1)).toBe('fim');
    expect((await api('GET', '/api/dashboard')).body.sales).toBe(before);
    expect((await api('GET', `/api/flows/${f.id}/stats`)).body).toEqual([]);
    expect((await api('GET', '/api/chats')).body.some((c: any) => c.contact_phone === '000000000000')).toBe(false);
    expect((await api('GET', '/api/connections')).body.some((c: any) => c.is_simulator)).toBe(false);
  });
  it('duplica e traduz mantendo a estrutura', async () => {
    const f = await flow([{ id: 'm', type: 'menu', data: { text: 'Olá {{contact.name}}', options: ['Sim'] } }], [edge('s', 'm')]);
    expect((await api('POST', `/api/flows/${f.id}/duplicate`, {})).body.name).toContain('cópia');
    const t = await api('POST', `/api/flows/${f.id}/translate`, { language: 'inglês' });
    const m = t.body.graph.nodes.find((x: any) => x.id === 'm');
    expect(m.data.text).toBe('EN:Olá {{contact.name}}');
    expect(m.data.options).toEqual(['EN:Sim']);
    expect((await api('GET', `/api/flows/${f.id}`)).body.graph.nodes[1].data.text).toBe('Olá {{contact.name}}');
  });
  it('template vira texto fora da API Oficial', async () => {
    await useFlow(await flow([{ id: 't', type: 'template', data: { templateName: 'pedido', vars: ['1'], text: 'Pedido confirmado' } }], [edge('s', 't')]));
    const p = phone(); await say(p, 'oi');
    expect(await outs((await chatOf(p)).id)).toEqual(['Pedido confirmado']);
  });
});

describe('recursos para fluxos migrados', () => {
  it('condição por etiqueta, kanban por nome e rota escolhida pela IA', async () => {
    (core as any).generate = async () => 'Analisado\n[[ROTA:obj_ia]]';
    await useFlow(await flow([
      { id: 't', type: 'tags', data: { add: ['PT 1'] } },
      { id: 'c', type: 'condition', data: { left: '{{contact.labels}}', op: 'contains', right: 'PT 1' } },
      { id: 'k', type: 'kanban', data: { kanbanName: 'CRM', column: 'Fechado' } },
      { id: 'a', type: 'ai', data: { system: 's', prompt: '{{vars.first_message}}', variable: 'r', routes: ['obj_ia | pergunta se é robô', 'obj_golpe | desconfia'] } },
      { id: 'ia', type: 'message', data: { text: 'rota ia: {{vars.r}}' } },
      { id: 'pad', type: 'message', data: { text: 'padrão' } },
    ], [edge('s', 't'), edge('t', 'c'), edge('c', 'k', 'true'), edge('k', 'a'), edge('a', 'ia', 'route-obj_ia'), edge('a', 'pad')]));
    const p = phone(); await say(p, 'é robô?');
    expect(await outs((await chatOf(p)).id)).toEqual(['rota ia: Analisado']);
    const board = (await api('GET', '/api/kanbans')).body.find((b: any) => b.name === 'CRM');
    expect(board.columns).toContain('Fechado');
    expect((await api('GET', `/api/kanbans/${board.id}/cards`)).body).toHaveLength(1);
  });
});

describe('pagamento e eventos (serviços externos simulados)', () => {
  it('cobra Pix, só confirma consultando o provedor e segue o fluxo', async () => {
    await api('PUT', '/api/integrations/mercadopago', { secret: 'TOKEN-MP', config: {} });
    const hook = (await api('POST', '/api/outbound-webhooks', { name: 'crm', url: 'https://93.184.216.34/h' })).body;
    expect((await api('GET', '/api/integrations')).body[0].secret).toBeUndefined();
    await useFlow(await flow([
      { id: 'p', type: 'payment', data: { amount: '49.90', product: 'Kit', text: 'Pague' } },
      { id: 'ok', type: 'message', data: { text: 'Pago!' } },
    ], [edge('s', 'p'), edge('p', 'ok', 'paid')]));
    let status = 'pending';
    const calls: any[] = [];
    const real = fetch;
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      const u = String(url);
      calls.push({ u, init });
      if (u.endsWith('/v1/payments')) return new Response(JSON.stringify({ id: 777, point_of_interaction: { transaction_data: { qr_code: 'PIXCODE' } } }), { status: 201 });
      if (u.includes('/v1/payments/777')) return new Response(JSON.stringify({ status }), { status: 200 });
      if (u.startsWith('https://93.184.216.34')) return new Response('{}', { status: 200 });
      return real(url, init);
    });
    const p = phone(); await say(p, 'quero');
    const c = await chatOf(p);
    expect(await outs(c.id)).toEqual(['Pague', 'PIXCODE']);
    const charge = calls.find((x) => x.u.endsWith('/v1/payments'));
    expect(charge.init.headers.authorization).toBe('Bearer TOKEN-MP');
    expect(JSON.parse(charge.init.body).transaction_amount).toBe(49.9);
    const url = new URL((await api('GET', '/api/integrations')).body[0].webhookUrl).pathname;
    const notify = () => app.inject({ method: 'POST', url, payload: { type: 'payment', data: { id: '777' } } });
    await notify(); // provedor ainda diz pendente
    expect(await outs(c.id)).toHaveLength(2);
    const sales = (await api('GET', '/api/dashboard')).body.sales;
    status = 'approved';
    await notify(); await notify(); // repetido não duplica
    expect((await outs(c.id)).at(-1)).toBe('Pago!');
    expect((await api('GET', '/api/dashboard')).body.sales).toBe(sales + 1);
    await core.tick();
    const delivered = calls.find((x) => x.u.startsWith('https://93.184.216.34'));
    expect(delivered.init.headers['x-magtron-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(delivered.init.body).event).toBe('sale.approved');
    expect(hook.secret).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: '/hooks/mercadopago/invalido', payload: {} })).statusCode).toBe(404);
  });
  it('sem integração o pagamento segue pelo caminho de erro', async () => {
    const t = await register();
    const c2 = (await call('POST', '/api/connections', { name: 's', provider: 'sandbox' }, t)).body;
    const f = (await call('POST', '/api/flows', { name: 'p', active: true, graph: { nodes: [{ id: 's', type: 'start', data: {} }, { id: 'p', type: 'payment', data: { amount: '10' } }, { id: 'e', type: 'message', data: { text: 'falhou' } }], edges: [edge('s', 'p'), edge('p', 'e', 'error')] } }, t)).body;
    await call('PATCH', `/api/connections/${c2.id}`, { default_flow_id: f.id }, t);
    await call('POST', `/api/connections/${c2.id}/simulate`, { phone: phone(), text: 'oi' }, t);
    const [chat] = (await call('GET', '/api/chats', undefined, t)).body;
    expect(chat.last_message).toBe('falhou');
  });
  it('Facebook sem configuração não quebra', async () => {
    const t = await register();
    expect((await call('GET', '/api/facebook/insights', undefined, t)).body.configured).toBe(false);
  });
  it('relatórios por estado e produto', async () => {
    expect(stateOf('5511999990000')).toBe('SP');
    expect(stateOf('5571999990000')).toBe('BA');
    expect(stateOf('14155550000')).toBe('Outros');
    const d = (await api('GET', '/api/dashboard/details')).body;
    expect(d.byProduct.some((x: any) => x.name === 'Kit')).toBe(true);
    expect(d.byState[0].uf).toBe('RJ');
    expect(d.sales.length).toBeGreaterThan(0);
  });
});
