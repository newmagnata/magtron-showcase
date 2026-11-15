import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  addEdge, Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import { ArrowLeft, LayoutGrid, Play, Search, Workflow } from 'lucide-react';
import { api, Area, Btn, Err, Input, Label, Select, useAction, useData } from './ui';
import { BLOCKS, PALETTE, tone } from './blocks';
import { autoLayout, estimateHeight, looksMessy } from './layout';
import { MessageEditor } from './MessageEditor';
import { ITEM_LABEL, messageItems } from './message-items';

function BlockNode({ type, data, selected }: NodeProps) {
  const b = BLOCKS[type] ?? BLOCKS.message;
  const Icon = b.icon;
  const t = tone(b.color);
  const handles = b.handles ? b.handles(data) : ([['out', '']] as [string, string][]);
  const stats = (data as any).__stats as { entered: number; advanced: number } | undefined;
  const entered = stats?.entered ?? 0;
  const advanced = stats?.advanced ?? 0;
  const summary = b.summary?.(data as any)?.trim();
  return (
    <div className={`w-56 overflow-visible rounded-lg border-2 text-xs shadow-sm ${selected ? 'shadow-md' : ''}`} style={{ background: t.body, borderColor: selected ? '#111827' : t.border }}>
      {type !== 'start' && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-2 rounded-t-md px-3 py-2 font-bold text-white" style={{ background: t.header }}>
        <span className="grid h-6 w-6 place-items-center rounded-full bg-white/25"><Icon size={14} strokeWidth={2.4} /></span>{b.label}
      </div>
      {type !== 'start' && (
        <div className="grid grid-cols-3 border-b px-3 py-1.5 text-center" style={{ borderColor: t.border }}>
          {[['Entradas', entered], ['Avanços', advanced], ['Taxa', entered ? `${Math.round((advanced / entered) * 100)}%` : '0%']].map(([l, v]) => (
            <div key={l}><p className="text-[8px] font-semibold uppercase tracking-wide text-muted">{l}</p><p className="font-mono text-[11px] font-bold">{v}</p></div>
          ))}
        </div>
      )}
      <div className="px-3 py-2">
        <p className="line-clamp-2 min-h-4 break-words text-muted">{summary || (type === 'start' ? 'Ponto de partida do fluxo' : 'Sem conteúdo')}</p>
        <div className="mt-1 space-y-2">
          {handles.map(([id, label]) => (
            <div key={id} className="relative h-3 text-right text-[10px]">{label}
              <Handle id={id} type="source" position={Position.Right} style={{ top: '50%', right: -18 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
const nodeTypes = Object.fromEntries(Object.keys(BLOCKS).map((k) => [k, BlockNode]));

function Inspector({ node, onChange, onDelete, onEdit }: { node: Node; onChange: (d: any) => void; onDelete: () => void; onEdit: () => void }) {
  const flows = useData<any[]>('/flows', []);
  const agents = useData<any[]>('/ai-agents', []);
  const kanbans = useData<any[]>('/kanbans', []);
  const sources = { flows: flows.data, agents: agents.data, kanbans: kanbans.data };
  const b = BLOCKS[node.type!];
  const Icon = b.icon;
  const d = node.data as any;
  const set = (k: string, v: unknown) => onChange({ ...d, [k]: v });
  return (
    <aside className="w-72 shrink-0 space-y-3 overflow-y-auto border-l border-line bg-white p-4">
      <h2 className="flex items-center gap-2 font-bold"><span className="grid h-7 w-7 place-items-center rounded-md text-white" style={{ background: b.color }}><Icon size={15} /></span>{b.label}</h2>
      {node.type === 'message' && (
        <div className="space-y-2">
          <ol className="space-y-1 text-xs">
            {messageItems(d).map((it, i) => <li key={i} className="line-clamp-2 break-words rounded bg-paper px-2 py-1"><b>{ITEM_LABEL[it.type]}</b>{it.type === 'text' ? `: ${it.text ?? ''}` : it.type === 'delay' ? `: ${it.seconds ?? 0}s` : it.type === 'contact' ? `: ${it.name ?? ''}` : it.caption ? `: ${it.caption}` : ''}</li>)}
            {messageItems(d).length === 0 && <li className="text-muted">Sem conteúdo</li>}
          </ol>
          <Btn className="w-full" onClick={onEdit}>Editar mensagem</Btn>
        </div>
      )}
      {b.fields.map((f) => (
        <Label key={f.k} text={f.label}>
          {f.kind === 'area' ? <Area value={d[f.k] ?? ''} onChange={(e) => set(f.k, e.target.value)} />
            : f.kind === 'lines' ? <Area value={(d[f.k] ?? []).join('\n')} onChange={(e) => set(f.k, e.target.value.split('\n'))} />
            : f.kind === 'select' ? <Select value={d[f.k] ?? f.options![0][0]} onChange={(e) => set(f.k, e.target.value)}>{f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            : f.kind === 'ref' ? <Select value={d[f.k] ?? ''} onChange={(e) => set(f.k, e.target.value)}><option value="">Selecione</option>{sources[f.source!].map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            : <Input type={f.kind === 'number' ? 'number' : 'text'} value={d[f.k] ?? ''} onChange={(e) => set(f.k, e.target.value)} />}
        </Label>
      ))}
      <p className="text-xs text-muted">Variáveis: {'{{contact.name}}'}, {'{{contact.phone}}'}, {'{{vars.nome}}'}, {'{{global.chave}}'}</p>
      {node.type !== 'start' && <Btn tone="danger" onClick={onDelete}>Excluir bloco</Btn>}
    </aside>
  );
}

function Simulator({ flowId, save, onClose }: { flowId: string; save: () => Promise<unknown>; onClose: () => void }) {
  const [chatId, setChatId] = useState('');
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState('');
  const { run, error, busy } = useAction();
  const load = useCallback(async (id: string) => setMessages(await api(`/chats/${id}/messages`)), []);
  useEffect(() => {
    if (!chatId) return;
    void load(chatId);
    const t = setInterval(() => void load(chatId), 1200);
    return () => clearInterval(t);
  }, [chatId, load]);
  const start = () => run(async () => { await save(); const r = await api(`/flows/${flowId}/simulate/start`, 'POST', {}); setChatId(r.chatId); await load(r.chatId); });
  const say = () => run(async () => { await api(`/flows/${flowId}/simulate/say`, 'POST', { text }); setText(''); await load(chatId); });
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-white">
      <div className="flex items-center justify-between border-b border-line p-3"><h2 className="font-bold">Simulador</h2><button className="cursor-pointer text-sm underline" onClick={onClose}>Fechar</button></div>
      <p className="p-3 text-xs text-muted">Roda o fluxo salvo. Vendas, cobranças, IA e integrações não têm efeito real.</p>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.map((m) => <div key={m.id} className={`max-w-[90%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-xs ${m.direction === 'out' ? 'bg-ink text-white' : 'ml-auto bg-paper'}`}>{m.body}</div>)}
      </div>
      <form className="space-y-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); if (text.trim() && chatId) void say(); }}>
        <Input aria-label="Mensagem do simulador" placeholder="Responder como cliente" value={text} disabled={!chatId} onChange={(e) => setText(e.target.value)} />
        <div className="flex gap-2"><Btn type="button" tone="ghost" disabled={busy} onClick={start}>{chatId ? 'Reiniciar' : 'Iniciar'}</Btn><Btn disabled={busy || !chatId || !text.trim()}>Enviar</Btn></div>
        <Err>{error}</Err>
      </form>
    </aside>
  );
}

function Editor() {
  const { id } = useParams();
  const { fitView } = useReactFlow();
  const [simulating, setSimulating] = useState(false);
  const [palette, setPalette] = useState(false);
  const [flow, setFlow] = useState<any>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingMsg, setEditingMsg] = useState(false);
  const [saved, setSaved] = useState('');
  const [filter, setFilter] = useState('');
  const { run, error, busy } = useAction();

  useEffect(() => {
    void run(async () => {
      const [f, stats] = await Promise.all([api(`/flows/${id}`), api<any[]>(`/flows/${id}/stats`)]);
      const byNode = Object.fromEntries(stats.map((s) => [s.node_id, s]));
      setFlow(f);
      let loaded: Node[] = f.graph.nodes.map((n: any) => ({ ...n, data: { ...n.data, __stats: byNode[n.id] } }));
      const messy = looksMessy(loaded.map((n) => ({ position: n.position, height: heightOf(n) })));
      if (messy) loaded = place(loaded, f.graph.edges);
      setNodes(loaded);
      setEdges(f.graph.edges);
      if (messy) { setSaved('blocos organizados — clique em Salvar'); setTimeout(() => void fitView({ padding: 0.1, maxZoom: 1, duration: 200 }), 80); }
    });
  }, [id]);

  const heightOf = (n: Node) => estimateHeight(n.type, BLOCKS[n.type!]?.handles?.(n.data as any).length ?? 1);
  const place = (list: Node[], links: { source: string; target: string }[]): Node[] => {
    const pos = autoLayout(list.map((n) => ({ id: n.id, type: n.type, height: heightOf(n) })), links);
    return list.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
  };
  const organize = () => {
    setNodes((ns) => place(ns, edges));
    setSaved('blocos organizados — clique em Salvar');
    setTimeout(() => void fitView({ padding: 0.1, maxZoom: 1, duration: 250 }), 80);
  };

  const onConnect = useCallback((c: Connection) => setEdges((e) => addEdge({ ...c, animated: true }, e.filter((x) => !(x.source === c.source && x.sourceHandle === c.sourceHandle)))), [setEdges]);
  const add = (type: string) => {
    const last = nodes.reduce<Node | undefined>((a, b) => (!a || b.position.x > a.position.x ? b : a), undefined);
    const position = last ? { x: last.position.x + 290, y: last.position.y } : { x: 60, y: 160 };
    const node: Node = { id: crypto.randomUUID().slice(0, 8), type, position, data: {} };
    setNodes((n) => [...n, node]);
    setSelectedId(node.id);
    setEditingMsg(type === 'message');
    setPalette(false);
    setTimeout(() => void fitView({ padding: 0.15, maxZoom: 1, duration: 150 }), 60);
  };
  const graph = () => ({
    nodes: nodes.map(({ id: nid, type, position, data }) => { const { __stats: _s, ...clean } = data as any; return { id: nid, type, position, data: clean }; }),
    edges: edges.map(({ id: eid, source, target, sourceHandle }) => ({ id: eid, source, target, sourceHandle: sourceHandle ?? 'out' })),
  });
  const save = () => run(async () => { await api(`/flows/${id}`, 'PATCH', { graph: graph() }); setSaved(`salvo às ${new Date().toLocaleTimeString('pt-BR')}`); });
  const toggle = () => run(async () => { setFlow(await api(`/flows/${id}`, 'PATCH', { graph: graph(), active: !flow.active })); });
  const rename = (name: string) => { if (name.trim() && name !== flow.name) void run(async () => { setFlow(await api(`/flows/${id}`, 'PATCH', { name: name.trim() })); }); };
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId), [nodes, selectedId]);
  const q = filter.toLowerCase();

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-white p-3">
        <Link to="/fluxos" aria-label="Voltar para Fluxos" className="grid h-8 w-8 place-items-center rounded-md border border-line hover:border-ink"><ArrowLeft size={16} /></Link>
        {flow && <input aria-label="Nome do fluxo" key={flow.name} defaultValue={flow.name} onBlur={(e) => rename(e.target.value)} className="min-w-0 max-w-sm rounded px-1 text-lg font-bold outline-none focus:bg-paper" />}
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${flow?.active ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>{flow?.active ? 'Ativo' : 'Pausado'}</span>
        {saved && <span className="text-xs text-muted">{saved}</span>}
        <Err>{error}</Err>
        <div className="ml-auto flex gap-2">
          <Btn tone="ghost" disabled={busy || !flow} onClick={toggle}>{flow?.active ? 'Pausar' : 'Ativar'}</Btn>
          <Btn disabled={busy || !flow} onClick={save}>Salvar</Btn>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => { setSelectedId(n.id); setSimulating(false); }} onNodeDoubleClick={(_, n) => { if (n.type === 'message') { setSelectedId(n.id); setSimulating(false); setEditingMsg(true); } }} onPaneClick={() => { setSelectedId(null); setPalette(false); }} deleteKeyCode={null} minZoom={0.05} fitView fitViewOptions={{ maxZoom: 1 }}>
            <Background gap={22} />
            <Controls showInteractive={false} fitViewOptions={{ padding: 0.15, maxZoom: 1 }} />
            <MiniMap pannable zoomable />
            <Panel position="top-left" className="!m-3 w-max max-w-[90vw]">
              <div className="flex gap-2">
                <button onClick={() => setPalette(!palette)} aria-expanded={palette} className="flex cursor-pointer items-center gap-2 rounded-lg bg-ink px-3 py-2 text-sm font-bold text-volt shadow"><LayoutGrid size={15} />Ferramentas</button>
                <button disabled={!flow} onClick={organize} title="Alinha todos os blocos em colunas, da esquerda para a direita" className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold shadow disabled:opacity-50"><Workflow size={14} />Organizar</button>
                <button disabled={!flow} onClick={() => { setSelectedId(null); setSimulating(!simulating); }} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold shadow disabled:opacity-50"><Play size={14} />Simular</button>
              </div>
              {palette && (
                <div className="mt-2 max-h-[70vh] w-64 overflow-hidden rounded-lg border border-line bg-white shadow-lg">
                  <div className="relative p-2"><Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" /><Input aria-label="Buscar blocos" placeholder="Buscar blocos..." value={filter} onChange={(e) => setFilter(e.target.value)} className="pl-8" autoFocus /></div>
                  <ul className="max-h-[60vh] overflow-y-auto pb-2">
                    {PALETTE.filter((t) => BLOCKS[t].label.toLowerCase().includes(q)).map((t) => {
                      const b = BLOCKS[t]; const Icon = b.icon;
                      return <li key={t}><button onClick={() => add(t)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left text-sm hover:bg-paper"><Icon size={18} style={{ color: b.color }} />{b.label}</button></li>;
                    })}
                  </ul>
                </div>
              )}
            </Panel>
          </ReactFlow>
        </div>
        {simulating && !selected && <Simulator flowId={id!} save={() => api(`/flows/${id}`, 'PATCH', { graph: graph() })} onClose={() => setSimulating(false)} />}
        {selected && editingMsg && selected.type === 'message' && (
          <MessageEditor data={selected.data as any} onClose={() => setEditingMsg(false)}
            onSave={(data) => { setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, data: { ...data, __stats: (n.data as any).__stats } } : n))); setEditingMsg(false); setSaved('conteúdo alterado — clique em Salvar'); }} />
        )}
        {selected && <Inspector node={selected} onEdit={() => setEditingMsg(true)}
          onChange={(data) => setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, data } : n)))}
          onDelete={() => { setNodes((ns) => ns.filter((n) => n.id !== selected.id)); setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id)); setSelectedId(null); }} />}
      </div>
    </div>
  );
}

export const FlowEditor = () => <ReactFlowProvider><Editor /></ReactFlowProvider>;
