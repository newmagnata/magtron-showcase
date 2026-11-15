import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import type { Core } from '../server/core';
import { pickWeighted, withCode } from '../server/modules2';

let db: Db; let app: Awaited<ReturnType<typeof buildApp>>['app']; let core: Core;
let owner: string; let conn: any; let n = 0;

const call = async (method: any, url: string, body: unknown, t: string) => {
  const res = await app.inject({ method, url, payload: body as any, headers: { authorization: `Bearer ${t}` } });
  return { status: res.statusCode, body: res.body && res.headers['content-type']?.toString().includes('json') ? JSON.parse(res.body) : res.body, res };
};
const api = (m: any, u: string, b?: unknown) => call(m, u, b, owner);
const register = async () => (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `s${++n}@teste.test`, password: 'senha-de-teste', name: 'T', company: 'C' } })).json().token as string;
const phone = () => `55319${String(30000000 + ++n)}`;
const edge = (source: string, target: string, sourceHandle = 'out') => ({ id: `${source}-${sourceHandle}`, source, target, sourceHandle });
const flow = async (text: string, extra: any[] = [], edges: any[] = []) => (await api('POST', '/api/flows', { name: `f${++n}`, active: true, graph: { nodes: [{ id: 's', type: 'start', data: {} }, { id: 'm', type: 'message', data: { text } }, ...extra], edges: [edge('s', 'm'), ...edges] } })).body;
const slots = (id: string, body: object) => api('PUT', `/api/connections/${id}/flows`, body);
const say = (p: string, text: string, c = conn) => api('POST', `/api/connections/${c.id}/simulate`, { phone: p, name: 'Ana', text });
const outs = async (p: string) => { const chat = (await api('GET', '/api/chats')).body.find((c: any) => c.contact_phone === p); return chat ? (await api('GET', `/api/chats/${chat.id}/messages`)).body.filter((m: any) => m.direction === 'out').map((m: any) => m.body) : []; };
const due = async () => { await db.query(`UPDATE jobs SET run_at = now() WHERE status = 'pending'`); await core.tick(); };

beforeAll(async () => {
  db = await openDb();
  ({ app, core } = await buildApp({ db, secret: 'y'.repeat(32), publicUrl: 'https://magtron.test', generate: async () => '' }));
  owner = await register();
  conn = (await api('POST', '/api/connections', { name: 'S', provider: 'sandbox' })).body;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('fluxos padrões', () => {
  it('boas-vindas, resposta padrão e palavra-chave', async () => {
    const welcome = await flow('bem-vindo'); const standard = await flow('resposta padrão'); const promo = await flow('promoção');
    expect((await slots(conn.id, { welcome: welcome.id, default: standard.id })).status).toBe(200);
    await api('POST', `/api/connections/${conn.id}/keywords`, { keyword: 'PROMO', flow_id: promo.id });
    const p = phone(); await say(p, 'oi'); await say(p, 'e agora?');
    expect(await outs(p)).toEqual(['bem-vindo', 'resposta padrão']);
    await say(p, 'quero a promo');
    expect((await outs(p)).at(-1)).toBe('promoção');
    const state = (await api('GET', '/api/connection-flows')).body;
    expect(state.filter((s: any) => s.connection_id === conn.id).map((s: any) => s.slot).sort()).toEqual(['default', 'welcome']);
  });
  it('PATCH default_flow_id continua definindo a boas-vindas', async () => {
    const f = await flow('compat');
    await api('PATCH', `/api/connections/${conn.id}`, { default_flow_id: f.id });
    expect((await api('GET', '/api/connection-flows')).body.find((s: any) => s.slot === 'welcome').flow_id).toBe(f.id);
    await slots(conn.id, { default: null });
    expect((await api('GET', '/api/connection-flows')).body.some((s: any) => s.slot === 'default')).toBe(false);
  });
  it('conversa finalizada (fluxo) e atendimento finalizado (humano)', async () => {
    await slots(conn.id, { welcome: null, default: null });
    const done = await flow('Conversa encerrada pelo fluxo');
    const ended = await flow('Atendimento encerrado');
    const entry = await flow('olá', [{ id: 'c', type: 'chat_control', data: { status: 'resolved' } }], [edge('m', 'c')]);
    await slots(conn.id, { welcome: entry.id, finished: done.id, ended: ended.id });
    const p = phone(); await say(p, 'oi');
    await due();
    expect(await outs(p)).toEqual(['olá', 'Conversa encerrada pelo fluxo']);
    const chat = (await api('GET', '/api/chats')).body.find((c: any) => c.contact_phone === p);
    await db.query(`UPDATE flow_runs SET status = 'done' WHERE chat_id = $1`, [chat.id]);
    await api('PATCH', `/api/chats/${chat.id}`, { status: 'resolved' });
    expect((await outs(p)).at(-1)).toBe('Atendimento encerrado');
  });
  it('não aceita fluxo ou conexão de outra empresa', async () => {
    const other = await register();
    const f = await flow('x');
    const c2 = (await call('POST', '/api/connections', { name: 'o', provider: 'sandbox' }, other)).body;
    expect((await call('PUT', `/api/connections/${c2.id}/flows`, { welcome: f.id }, other)).status).toBe(400);
    expect((await call('PUT', `/api/connections/${conn.id}/flows`, { welcome: null }, other)).status).toBe(404);
  });
});

describe('pastas', () => {
  it('cria, lista, move fluxo e exclui sem apagar fluxos', async () => {
    await api('POST', '/api/flow-folders', { name: 'Vendas' });
    const f = await flow('p'); await api('PATCH', `/api/flows/${f.id}`, { folder: 'Vendas' });
    await api('POST', '/api/flow-folders', { name: 'Vazia' });
    expect((await api('GET', '/api/flow-folders')).body).toEqual(['Vazia', 'Vendas']);
    await api('DELETE', '/api/flow-folders/Vendas');
    expect((await api('GET', `/api/flows/${f.id}`)).body.folder).toBeNull();
  });
});

describe('trackeamento', () => {
  it('sorteio ponderado e código na frase', () => {
    expect(pickWeighted([{ percent: 30, id: 'a' }, { percent: 70, id: 'b' }], 0.2)?.id).toBe('a');
    expect(pickWeighted([{ percent: 30, id: 'a' }, { percent: 70, id: 'b' }], 0.5)?.id).toBe('b');
    expect(withCode('Olá, gostaria de receber as informações', 'a1b2c3')).toBe('Olá, a1b2c3 gostaria de receber as informações');
  });
  it('link redireciona ao WhatsApp, registra o clique e atribui o lead', async () => {
    const c = (await api('POST', '/api/connections', { name: 'Anúncios', provider: 'sandbox' })).body;
    expect((await api('PATCH', `/api/connections/${c.id}`, { phone: '5511988887777' })).status).toBe(200);
    const pixel = (await api('POST', '/api/tracking/pixels', { name: 'TT', platform: 'tiktok', pixel_code: 'PX1', token: 'segredo-do-pixel' })).body;
    expect(JSON.stringify((await api('GET', '/api/tracking/pixels')).body)).not.toContain('segredo-do-pixel');
    const body = { name: 'Campanha', platform: 'tiktok', pixel_id: pixel.id, message: 'Olá, gostaria de receber as informações', distribution: [{ connection_id: c.id, percent: 100 }] };
    expect((await api('POST', '/api/tracking/links', { ...body, distribution: [{ connection_id: c.id, percent: 60 }] })).status).toBe(400);
    expect((await api('POST', '/api/tracking/links', { ...body, message: 'Oi' })).status).toBe(400);
    const link = (await api('POST', '/api/tracking/links', body)).body;
    const res = await app.inject({ url: `/t/${link.slug}?ttclid=abc123` });
    expect(res.statusCode).toBe(302);
    const target = new URL(String(res.headers.location));
    expect(target.origin + target.pathname).toBe('https://wa.me/5511988887777');
    const text = target.searchParams.get('text')!;
    const code = /^Olá, ([0-9a-f]{6}) gostaria/.exec(text)![1];
    const p = phone();
    await say(p, text, c);
    const contact = (await api('GET', `/api/contacts?q=${p}`)).body[0];
    expect(contact.fields).toMatchObject({ tracking_link: 'Campanha', ttclid: 'abc123' });
    const row = (await api('GET', '/api/tracking/links')).body.find((l: any) => l.id === link.id);
    expect(row).toMatchObject({ clicks: 1, leads: 1 });
    const again = phone();
    await say(again, `Olá, ${code} de novo`, c); // o código só vale uma vez
    expect((await api('GET', `/api/contacts?q=${again}`)).body[0].fields.tracking_link).toBeUndefined();
    expect((await app.inject({ url: '/t/inexistente' })).statusCode).toBe(404);
  });
  it('sem número disponível devolve 503', async () => {
    const c = (await api('POST', '/api/connections', { name: 'Sem número', provider: 'sandbox' })).body;
    const link = (await api('POST', '/api/tracking/links', { name: 'X', platform: 'kwai', message: 'Olá, tudo bem?', distribution: [{ connection_id: c.id, percent: 100 }], fallback: 'none' })).body;
    expect((await app.inject({ url: `/t/${link.slug}` })).statusCode).toBe(503);
  });
});

describe('servidor MCP', () => {
  let token: string; let credId: string;
  const rpc = (t: string | null, body: unknown) => app.inject({ method: 'POST', url: '/mcp', payload: body as any, headers: t ? { authorization: `Bearer ${t}` } : {} });
  const tool = async (name: string, args: object = {}, t = token) => (await rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json().result;
  it('exige credencial válida', async () => {
    const made = (await api('POST', '/api/mcp/credentials', { name: 'Claude' })).body;
    token = made.token; credId = made.id;
    expect(token).toMatch(/^mgt_/);
    expect(JSON.stringify((await api('GET', '/api/mcp/credentials')).body)).not.toContain(token);
    expect((await rpc(null, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode).toBe(401);
    expect((await rpc('mgt_errado', { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode).toBe(401);
    expect((await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
  });
  it('initialize, lista ferramentas e gerencia fluxos', async () => {
    const init = (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(init.result.serverInfo.name).toBe('magtron');
    const list = (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools.map((t: any) => t.name);
    expect(list).toEqual(expect.arrayContaining(['list_flows', 'create_flow', 'update_flow', 'list_node_types']));
    expect(list).not.toContain('delete_flow');
    const created = JSON.parse((await tool('create_flow', { name: 'Via MCP' })).content[0].text);
    expect(created.active).toBe(false);
    const bad = await tool('update_flow', { flow_id: created.id, graph: { nodes: [{ id: 's', type: 'start', data: {} }, { id: 'x', type: 'inexistente', data: {} }], edges: [] } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('tipo de bloco desconhecido');
    const good = await tool('update_flow', { flow_id: created.id, graph: { nodes: [{ id: 's', type: 'start', data: {} }, { id: 'm', type: 'message', data: { text: 'oi' } }], edges: [{ source: 's', target: 'm' }] } });
    expect(JSON.parse(good.content[0].text).blocks).toBe(2);
    expect((await api('GET', `/api/flows/${created.id}`)).body.graph.edges).toHaveLength(1);
  });
  it('isola contas e revoga', async () => {
    const other = await register();
    const otherToken = (await call('POST', '/api/mcp/credentials', { name: 'x' }, other)).body.token;
    const flows = JSON.parse((await tool('list_flows', {}, otherToken)).content[0].text);
    expect(flows).toEqual([]);
    const mine = JSON.parse((await tool('list_flows')).content[0].text)[0];
    expect((await tool('get_flow', { flow_id: mine.id }, otherToken)).isError).toBe(true);
    await api('DELETE', `/api/mcp/credentials/${credId}`);
    expect((await rpc(token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode).toBe(401);
  });
});
