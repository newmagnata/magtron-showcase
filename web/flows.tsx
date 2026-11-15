import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Copy, Download, Folder, FolderPlus, Home, Languages, Layers, MoreVertical, Pause, Play, Plus, Search, Trash2, Upload, Workflow } from 'lucide-react';
import { api, Area, Btn, Empty, Err, Input, Label, Select, useAction, useData } from './ui';

type Status = 'all' | 'active' | 'paused';
const ALL = '';
const NONE = '\u0000none';
const START = { nodes: [{ id: 'start', type: 'start', position: { x: 60, y: 160 }, data: {} }], edges: [] };

export function Flows() {
  const flows = useData<any[]>('/flows', []);
  const folders = useData<string[]>('/flow-folders', []);
  const [status, setStatus] = useState<Status>('all');
  const [folder, setFolder] = useState(ALL);
  const [q, setQ] = useState('');
  const [panel, setPanel] = useState<'' | 'new' | 'folder' | 'import'>('');
  const [name, setName] = useState('');
  const [json, setJson] = useState('');
  const [menu, setMenu] = useState('');
  // O menu usa posição fixa (calculada a partir do botão) para não ser cortado pelo overflow da tabela.
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0, maxHeight: 400 });
  const openMenu = (id: string, el: HTMLElement) => {
    if (menu === id) return setMenu('');
    const r = el.getBoundingClientRect();
    const need = 340;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const down = below >= need || below >= above;
    setMenuPos({
      top: down ? r.bottom + 4 : Math.max(8, r.top - Math.min(need, above) - 4),
      right: Math.max(8, window.innerWidth - r.right),
      maxHeight: Math.max(160, down ? below : above),
    });
    setMenu(id);
  };
  const { run, error, busy } = useAction();
  const nav = useNavigate();
  const reload = () => Promise.all([flows.reload(), folders.reload()]);

  const visible = flows.data.filter((f) => (status === 'all' || (status === 'active') === f.active)
    && (folder === ALL || (folder === NONE ? !f.folder : f.folder === folder))
    && f.name.toLowerCase().includes(q.toLowerCase()));
  const count = (pred: (f: any) => boolean) => flows.data.filter(pred).length;

  const create = () => run(async () => { const f = await api('/flows', 'POST', { name, graph: START, folder: folder && folder !== NONE ? folder : null }); nav(`/fluxos/${f.id}`); });
  const createFolder = () => run(async () => { await api('/flow-folders', 'POST', { name }); setName(''); setPanel(''); await folders.reload(); });
  const importFlow = () => run(async () => {
    let g: any;
    try { g = JSON.parse(json); } catch { throw new Error('Isso não é um JSON de fluxo. Códigos de compartilhamento de outras plataformas não funcionam aqui: use um arquivo exportado pelo MAGTRON.'); }
    const graph = g.graph ?? g;
    if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges) || !graph.nodes.some((n: any) => n.type === 'start')) throw new Error('JSON sem a estrutura de um fluxo do MAGTRON (blocos, ligações e bloco Início).');
    await api('/flows', 'POST', { name: g.name ?? 'Importado', graph });
    setJson(''); setPanel(''); await reload();
  });
  const exportFlow = (f: any) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ name: f.name, graph: f.graph }, null, 2)])); a.download = `${f.name}.json`; a.click(); };
  const act = (fn: () => Promise<unknown>) => { setMenu(''); void run(async () => { await fn(); await reload(); }); };

  const Item = ({ id, label, icon, n }: { id: string; label: string; icon: React.ReactNode; n: number }) => (
    <button onClick={() => setFolder(id)} aria-pressed={folder === id} className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold ${folder === id ? 'bg-ink text-volt' : 'hover:bg-paper'}`}>
      {icon}<span className="min-w-0 flex-1 truncate">{label}</span><span className="text-xs opacity-70">{n}</span>
    </button>
  );

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Workflow className="mt-1" size={26} />
          <div><h1 className="text-2xl font-bold tracking-tight">Fluxos</h1><p className="text-sm text-muted">Automações e fluxos de atendimento</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => { setName(''); setPanel(panel === 'new' ? '' : 'new'); }}><span className="flex items-center gap-1.5"><Plus size={15} />Novo fluxo</span></Btn>
          <Btn tone="ghost" onClick={() => { setName(''); setPanel(panel === 'folder' ? '' : 'folder'); }}><span className="flex items-center gap-1.5"><FolderPlus size={15} />Pasta</span></Btn>
          <Btn tone="ghost" onClick={() => setPanel(panel === 'import' ? '' : 'import')}><span className="flex items-center gap-1.5"><Upload size={15} />Importar</span></Btn>
        </div>
      </header>

      {panel === 'new' && <form className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-white p-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="min-w-48 flex-1"><Label text="Nome do novo fluxo"><Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Label></div><Btn disabled={busy}>Criar fluxo</Btn></form>}
      {panel === 'folder' && <form className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-white p-4" onSubmit={(e) => { e.preventDefault(); void createFolder(); }}>
        <div className="min-w-48 flex-1"><Label text="Nome da pasta"><Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Label></div><Btn disabled={busy}>Criar pasta</Btn></form>}
      {panel === 'import' && (
        <div className="mb-4 rounded-lg border border-line bg-white p-4">
          <Label text="Importar JSON"><Area rows={3} value={json} onChange={(e) => setJson(e.target.value)} /></Label>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Btn tone="ghost" disabled={!json} onClick={importFlow}>Importar</Btn>
            <label className="cursor-pointer text-sm underline">Escolher arquivo<input type="file" accept=".json,application/json" aria-label="Arquivo JSON do fluxo" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void f.text().then(setJson); }} /></label>
          </div>
        </div>
      )}
      <Err>{error || flows.error}</Err>

      <div className="relative mb-3"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><Input aria-label="Buscar fluxos" placeholder="Buscar fluxos..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" /></div>
      <div className="mb-4 flex flex-wrap gap-2">
        {([['all', 'Todos', flows.data.length, ''], ['active', 'Ativos', count((f) => f.active), 'bg-emerald-500'], ['paused', 'Pausados', count((f) => !f.active), 'bg-red-500']] as const).map(([v, l, n, dot]) => (
          <button key={v} onClick={() => setStatus(v)} aria-pressed={status === v} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-bold ${status === v ? 'border-ink bg-ink text-volt' : 'border-line bg-white'}`}>
            {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}{l} <span className="opacity-60">{n}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <aside className="rounded-lg border border-line bg-white p-3">
          <p className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-muted">Pastas</p>
          <div className="space-y-1">
            <Item id={ALL} label="Todos os fluxos" icon={<Layers size={15} />} n={flows.data.length} />
            <Item id={NONE} label="Sem pasta" icon={<Home size={15} />} n={count((f) => !f.folder)} />
            {folders.data.map((f) => (
              <div key={f} className="group relative">
                <Item id={f} label={f} icon={<Folder size={15} />} n={count((x) => x.folder === f)} />
                <button aria-label={`Excluir pasta ${f}`} title="Excluir pasta (os fluxos ficam em Sem pasta)" onClick={() => act(async () => { await api(`/flow-folders/${encodeURIComponent(f)}`, 'DELETE'); if (folder === f) setFolder(ALL); })}
                  className="absolute right-8 top-1/2 hidden -translate-y-1/2 cursor-pointer rounded p-1 text-red-600 hover:bg-red-50 group-hover:block"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </aside>

        <section className="min-w-0 overflow-visible rounded-lg border border-line bg-white">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">{folder === ALL ? 'Todos os fluxos' : folder === NONE ? 'Sem pasta' : folder}</div>
          {visible.length === 0 ? <Empty>Nenhum fluxo aqui.</Empty> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted"><th className="px-4 py-2 font-semibold">Nome</th><th className="px-2 py-2 font-semibold">Status</th><th className="px-2 py-2 font-semibold">Blocos</th><th className="px-2 py-2 font-semibold">Atualizado</th><th className="w-10" /></tr></thead>
                <tbody>
                  {visible.map((f) => (
                    <tr key={f.id} className={`border-b border-line last:border-0 hover:bg-paper ${f.active ? 'shadow-[inset_3px_0_0_#10b981]' : 'shadow-[inset_3px_0_0_#ef4444]'}`}>
                      <td className="px-4 py-3"><Link className="font-semibold hover:underline" to={`/fluxos/${f.id}`}>{f.name}</Link>{f.folder && <span className="ml-2 text-xs text-muted">{f.folder}</span>}</td>
                      <td className="px-2 py-3"><span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${f.active ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{f.active ? '● ATIVO' : '● PAUSADO'}</span></td>
                      <td className="px-2 py-3 tabular-nums">{f.graph.nodes.length}</td>
                      <td className="whitespace-nowrap px-2 py-3 text-xs text-muted">{new Date(f.updated_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td className="relative px-2 py-3">
                        <button aria-label={`Ações de ${f.name}`} onClick={(e) => openMenu(f.id, e.currentTarget)} className="cursor-pointer rounded p-1 hover:bg-white"><MoreVertical size={16} /></button>
                        {menu === f.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenu('')} />
                            <div role="menu" style={{ top: menuPos.top, right: menuPos.right, maxHeight: menuPos.maxHeight }} className="fixed z-20 w-52 overflow-y-auto rounded-lg border border-line bg-white py-1 text-sm shadow-lg">
                              <button role="menuitem" disabled={busy} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 hover:bg-paper" onClick={() => act(() => api(`/flows/${f.id}`, 'PATCH', { active: !f.active }))}>{f.active ? <Pause size={14} /> : <Play size={14} />}{f.active ? 'Pausar' : 'Ativar'}</button>
                              <button role="menuitem" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 hover:bg-paper" onClick={() => act(() => api(`/flows/${f.id}/duplicate`, 'POST', {}))}><Copy size={14} />Duplicar</button>
                              <button role="menuitem" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 hover:bg-paper" onClick={() => { setMenu(''); exportFlow(f); }}><Download size={14} />Exportar JSON</button>
                              <div className="flex items-center gap-2 px-3 py-1"><Languages size={14} /><Select aria-label={`Traduzir ${f.name}`} value="" onChange={(e) => { const language = e.target.value; if (language) act(() => api(`/flows/${f.id}/translate`, 'POST', { language })); }}><option value="">Traduzir…</option><option>Inglês</option><option>Espanhol</option></Select></div>
                              <div className="flex items-center gap-2 px-3 py-1"><Folder size={14} /><Select aria-label={`Pasta de ${f.name}`} value={f.folder ?? ''} onChange={(e) => act(() => api(`/flows/${f.id}`, 'PATCH', { folder: e.target.value || null }))}><option value="">Sem pasta</option>{folders.data.map((x) => <option key={x}>{x}</option>)}</Select></div>
                              <button role="menuitem" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-red-700 hover:bg-red-50" onClick={() => { if (confirm(`Excluir o fluxo "${f.name}"? Isso não pode ser desfeito.`)) act(() => api(`/flows/${f.id}`, 'DELETE')); else setMenu(''); }}><Trash2 size={14} />Excluir</button>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
