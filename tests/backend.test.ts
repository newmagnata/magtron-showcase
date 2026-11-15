import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import type { Core } from '../server/core';
import { assertPublicUrl } from '../server/security';

let db: Db; let app: Awaited<ReturnType<typeof buildApp>>['app']; let core: Core;
let token: string; let conn: any; let n = 0;
const AUDIO = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(24, 1)]);
const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16, 2)]);
const fakeAi = async ({ messages }: any) => (messages.at(-1).content.includes('tchau') ? 'Até logo [[FIM]]' : 'Resposta da IA');

const api = async (method: any, url: string, body?: unknown, t = token) => {
  const res = await app.inject({ method, url, payload: body as any, headers: { authorization: `Bearer ${t}` } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const register = async () => (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `u${++n}@teste.test`, password: 'senha-de-teste', name: 'T', company: 'C' } })).json().token as string;
const phone = () => `55119${String(10000000 + ++n)}`;
const say = (p: string, text: string, c = conn) => api('POST', `/api/connections/${c.id}/simulate`, { phone: p, name: 'Ana', text });
const chatOf = async (p: string) => (await api('GET', '/api/chats')).body.find((c: any) => c.contact_phone === p);
const msgs = async (p: string) => (await api('GET', `/api/chats/${(await chatOf(p)).id}/messages`)).body;
const outs = async (p: string) => (await msgs(p)).filter((m: any) => m.direction === 'out').map((m: any) => m.body);
const edge = (source: string, target: string, sourceHandle = 'out') => ({ id: `${source}-${sourceHandle}`, source, target, sourceHandle });
const flow = async (nodes: any[], edges: any[], c: any = conn) => {
  const f = (await api('POST', '/api/flows', { name: `f${++n}`, active: true, graph: { nodes: [{ id: 's', type: 'start', data: {} }, ...nodes], edges } })).body;
  if (c) await api('PATCH', `/api/connections/${c.id}`, { default_flow_id: f.id });
  return f;
};
const runJobsDue = async () => { await db.query(`UPDATE jobs SET run_at = now() WHERE status = 'pending'`); await core.tick(); };

beforeAll(async () => {
  db = await openDb();
  ({ app, core } = await buildApp({ db, secret: 's'.repeat(32), publicUrl: 'http://magtron.test', generate: fakeAi }));
  token = await register();
  conn = (await api('POST', '/api/connections', { name: 'Sandbox', provider: 'sandbox' })).body;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('autenticação e isolamento', () => {
  it('exige token', async () => expect((await app.inject({ url: '/api/flows' })).statusCode).toBe(401));
  it('login funciona e senha errada falha', async () => {
    const payload = { email: 'login@teste.test', password: 'senha-de-teste' };
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { ...payload, name: 'A', company: 'B' } });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...payload, password: 'outra-senha-x' } })).statusCode).toBe(401);
  });
  it('uma conta não vê nem usa dados de outra', async () => {
    const other = await register();
    const f = await flow([], [], null);
    expect((await api('GET', `/api/flows/${f.id}`, undefined, other)).status).toBe(404);
    expect((await api('GET', '/api/connections', undefined, other)).body).toEqual([]);
    const c2 = (await api('POST', '/api/connections', { name: 'x', provider: 'sandbox' }, other)).body;
    expect((await api('POST', '/api/dispatches', { name: 'd', flow_id: f.id, connection_id: c2.id }, other)).status).toBe(400);
  });
  it('nunca devolve segredo da conexão', async () => {
    const c = (await api('POST', '/api/connections', { name: 'e', provider: 'evolution', apiKey: 'chave-secreta' })).body;
    expect(JSON.stringify(c)).not.toContain('chave-secreta');
    expect(c.webhook_token).toBeUndefined();
  });
});

describe('motor de fluxos', () => {
  it('envia, espera menu, segue a opção, etiqueta e registra venda', async () => {
    await api('POST', '/api/global-variables', { key: 'loja', value: 'Magtron' });
    await flow([
      { id: 'm', type: 'message', data: { text: 'Oi {{contact.name}}, aqui é a {{global.loja}}' } },
      { id: 'q', type: 'menu', data: { text: 'Escolha', options: ['Comprar', 'Sair do menu'], variable: 'escolha' } },
      { id: 't', type: 'tags', data: { add: ['COMPROU'] } },
      { id: 'v', type: 'sale', data: { product: 'Kit', amount: '99.90' } },
      { id: 'f', type: 'message', data: { text: 'Você escolheu {{vars.escolha}}' } },
    ], [edge('s', 'm'), edge('m', 'q'), edge('q', 't', 'opt-0'), edge('t', 'v'), edge('v', 'f')]);
    const p = phone();
    await say(p, 'oi');
    expect(await outs(p)).toEqual(['Oi Ana, aqui é a Magtron', 'Escolha\n\n1. Comprar\n2. Sair do menu']);
    await say(p, '9');
    expect((await outs(p)).length).toBe(2);
    await say(p, '1');
    expect((await outs(p)).at(-1)).toBe('Você escolheu Comprar');
    const c = (await api('GET', `/api/contacts?q=${p}`)).body[0];
    expect(c.labels).toEqual(['COMPROU']);
    const d = (await api('GET', '/api/dashboard')).body;
    expect(d.sales).toBeGreaterThan(0);
    expect(d.revenue).toBeCloseTo(99.9);
  });
  it('não reinicia o fluxo a cada mensagem depois de concluído', async () => {
    await flow([{ id: 'm', type: 'message', data: { text: 'boas-vindas' } }], [edge('s', 'm')]);
    const p = phone();
    await say(p, 'a'); await say(p, 'b');
    expect(await outs(p)).toEqual(['boas-vindas']);
  });
  it('condição, manipulador e delay com fila', async () => {
    await flow([
      { id: 'w', type: 'manipulator', data: { field: 'cor', value: 'azul' } },
      { id: 'c', type: 'condition', data: { left: '{{contact.cor}}', op: 'eq', right: 'AZUL' } },
      { id: 'd', type: 'delay', data: { seconds: 60 } },
      { id: 'y', type: 'message', data: { text: 'sim' } },
      { id: 'n', type: 'message', data: { text: 'não' } },
    ], [edge('s', 'w'), edge('w', 'c'), edge('c', 'd', 'true'), edge('c', 'n', 'false'), edge('d', 'y')]);
    const p = phone();
    await say(p, 'x');
    expect(await outs(p)).toEqual([]);
    await runJobsDue();
    expect(await outs(p)).toEqual(['sim']);
  });
  it('aguarda resposta e segue caminho de timeout', async () => {
    await flow([
      { id: 'w', type: 'wait_reply', data: { variable: 'r', timeoutMin: 5 } },
      { id: 'a', type: 'message', data: { text: 'recebi {{vars.r}}' } },
      { id: 't', type: 'message', data: { text: 'sumiu' } },
    ], [edge('s', 'w'), edge('w', 'a'), edge('w', 't', 'timeout')]);
    const p1 = phone(); await say(p1, 'oi'); await say(p1, 'resposta');
    expect(await outs(p1)).toEqual(['recebi resposta']);
    const p2 = phone(); await say(p2, 'oi'); await runJobsDue();
    expect(await outs(p2)).toEqual(['sumiu']);
  });
  it('agente de IA conversa até [[FIM]] e segue o fluxo', async () => {
    const agent = (await api('POST', '/api/ai-agents', { name: 'A', prompt: 'Atenda' })).body;
    await flow([
      { id: 'a', type: 'ai_agent', data: { agentId: agent.id } },
      { id: 'f', type: 'message', data: { text: 'encerrado' } },
    ], [edge('s', 'a'), edge('a', 'f')]);
    const p = phone();
    await say(p, 'oi'); await say(p, 'tchau');
    expect(await outs(p)).toEqual(['Resposta da IA', 'Até logo', 'encerrado']);
  });
  it('atendente humano assume e cancela a automação', async () => {
    await flow([{ id: 'w', type: 'wait_reply', data: {} }, { id: 'm', type: 'message', data: { text: 'bot' } }], [edge('s', 'w'), edge('w', 'm')]);
    const p = phone(); await say(p, 'oi');
    const chat = await chatOf(p);
    await api('POST', `/api/chats/${chat.id}/messages`, { text: 'humano' });
    await say(p, 'resposta');
    expect(await outs(p)).toEqual(['humano']);
  });
  it('registra contadores por bloco e falha com laço infinito', async () => {
    const f = await flow([{ id: 'x', type: 'tags', data: {} }], [edge('s', 'x'), edge('x', 's')]);
    await say(phone(), 'oi');
    const [run] = await db.query('SELECT status, error FROM flow_runs WHERE flow_id = $1', [f.id]);
    expect(run.status).toBe('failed');
    expect((await api('GET', `/api/flows/${f.id}/stats`)).body.length).toBe(2);
  });
  it('bloqueia HTTP para rede privada', async () => {
    const old = process.env.ALLOW_PRIVATE_URLS; process.env.ALLOW_PRIVATE_URLS = 'false';
    try {
      await expect(assertPublicUrl('http://127.0.0.1:5432')).rejects.toThrow();
      await expect(assertPublicUrl('http://169.254.169.254/latest')).rejects.toThrow();
      await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    } finally { process.env.ALLOW_PRIVATE_URLS = old; }
  });
});

describe('opt-out e disparos', () => {
  it('quem pede para sair não recebe disparo', async () => {
    await flow([], [edge('s', 's')], null);
    const p = phone();
    await say(p, 'oi'); await say(p, 'SAIR');
    expect((await api('GET', `/api/contacts?q=${p}`)).body[0].opted_out).toBe(true);
    const c = (await api('POST', '/api/connections', { name: 'd', provider: 'sandbox' })).body;
    const f = await flow([{ id: 'm', type: 'message', data: { text: 'promo' } }], [edge('s', 'm')], null);
    const ok = phone();
    await api('POST', '/api/contacts', { phone: ok, name: 'Bia' });
    const d = (await api('POST', '/api/dispatches', { name: 'Promo', flow_id: f.id, connection_id: c.id, per_minute: 60 })).body;
    const items = await db.query('SELECT contact_id FROM dispatch_items WHERE dispatch_id = $1', [d.id]);
    for (let i = 0; i <= items.length; i++) await runJobsDue();
    const row = (await api('GET', '/api/dispatches')).body.find((x: any) => x.id === d.id);
    expect(row.status).toBe('done');
    expect(row.sent).toBe(items.length);
    const out = await db.query(`SELECT 1 FROM messages m JOIN chats ch ON ch.id = m.chat_id JOIN contacts co ON co.id = ch.contact_id WHERE co.phone = $1 AND m.body = 'promo'`, [p]);
    expect(out.length).toBe(0);
  });
  it('webhook de entrada inicia fluxo com mapeamento', async () => {
    const f = await flow([{ id: 'm', type: 'message', data: { text: 'Pedido recebido' } }], [edge('s', 'm')], null);
    const hook = (await api('POST', '/api/inbound-webhooks', { name: 'h', flow_id: f.id, connection_id: conn.id, mapping: { phone: 'cliente.fone', name: 'cliente.nome' } })).body;
    const p = phone();
    const res = await app.inject({ method: 'POST', url: new URL(hook.url).pathname, payload: { cliente: { fone: `+${p}`, nome: 'Caio' } } });
    expect(res.statusCode).toBe(200);
    expect(await outs(p)).toEqual(['Pedido recebido']);
  });
  it('importa e exporta CSV', async () => {
    const r = await api('POST', '/api/contacts/import', { csv: 'nome,telefone\nJoão,5511988887777\n,lixo' });
    expect(r.body.imported).toBe(1);
    const res = await app.inject({ url: '/api/contacts/export', headers: { authorization: `Bearer ${token}` } });
    expect(res.body).toContain('"João","5511988887777"');
  });
});

describe('provedor Evolution (servidor falso)', () => {
  it('cria instância, processa webhook e envia resposta', async () => {
    const calls: { url: string; body: any; key: unknown }[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push({ url: req.url!, body: raw ? JSON.parse(raw) : null, key: req.headers.apikey });
        res.setHeader('content-type', 'application/json');
        if (req.url!.startsWith('/instance/connectionState')) { res.statusCode = 404; return res.end('{}'); }
        if (req.url!.startsWith('/instance/connect/')) return res.end(JSON.stringify({ base64: 'data:image/png;base64,QR' }));
        if (req.url!.startsWith('/message/')) return res.end(JSON.stringify({ key: { id: 'EVO1' } }));
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const c = (await api('POST', '/api/connections', { name: 'evo', provider: 'evolution', config: { baseUrl }, apiKey: 'k1' })).body;
    expect((await api('POST', `/api/connections/${c.id}/connect`)).body.qr).toContain('base64');
    const create = calls.find((x) => x.url === '/instance/create')!;
    expect(create.key).toBe('k1');
    expect(create.body.webhook.url).toMatch(/^http:\/\/magtron\.test\/hooks\/evolution\//);
    await flow([{ id: 'm', type: 'message', data: { text: 'olá via evolution' } }], [edge('s', 'm')], c);
    const path = new URL(create.body.webhook.url).pathname;
    const p = phone();
    const upsert = { event: 'messages.upsert', data: { key: { remoteJid: `${p}@s.whatsapp.net`, fromMe: false, id: 'A1' }, pushName: 'Rui', message: { conversation: 'oi' } } };
    await app.inject({ method: 'POST', url: path, payload: upsert });
    await app.inject({ method: 'POST', url: path, payload: upsert }); // duplicado
    await app.inject({ method: 'POST', url: path, payload: { ...upsert, data: { ...upsert.data, key: { ...upsert.data.key, remoteJid: '123@g.us', id: 'G' } } } });
    const lidPhone = phone();
    await app.inject({ method: 'POST', url: path, payload: { event: 'messages.upsert', data: { key: { remoteJid: '99887766@lid', remoteJidAlt: `${lidPhone}@s.whatsapp.net`, fromMe: false, id: 'L1' }, pushName: 'Lia', message: { conversation: 'oi' } } } });
    expect((await api('GET', `/api/contacts?q=${lidPhone}`)).body).toHaveLength(1);
    expect((await api('GET', '/api/contacts?q=99887766')).body).toHaveLength(0);
    calls.splice(0, calls.length, ...calls.filter((x) => (x.body?.number ?? p) === p));
    const sent = calls.filter((x) => x.url.startsWith('/message/sendText'));
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ number: p, text: 'olá via evolution' });
    await app.inject({ method: 'POST', url: path, payload: { event: 'connection.update', data: { state: 'open' } } });
    expect((await api('GET', '/api/connections')).body.find((x: any) => x.id === c.id).status).toBe('connected');
    server.close();
  });
});

describe('bloco Mensagem com vários conteúdos', () => {
  it('envia texto, áudio, vídeo com legenda, arquivo e respeita o formato antigo', async () => {
    await flow([{ id: 'm', type: 'message', data: { items: [
      { type: 'text', text: 'Oi {{contact.name}}', typingSec: 3 },
      { type: 'audio', url: 'https://cdn.test/a.mp3', recordingSec: 5 },
      { type: 'delay', seconds: 0 },
      { type: 'video', url: 'https://cdn.test/v.mp4', caption: 'olha 👆' },
      { type: 'file', url: 'https://cdn.test/f.pdf' },
      { type: 'text', text: '   ' },
    ] } }], [edge('s', 'm')]);
    const p = phone();
    await say(p, 'oi');
    const out = (await msgs(p)).filter((m: any) => m.direction === 'out');
    expect(out.map((m: any) => m.body)).toEqual(['Oi Ana', '', 'olha 👆', '']);
    expect(out.map((m: any) => m.media_url)).toEqual([null, 'https://cdn.test/a.mp3', 'https://cdn.test/v.mp4', 'https://cdn.test/f.pdf']);

    await flow([{ id: 'm', type: 'message', data: { text: 'legenda antiga', mediaUrl: 'https://cdn.test/i.webp', mediaType: 'image' } }], [edge('s', 'm')]);
    const q = phone();
    await say(q, 'oi');
    expect((await msgs(q)).filter((m: any) => m.direction === 'out').map((m: any) => [m.body, m.media_url])).toEqual([['legenda antiga', 'https://cdn.test/i.webp']]);
  });

  it('avisa nas notificações e para o fluxo quando um conteúdo falha', async () => {
    await flow([{ id: 'm', type: 'message', data: { items: [{ type: 'audio', url: '' }] } }], [edge('s', 'm')]);
    const p = phone();
    await say(p, 'oi');
    const notes = (await api('GET', '/api/notifications')).body as any[];
    expect(notes.some((x) => x.body.includes('Falha no bloco Mensagem') && x.body.includes('sem arquivo'))).toBe(true);
  });

  it('na Evolution manda arquivo próprio em base64 (sem endereço interno), com gravando/digitando e voz', async () => {
    const calls: { url: string; body: any }[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => { calls.push({ url: req.url!, body: raw ? JSON.parse(raw) : null }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ key: { id: `E${calls.length}` } })); });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const c = (await api('POST', '/api/connections', { name: 'evo2', provider: 'evolution', config: { baseUrl }, apiKey: 'k2' })).body;
    const audio = (await api('POST', '/api/media', { filename: 'voz.mp3', mime: 'audio/mpeg', base64: AUDIO.toString('base64') })).body;
    const video = (await api('POST', '/api/media', { filename: 'v.mp4', mime: 'video/mp4', base64: VIDEO.toString('base64') })).body;
    expect(audio.url.startsWith('http://magtron.test/media/')).toBe(true);
    const f = await flow([{ id: 'm', type: 'message', data: { items: [
      { type: 'text', text: 'oi', typingSec: 4 },
      { type: 'audio', url: audio.url, recordingSec: 20 },
      { type: 'video', url: video.url, caption: 'legenda' },
    ] } }], [edge('s', 'm')], c);
    const ctx = await core.db.query('SELECT webhook_token FROM connections WHERE id = $1', [c.id]);
    const p = phone();
    await app.inject({ method: 'POST', url: `/hooks/evolution/${ctx[0].webhook_token}`, payload: { event: 'messages.upsert', data: { key: { remoteJid: `${p}@s.whatsapp.net`, fromMe: false, id: 'M1' }, pushName: 'Rui', message: { conversation: 'oi' } } } });
    for (let i = 0; i < 50 && calls.filter((x) => x.url.startsWith('/message/')).length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    const sent = calls.filter((x) => x.url.startsWith('/message/'));
    expect(sent.map((x) => x.url.split('/')[2])).toEqual(['sendText', 'sendWhatsAppAudio', 'sendMedia']);
    expect(sent[0].body).toEqual({ number: p, text: 'oi', delay: 4000 });
    expect(sent[1].body).toEqual({ number: p, audio: AUDIO.toString('base64'), encoding: true, delay: 20000 });
    expect(sent[2].body).toEqual({ number: p, mediatype: 'video', media: VIDEO.toString('base64'), caption: 'legenda', fileName: 'v.mp4', mimetype: 'video/mp4' });
    expect(f.id).toBeTruthy();
    server.close();
  });
});

describe('comprovante de pagamento (imagem ou PDF)', () => {
  const send = (p: string, text: string, media?: string) => api('POST', `/api/connections/${conn.id}/simulate`, { phone: p, name: 'Ana', text, media });
  const notes = async () => ((await api('GET', '/api/notifications')).body as any[]).map((x) => x.body as string);

  it('espera só imagem/PDF: texto cai em "other" e a imagem segue o fluxo sem aviso duplicado', async () => {
    await flow([
      { id: 'w', type: 'wait_reply', data: { mediaOnly: 'yes', timeoutMin: 60 } },
      { id: 'no', type: 'message', data: { text: 'me manda o comprovante' } },
      { id: 'ok', type: 'message', data: { text: 'recebi o comprovante' } },
      { id: 'n', type: 'notify', data: { text: 'COMPROVANTE de {{contact.name}}' } },
    ], [edge('s', 'w'), edge('w', 'ok', 'out'), edge('w', 'no', 'other'), edge('no', 'w'), edge('ok', 'n')]);
    const p = phone();
    await send(p, 'oi');
    await send(p, 'já paguei');
    expect(await outs(p)).toEqual(['me manda o comprovante']);
    await send(p, '', 'video');            // vídeo não conta como comprovante
    expect(await outs(p)).toEqual(['me manda o comprovante', 'me manda o comprovante']);
    await send(p, '', 'image');
    expect(await outs(p)).toEqual(['me manda o comprovante', 'me manda o comprovante', 'recebi o comprovante']);
    expect((await msgs(p)).filter((m: any) => m.direction === 'in').map((m: any) => m.body)).toContain('[imagem]');
    const all = await notes();
    expect(all.filter((x) => x.includes('COMPROVANTE de Ana')).length).toBe(1);
    expect(all.some((x) => x.includes('enviou uma imagem') && x.includes(p))).toBe(false); // o fluxo já avisou
  });

  it('aceita PDF e o tempo limite continua valendo depois de respostas de texto', async () => {
    await flow([
      { id: 'w', type: 'wait_reply', data: { mediaOnly: 'yes', timeoutMin: 60 } },
      { id: 'ok', type: 'message', data: { text: 'ok pdf' } },
      { id: 'late', type: 'message', data: { text: 'sem comprovante' } },
    ], [edge('s', 'w'), edge('w', 'ok', 'out'), edge('w', 'late', 'timeout')]);
    const p = phone();
    await send(p, 'oi'); await send(p, 'pera aí');     // sem "other": continua esperando em silêncio
    expect(await outs(p)).toEqual([]);
    await runJobsDue();                                 // dispara o tempo limite que foi reagendado
    expect(await outs(p)).toEqual(['sem comprovante']);
    const q = phone();
    await send(q, 'oi'); await send(q, '', 'document');
    expect(await outs(q)).toEqual(['ok pdf']);
  });

  it('"Rodar fluxo" dispara um fluxo à mão, interrompe o atual e respeita a empresa', async () => {
    const wait = await flow([{ id: 'w', type: 'wait_reply', data: {} }], [edge('s', 'w')]);
    const thanks = await flow([{ id: 'm', type: 'message', data: { text: 'obrigada pela compra' } }], [edge('s', 'm')], null);
    const p = phone(); await say(p, 'oi');
    const chat = await chatOf(p);
    expect((await api('POST', `/api/chats/${chat.id}/run-flow`, { flow_id: thanks.id })).status).toBe(202);
    expect(await outs(p)).toEqual(['obrigada pela compra']);
    const [{ n }] = await db.query(`SELECT COUNT(*)::int AS n FROM flow_runs WHERE chat_id = $1 AND flow_id = $2 AND status = 'cancelled'`, [chat.id, wait.id]);
    expect(n).toBe(1);
    const other = await register();
    expect((await api('POST', `/api/chats/${chat.id}/run-flow`, { flow_id: thanks.id }, other)).status).toBe(404);
  });

  it('imagem ou PDF fora de uma espera de comprovante avisa a equipe; sticker e áudio não', async () => {
    await flow([{ id: 'm', type: 'message', data: { text: 'oi' } }], [edge('s', 'm')]);
    const p = phone();
    await send(p, 'oi'); await send(p, '', 'document'); await send(p, '', 'sticker'); await send(p, '', 'audio');
    const mine = (await notes()).filter((x) => x.includes(p));
    expect(mine.length).toBe(1);
    expect(mine[0]).toContain('PDF/documento');
  });
});
