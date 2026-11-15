import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app';
import { openDb, type Db } from '../server/db';
import { contentMatchesType, cleanFilename, hashPassword, verifyPassword } from '../server/security';
import { LoginGuard } from '../server/audit';

let db: Db; let app: Awaited<ReturnType<typeof buildApp>>['app']; let core: Awaited<ReturnType<typeof buildApp>>['core'];
let owner: string; let n = 0;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PASS = 'senha-de-teste-forte';

const call = async (method: any, url: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method, url, payload: body as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: res.statusCode, headers: res.headers, body: res.body ? (() => { try { return JSON.parse(res.body); } catch { return res.body; } })() : null };
};
const register = async (email = `u${++n}@teste.test`) => (await call('POST', '/api/auth/register', { email, password: PASS, name: 'T', company: 'C' })).body.token as string;
const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
};
const events = async (token: string) => (await call('GET', '/api/security/events', undefined, token)).body as any[];

beforeAll(async () => {
  db = await openDb();
  ({ app, core } = await buildApp({ db, secret: 's'.repeat(32), publicUrl: 'https://magtron.test' }));
  owner = await register();
});
afterAll(async () => { await app.close(); await db.close(); });

describe('cabeçalhos de segurança', () => {
  it('manda CSP, nosniff, anti-iframe, HSTS e bloqueia cache da API', async () => {
    const r = await call('GET', '/api/me', undefined, owner);
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).not.toContain("'unsafe-eval'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
  it('não libera CORS para outros sites', async () => {
    const r = await app.inject({ method: 'OPTIONS', url: '/api/flows', headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('redireciona http para https quando a URL pública é https', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-forwarded-proto': 'http' } });
    expect(r.statusCode).toBe(308);
    expect(r.headers.location).toBe('https://magtron.test/api/me');
  });
});

describe('cadastro, login e senhas', () => {
  it('fecha o cadastro depois do primeiro usuário e registra a tentativa', async () => {
    await withEnv({ ALLOW_REGISTRATION: undefined }, async () => {
      const r = await call('POST', '/api/auth/register', { email: 'intruso@teste.test', password: PASS, name: 'X', company: 'X' });
      expect(r.status).toBe(403);
    });
    expect((await events(owner)).length).toBeGreaterThanOrEqual(0); // evento de IP sem conta não aparece para empresas
    const rows = await db.query(`SELECT 1 FROM security_events WHERE kind = 'register_blocked'`);
    expect(rows.length).toBe(1);
  });
  it('libera o cadastro só na primeira instalação', async () => {
    const fresh = await openDb();
    const { app: a2 } = await buildApp({ db: fresh, secret: 's'.repeat(32), publicUrl: 'http://x.test' });
    await withEnv({ ALLOW_REGISTRATION: undefined }, async () => {
      const first = await a2.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'dono@teste.test', password: PASS, name: 'D', company: 'E' } });
      const second = await a2.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'outro@teste.test', password: PASS, name: 'D', company: 'E' } });
      expect([first.statusCode, second.statusCode]).toEqual([201, 403]);
    });
    await a2.close(); await fresh.close();
  });
  it('recusa senha nova curta e guarda só o hash (scrypt com sal)', async () => {
    expect((await call('POST', '/api/auth/register', { email: 'curta@teste.test', password: '123456789', name: 'C', company: 'C' })).status).toBe(400);
    const [u] = await db.query(`SELECT password_hash FROM users LIMIT 1`);
    expect(u.password_hash).not.toContain(PASS);
    expect(u.password_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    const h1 = await hashPassword('abc'); const h2 = await hashPassword('abc');
    expect(h1).not.toBe(h2);
    expect(await verifyPassword('abc', h1)).toBe(true);
    expect(await verifyPassword('abd', h1)).toBe(false);
  });
  it('responde igual para e-mail inexistente e senha errada, e trava depois de várias tentativas', async () => {
    const email = `alvo${++n}@teste.test`; await register(email);
    const ghost = await call('POST', '/api/auth/login', { email: `nao-existe${n}@teste.test`, password: 'qualquer-coisa' });
    const wrong = await call('POST', '/api/auth/login', { email, password: 'errada-errada' });
    expect([ghost.status, ghost.body]).toEqual([wrong.status, wrong.body]);
    for (let i = 0; i < 7; i++) await call('POST', '/api/auth/login', { email, password: `errada-${i}` });
    const locked = await call('POST', '/api/auth/login', { email, password: PASS });
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
  });
  it('avisa o dono e registra os eventos do login travado', async () => {
    const token = await register(`vigiado${++n}@teste.test`);
    const email = `vigiado${n}@teste.test`;
    for (let i = 0; i < 8; i++) await call('POST', '/api/auth/login', { email, password: `errada-${i}` });
    const kinds = (await events(token)).map((e) => e.kind);
    expect(kinds).toContain('login_failed');
    expect(kinds).toContain('login_locked');
    const notes = (await call('GET', '/api/notifications', undefined, token)).body as any[];
    expect(notes.some((x) => x.body.includes('travado'))).toBe(true);
  });
  it('LoginGuard destrava depois do sucesso e conta por janela', () => {
    const g = new LoginGuard(3, 1000);
    expect([g.fail('a'), g.fail('a'), g.fail('a')]).toEqual([false, false, true]);
    expect(g.locked('a')).toBeGreaterThan(0);
    g.ok('a'); expect(g.locked('a')).toBe(0);
  });
});

describe('tokens e permissões', () => {
  it('recusa token adulterado, sem assinatura (alg none) e de outra chave', async () => {
    const [h, p, s] = owner.split('.');
    expect((await call('GET', '/api/me', undefined, `${h}.${p}.${s.slice(0, -2)}xx`)).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    expect((await call('GET', '/api/me', undefined, none)).status).toBe(401);
    const forged = app.jwt.sign({ uid: 'x', aid: 'y' }, { key: 'outra-chave-qualquer-0123456789abcd' } as any);
    expect((await call('GET', '/api/me', undefined, forged)).status).toBe(401);
  });
  it('token de quem saiu da empresa deixa de valer na hora', async () => {
    const t = await register(); const { uid, aid } = app.jwt.decode(t) as any;
    expect((await call('GET', '/api/me', undefined, t)).status).toBe(200);
    await db.query('DELETE FROM memberships WHERE user_id = $1 AND account_id = $2', [uid, aid]);
    expect((await call('GET', '/api/me', undefined, t)).status).toBe(401);
  });
  it('atendente não escreve em rotas de admin nem lê credenciais, integrações ou eventos de segurança', async () => {
    const agentEmail = `agente${++n}@teste.test`;
    const invite = (await call('POST', '/api/team/invites', { email: agentEmail, role: 'agent' }, owner)).body;
    const acc = await call('POST', `/api/auth/invite/${invite.url.split('/').pop()}`, { password: PASS, name: 'Ag' });
    const agent = acc.body.token as string;
    expect((await call('POST', '/api/flows', { name: 'x' }, agent)).status).toBe(403);
    expect((await call('POST', '/api/team/invites', { email: 'a@b.co', role: 'admin' }, agent)).status).toBe(403);
    expect((await call('GET', '/api/mcp/credentials', undefined, agent)).status).toBe(403);
    expect((await call('GET', '/api/integrations', undefined, agent)).status).toBe(403);
    expect((await call('GET', '/api/security/events', undefined, agent)).status).toBe(403);
    expect((await events(owner)).some((e) => e.kind === 'forbidden')).toBe(true);
  });
  it('convite com senha curta é recusado para conta nova', async () => {
    const invite = (await call('POST', '/api/team/invites', { email: `novo${++n}@teste.test`, role: 'agent' }, owner)).body;
    const r = await call('POST', `/api/auth/invite/${invite.url.split('/').pop()}`, { password: 'curta123', name: 'N' });
    expect(r.status).toBe(400);
  });
  it('convite expira em 7 dias', async () => {
    const invite = (await call('POST', '/api/team/invites', { email: `velho${++n}@teste.test`, role: 'agent' }, owner)).body;
    const tok = invite.url.split('/').pop();
    await db.query(`UPDATE invitations SET created_at = now() - interval '8 days' WHERE token = $1`, [tok]);
    expect((await call('GET', `/api/auth/invite/${tok}`)).status).toBe(404);
  });
  it('isola empresas e ignora campos extras (mass assignment)', async () => {
    const other = await register();
    const { aid: otherAid } = app.jwt.decode(other) as any;
    const f = (await call('POST', '/api/flows', { name: 'meu', account_id: otherAid }, owner)).body;
    expect(f.account_id).not.toBe(otherAid);
    expect((await call('PATCH', `/api/flows/${f.id}`, { name: 'roubado', account_id: otherAid }, other)).status).toBe(404);
    expect((await call('GET', `/api/flows/${f.id}`, undefined, other)).status).toBe(404);
  });
});

describe('injeção e XSS', () => {
  it('busca com aspas e SQL não vaza nem quebra (consulta parametrizada)', async () => {
    await call('POST', '/api/contacts', { name: 'Ana', phone: '5511900000001' }, owner);
    for (const q of ["' OR '1'='1", "'; DROP TABLE users; --", '%', '\\']) {
      const r = await call('GET', `/api/contacts?q=${encodeURIComponent(q)}`, undefined, owner);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    }
    expect((await db.query('SELECT COUNT(*)::int AS n FROM users'))[0].n).toBeGreaterThan(0);
  });
  it('guarda texto com <script> como texto e devolve como JSON com nosniff', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const lab = (await call('POST', '/api/labels', { name: payload }, owner)).body;
    const r = await call('GET', '/api/labels', undefined, owner);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body.find((l: any) => l.id === lab.id).name).toBe(payload);
  });
});

describe('uploads', () => {
  const up = (filename: string, mime: string, data: Buffer) => call('POST', '/api/media', { filename, mime, base64: data.toString('base64') }, owner);
  it('aceita imagem real e serve inline com CSP de sandbox', async () => {
    const r = await up('foto.png', 'image/png', PNG);
    expect(r.status).toBe(201);
    const got = await app.inject({ method: 'GET', url: new URL(r.body.url).pathname });
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['content-security-policy']).toContain('sandbox');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
  });
  it('recusa SVG, HTML, JavaScript e executáveis', async () => {
    expect((await up('a.svg', 'image/svg+xml', Buffer.from('<svg onload=alert(1)></svg>'))).status).toBe(415);
    expect((await up('a.html', 'text/html', Buffer.from('<script>alert(1)</script>'))).status).toBe(415);
    expect((await up('a.js', 'application/javascript', Buffer.from('alert(1)'))).status).toBe(415);
    expect((await up('a.exe', 'application/x-msdownload', Buffer.from('MZ'))).status).toBe(415);
  });
  it('recusa arquivo que mente sobre o tipo (HTML disfarçado de PNG) e arquivo vazio', async () => {
    expect((await up('fake.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>'.padEnd(40, ' ')))).status).toBe(415);
    expect((await up('fake.pdf', 'application/pdf', PNG)).status).toBe(415);
    expect((await up('vazio.png', 'image/png', Buffer.alloc(0))).status).toBe(400);
  });
  it('recusa arquivo acima de 16 MB e limpa o nome do arquivo', async () => {
    expect((await up('grande.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)]))).status).toBe(413);
    expect(cleanFilename('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/^\.+/, ''));
    expect(cleanFilename('a"\r\nb<c>.png')).toBe('abc.png');
    const r = await up('..\\..\\x.png', 'image/png', PNG);
    const [m] = await db.query('SELECT filename FROM media WHERE id = $1', [r.body.id]);
    expect(m.filename).not.toMatch(/[\\/]/);
  });
  it('tipos sem inline (texto, planilha) saem como download', async () => {
    const r = await up('notas.txt', 'text/plain', Buffer.from('olá mundo, isto é um texto longo o bastante'));
    const got = await app.inject({ method: 'GET', url: new URL(r.body.url).pathname });
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(String(got.headers['content-disposition'])).toContain('attachment');
  });
  it('assinaturas: mp3, mp4, ogg, pdf e webp reais passam', () => {
    expect(contentMatchesType('audio/mpeg', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]))).toBe(true);
    expect(contentMatchesType('audio/mpeg', Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(20)]))).toBe(true);
    expect(contentMatchesType('video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8)]))).toBe(true);
    expect(contentMatchesType('audio/ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]))).toBe(true);
    expect(contentMatchesType('application/pdf', Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(20)]))).toBe(true);
    expect(contentMatchesType('image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]))).toBe(true);
    expect(contentMatchesType('video/mp4', Buffer.from('MZ'.padEnd(32, 'x')))).toBe(false);
  });
});

describe('SSRF e chaves', () => {
  it('Evolution própria: recusa endereço interno, nuvem (metadata) e esquema perigoso', async () => {
    await withEnv({ ALLOW_PRIVATE_URLS: 'false' }, async () => {
      for (const baseUrl of ['http://127.0.0.1:8080', 'http://169.254.169.254/latest', 'http://postgres:5432', 'http://10.0.0.5', 'file:///etc/passwd', 'http://[::1]/']) {
        const r = await call('POST', '/api/connections', { name: 'x', provider: 'evolution', config: { baseUrl }, apiKey: 'k' }, owner);
        expect(r.status, baseUrl).toBe(400);
      }
      const noKey = await call('POST', '/api/connections', { name: 'x', provider: 'evolution', config: { baseUrl: 'https://evo.example.com' } }, owner);
      expect(noKey.status).toBe(400);
    });
    expect((await events(owner)).some((e) => e.kind === 'ssrf_blocked')).toBe(true);
  });
  it('bloco Mensagem recusa URL javascript:, file: e rede interna', async () => {
    const conn = (await call('POST', '/api/connections', { name: 'Sandbox', provider: 'sandbox' }, owner)).body;
    await withEnv({ ALLOW_PRIVATE_URLS: 'false' }, async () => {
      for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://169.254.169.254/x', 'http://localhost:5432/a.png']) {
        const f = (await call('POST', '/api/flows', { name: `f${++n}`, active: true, graph: { nodes: [{ id: 's', type: 'start', data: {} }, { id: 'm', type: 'message', data: { items: [{ type: 'image', url }] } }], edges: [{ id: 'e', source: 's', target: 'm', sourceHandle: 'out' }] } }, owner)).body;
        await call('PATCH', `/api/connections/${conn.id}`, { default_flow_id: f.id }, owner);
        await call('POST', `/api/connections/${conn.id}/simulate`, { phone: `55119${String(20000000 + ++n)}`, name: 'A', text: 'oi' }, owner);
      }
    });
    const notes = (await call('GET', '/api/notifications', undefined, owner)).body as any[];
    expect(notes.filter((x) => x.body.includes('Falha no bloco Mensagem')).length).toBe(4);
    const sent = await db.query(`SELECT 1 FROM messages WHERE direction = 'out' AND media_url ~ '^(javascript|file):'`);
    expect(sent.length).toBe(0);
  });
});

describe('limites, webhooks e MCP', () => {
  it('limita requisições por IP, mas não derruba webhooks nem mídia', async () => {
    const fresh = await openDb();
    const { app: a2 } = await buildApp({ db: fresh, secret: 's'.repeat(32), publicUrl: 'http://x.test', rateLimitMax: 5 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await a2.inject({ method: 'GET', url: '/api/me' })).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    for (let i = 0; i < 20; i++) expect((await a2.inject({ method: 'POST', url: '/hooks/evolution/token-qualquer', payload: {} })).statusCode).toBe(404);
    await a2.close(); await fresh.close();
  });
  it('registra webhook com token errado', async () => {
    expect((await call('POST', '/hooks/evolution/token-invalido-123', { event: 'x' })).status).toBe(404);
    expect((await db.query(`SELECT 1 FROM security_events WHERE kind = 'webhook_bad_token'`)).length).toBeGreaterThan(0);
  });
  it('MCP: sem credencial 401 e registrado; credencial certa funciona; Origin de outro site é barrado', async () => {
    expect((await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, 'mgt_falso')).status).toBe(401);
    expect((await db.query(`SELECT 1 FROM security_events WHERE kind = 'mcp_bad_credential'`)).length).toBe(2);
    const cred = (await call('POST', '/api/mcp/credentials', { name: 'teste' }, owner)).body;
    expect((await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, cred.token)).status).toBe(200);
    expect((await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, cred.token, { origin: 'https://evil.test' })).status).toBe(403);
    const [row] = await db.query('SELECT token_hash FROM mcp_credentials WHERE id = $1', [cred.id]);
    expect(row.token_hash).not.toContain(cred.token); // guarda só o hash
  });
  it('conexões nunca expõem chave nem token do webhook', async () => {
    const c = (await call('POST', '/api/connections', { name: 'e', provider: 'evolution', apiKey: 'chave-muito-secreta' }, owner)).body;
    const list = JSON.stringify((await call('GET', '/api/connections', undefined, owner)).body);
    expect(JSON.stringify(c) + list).not.toContain('chave-muito-secreta');
    expect(list).not.toContain('webhook_token');
    const [raw] = await db.query('SELECT secret FROM connections WHERE id = $1', [c.id]);
    expect(raw.secret).not.toContain('chave-muito-secreta'); // cifrada no banco
    expect(core).toBeTruthy();
  });
});

// Correções do Portão de Segurança (10/11/2026): F2 assinatura da Meta, F3 convite com trava, F6 rajada de token errado, F7 Origin malformado.
describe('portão de segurança: correções', () => {
  const hmac = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const metaBody = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '5511988887777', profile: { name: 'Cli' } }], messages: [{ id: 'wamid.portao1', from: '5511988887777', text: { body: 'oi' } }] } }] }] });
  const postMeta = (token: string, body: string, sig?: string) => app.inject({ method: 'POST', url: `/hooks/meta/${token}`, payload: body, headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) } });

  it('Meta: com App Secret só aceita webhook com assinatura certa e nunca devolve o segredo', async () => {
    const c = (await call('POST', '/api/connections', { name: 'meta', provider: 'meta', config: { phoneNumberId: '1', wabaId: '2' }, apiKey: 'token-meta', appSecret: 'app-secret-da-meta' }, owner)).body;
    expect(c.has_app_secret).toBe(true);
    const list = JSON.stringify((await call('GET', '/api/connections', undefined, owner)).body);
    expect(JSON.stringify(c) + list).not.toContain('app-secret-da-meta');
    expect(list).not.toContain('app_secret_enc');
    const [{ webhook_token: token }] = await db.query('SELECT webhook_token FROM connections WHERE id = $1', [c.id]);
    expect((await postMeta(token, metaBody)).statusCode).toBe(401); // sem assinatura
    expect((await postMeta(token, metaBody, hmac('outro-segredo', metaBody))).statusCode).toBe(401); // assinatura falsa
    expect((await postMeta(token, metaBody.replace('oi', 'pago'), hmac('app-secret-da-meta', metaBody))).statusCode).toBe(401); // corpo adulterado
    expect((await db.query(`SELECT 1 FROM security_events WHERE kind = 'webhook_bad_signature'`)).length).toBe(3);
    expect((await postMeta(token, metaBody, hmac('app-secret-da-meta', metaBody))).statusCode).toBe(200);
    expect((await db.query(`SELECT 1 FROM messages WHERE external_id = 'wamid.portao1'`)).length).toBe(1);
  });
  it('Meta: o App Secret pode ser incluído depois e o cliente não consegue gravar o campo cifrado na mão', async () => {
    const c = (await call('POST', '/api/connections', { name: 'meta2', provider: 'meta', config: { phoneNumberId: '1', app_secret_enc: 'forjado' }, apiKey: 't' }, owner)).body;
    expect(c.has_app_secret).toBe(false);
    expect((await call('PATCH', `/api/connections/${c.id}`, { appSecret: 'segredo-novo-123' }, owner)).body.has_app_secret).toBe(true);
    const [{ webhook_token: token }] = await db.query('SELECT webhook_token FROM connections WHERE id = $1', [c.id]);
    expect((await postMeta(token, metaBody)).statusCode).toBe(401);
    expect((await postMeta(token, '{}', hmac('segredo-novo-123', '{}'))).statusCode).toBe(200);
    const evo = (await call('POST', '/api/connections', { name: 'evo', provider: 'evolution', appSecret: 'nao-se-aplica' }, owner));
    expect(evo.status).toBe(400);
  });
  it('convite para conta existente trava depois de várias senhas erradas (mesma trava do login)', async () => {
    const email = `existente${++n}@teste.test`;
    await withEnv({ ALLOW_REGISTRATION: 'true' }, () => register(email));
    const url = (await call('POST', '/api/team/invites', { email, role: 'agent' }, owner)).body.url as string;
    const path = new URL(url).pathname.replace('/convite/', '/api/auth/invite/');
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await call('POST', path, { password: `errada-${i}` })).status);
    expect(codes.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(codes[8]).toBe(429);
    expect((await call('POST', path, { password: PASS })).status).toBe(429); // nem a senha certa entra enquanto travado
    expect((await call('POST', '/api/auth/login', { email, password: PASS })).status).toBe(429); // e o login também
    expect((await db.query(`SELECT 1 FROM security_events WHERE kind = 'login_locked' AND detail->>'email' = $1`, [email])).length).toBe(1);
  });
  it('rajada de token de webhook errado vira 429 sem encher o banco, e o webhook certo continua funcionando', async () => {
    const a2 = (await buildApp({ db, secret: 's'.repeat(32), publicUrl: 'https://magtron.test' })).app;
    const before = (await db.query(`SELECT COUNT(*)::int AS n FROM security_events WHERE kind IN ('webhook_bad_token','webhook_flood')`))[0].n;
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await a2.inject({ method: 'POST', url: `/hooks/evolution/errado-${i}`, payload: {} })).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 404)).toBe(true);
    expect(codes.slice(30).every((c) => c === 429)).toBe(true);
    const after = (await db.query(`SELECT COUNT(*)::int AS n FROM security_events WHERE kind IN ('webhook_bad_token','webhook_flood')`))[0].n;
    expect(after - before).toBe(30);
    const c = (await call('POST', '/api/connections', { name: 'evo-ok', provider: 'evolution' }, owner)).body;
    const [{ webhook_token: token }] = await db.query('SELECT webhook_token FROM connections WHERE id = $1', [c.id]);
    expect((await a2.inject({ method: 'POST', url: `/hooks/evolution/${token}`, payload: { event: 'x' } })).statusCode).toBe(200);
    expect((await a2.inject({ method: 'POST', url: '/hooks/in/errado', payload: {} })).statusCode).toBe(429);
    expect((await a2.inject({ method: 'POST', url: '/hooks/mercadopago/errado', payload: {} })).statusCode).toBe(429);
    await a2.close();
  });
  it('MCP: Origin malformado responde 403, não erro interno', async () => {
    const cred = (await call('POST', '/api/mcp/credentials', { name: 'origem' }, owner)).body;
    expect((await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, cred.token, { origin: 'lixo' })).status).toBe(403);
    expect((await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, cred.token, { origin: 'https://magtron.test' })).status).toBe(200);
  });
});
