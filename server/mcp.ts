import { z } from 'zod';
import type { Core } from './core.js';
import { NODE_CATALOG } from './catalog.js';

type Json = Record<string, unknown>;
interface Tool { name: string; description: string; properties: Record<string, Json>; required?: string[]; run: (core: Core, aid: string, args: any) => Promise<unknown> }

const graphSchema = z.object({
  nodes: z.array(z.object({ id: z.string().min(1), type: z.string(), position: z.object({ x: z.number(), y: z.number() }).optional(), data: z.record(z.string(), z.any()).default({}) })).max(1000),
  edges: z.array(z.object({ id: z.string().optional(), source: z.string(), target: z.string(), sourceHandle: z.string().nullable().optional() })).max(5000),
}).superRefine((g, ctx) => {
  const ids = new Set(g.nodes.map((n) => n.id));
  if (ids.size !== g.nodes.length) ctx.addIssue({ code: 'custom', message: 'ids de blocos repetidos' });
  if (g.nodes.filter((n) => n.type === 'start').length !== 1) ctx.addIssue({ code: 'custom', message: 'o fluxo precisa de exatamente um bloco start' });
  for (const n of g.nodes) if (!(n.type in NODE_CATALOG)) ctx.addIssue({ code: 'custom', message: `tipo de bloco desconhecido: ${n.type} (use list_node_types)` });
  for (const e of g.edges) if (!ids.has(e.source) || !ids.has(e.target)) ctx.addIssue({ code: 'custom', message: `ligação aponta para bloco inexistente: ${e.source} -> ${e.target}` });
});

const uuid = { type: 'string', description: 'id (uuid)' };
const graphProp = { type: 'object', description: 'Grafo do fluxo: { nodes: [{id,type,position,data}], edges: [{source,target,sourceHandle}] }. Veja list_node_types.' };

const flowOut = (f: any) => ({ id: f.id, name: f.name, active: f.active, folder: f.folder, blocks: f.graph?.nodes?.length ?? 0, updated_at: f.updated_at });
const mustFlow = async (core: Core, aid: string, id: string) => {
  const [f] = await core.db.query('SELECT * FROM flows WHERE id = $1 AND account_id = $2', [z.uuid().parse(id), aid]);
  if (!f) throw new Error('Fluxo não encontrado');
  return f;
};

const TOOLS: Tool[] = [
  { name: 'list_node_types', description: 'Lista os tipos de bloco disponíveis, seus campos de dados e as saídas de cada um.', properties: {}, run: async () => NODE_CATALOG },
  { name: 'list_flows', description: 'Lista os fluxos da conta.', properties: {}, run: async (c, a) => (await c.db.query('SELECT * FROM flows WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 200', [a])).map(flowOut) },
  { name: 'get_flow', description: 'Devolve um fluxo completo, com blocos e ligações.', properties: { flow_id: uuid }, required: ['flow_id'], run: async (c, a, x) => mustFlow(c, a, x.flow_id) },
  {
    name: 'create_flow', description: 'Cria um fluxo pausado. Sem graph, cria só o bloco Início.', properties: { name: { type: 'string' }, graph: graphProp }, required: ['name'],
    run: async (c, a, x) => {
      const b = z.object({ name: z.string().min(1).max(120), graph: graphSchema.optional() }).parse(x);
      const graph = b.graph ?? { nodes: [{ id: 'start', type: 'start', position: { x: 60, y: 160 }, data: {} }], edges: [] };
      return flowOut((await c.db.query('INSERT INTO flows (account_id, name, graph) VALUES ($1,$2,$3::jsonb) RETURNING *', [a, b.name, JSON.stringify(graph)]))[0]);
    },
  },
  {
    name: 'update_flow', description: 'Altera nome, grafo ou estado (active) de um fluxo. Ativar faz o fluxo passar a responder clientes.', properties: { flow_id: uuid, name: { type: 'string' }, graph: graphProp, active: { type: 'boolean' } }, required: ['flow_id'],
    run: async (c, a, x) => {
      const b = z.object({ flow_id: z.uuid(), name: z.string().min(1).max(120).optional(), graph: graphSchema.optional(), active: z.boolean().optional() }).parse(x);
      const cur = await mustFlow(c, a, b.flow_id);
      const [f] = await c.db.query('UPDATE flows SET name = $2, graph = $3::jsonb, active = $4, updated_at = now() WHERE id = $1 RETURNING *',
        [cur.id, b.name ?? cur.name, JSON.stringify(b.graph ?? cur.graph), b.active ?? cur.active]);
      return flowOut(f);
    },
  },
  {
    name: 'duplicate_flow', description: 'Duplica um fluxo (a cópia nasce pausada).', properties: { flow_id: uuid }, required: ['flow_id'],
    run: async (c, a, x) => { const f = await mustFlow(c, a, x.flow_id); return flowOut((await c.db.query('INSERT INTO flows (account_id, name, folder, graph) VALUES ($1,$2,$3,$4::jsonb) RETURNING *', [a, `${f.name} (cópia)`, f.folder, JSON.stringify(f.graph)]))[0]); },
  },
  { name: 'list_connections', description: 'Lista as conexões de WhatsApp (sem segredos).', properties: {}, run: async (c, a) => (await c.db.query('SELECT id, name, provider, status, phone FROM connections WHERE account_id = $1 AND NOT is_simulator', [a])) },
  { name: 'list_contacts', description: 'Lista contatos, com busca opcional por nome ou telefone.', properties: { q: { type: 'string' } }, run: async (c, a, x) => c.db.query('SELECT id, name, phone, fields, origin, opted_out FROM contacts WHERE account_id = $1 AND NOT is_simulator AND (name ILIKE $2 OR phone ILIKE $2) ORDER BY created_at DESC LIMIT 100', [a, `%${String(x.q ?? '')}%`]) },
  { name: 'list_chats', description: 'Lista conversas. status: waiting, open ou resolved.', properties: { status: { type: 'string' } }, run: async (c, a, x) => c.db.query('SELECT ch.id, ch.status, ch.department, ch.unread, ch.last_message, ch.last_message_at, co.name AS contact_name, co.phone AS contact_phone FROM chats ch JOIN contacts co ON co.id = ch.contact_id WHERE ch.account_id = $1 AND NOT co.is_simulator AND ($2::text IS NULL OR ch.status = $2) ORDER BY ch.last_message_at DESC NULLS LAST LIMIT 100', [a, x.status ? z.enum(['waiting', 'open', 'resolved']).parse(x.status) : null]) },
  { name: 'list_sales', description: 'Lista vendas dos últimos N dias (padrão 30).', properties: { days: { type: 'integer' } }, run: async (c, a, x) => c.db.query(`SELECT id, product, amount, currency, created_at FROM sales WHERE account_id = $1 AND created_at > now() - ($2 || ' days')::interval ORDER BY created_at DESC LIMIT 200`, [a, String(z.coerce.number().int().min(1).max(365).default(30).parse(x.days))]) },
  { name: 'list_labels', description: 'Lista etiquetas.', properties: {}, run: async (c, a) => c.db.query('SELECT id, name, color FROM labels WHERE account_id = $1 ORDER BY name', [a]) },
  { name: 'create_label', description: 'Cria uma etiqueta.', properties: { name: { type: 'string' } }, required: ['name'], run: async (c, a, x) => (await c.db.query('INSERT INTO labels (account_id, name) VALUES ($1,$2) ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id, name', [a, z.string().min(1).max(60).parse(x.name)]))[0] },
  { name: 'list_products', description: 'Lista produtos.', properties: {}, run: async (c, a) => c.db.query('SELECT id, name, price FROM products WHERE account_id = $1 ORDER BY name', [a]) },
  { name: 'create_product', description: 'Cria um produto.', properties: { name: { type: 'string' }, price: { type: 'number' } }, required: ['name'], run: async (c, a, x) => { const b = z.object({ name: z.string().min(1).max(120), price: z.coerce.number().nonnegative().default(0) }).parse(x); return (await c.db.query('INSERT INTO products (account_id, name, price) VALUES ($1,$2,$3) RETURNING id, name, price', [a, b.name, b.price]))[0]; } },
];

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Minimal MCP server over Streamable HTTP (JSON responses). Returns null for notifications. */
export async function handleMcp(core: Core, accountId: string, msg: any): Promise<unknown | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Requisição inválida');
  if (msg.method.startsWith('notifications/')) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'magtron', version: '1.0.0' }, instructions: 'Gerencia fluxos, contatos, conversas e vendas do MAGTRON. Fluxos novos nascem pausados.' });
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required ?? [] } })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Ferramenta desconhecida: ${msg.params?.name}`);
      try {
        const out = await tool.run(core, accountId, msg.params?.arguments ?? {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } catch (e: any) {
        const text = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ') : String(e?.message ?? e);
        return ok({ isError: true, content: [{ type: 'text', text }] });
      }
    }
    default: return rpcError(msg.id, -32601, `Método não suportado: ${msg.method}`);
  }
}
