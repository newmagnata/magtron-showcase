import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronUp, Link2, Radar, Trash2 } from 'lucide-react';
import { api, Btn, Card, CopyButton, Empty, Err, Input, Label, Modal, Select, Status, useAction, useData } from './ui';
import { Outbound } from './pages2';
import { money } from './reports';

const SLOTS = [
  ['welcome', 'Boas-vindas', 'Primeira mensagem de um contato novo (ou que voltou depois de resolvido)'],
  ['default', 'Resposta padrão', 'Mensagens seguintes, quando nenhum fluxo está em andamento'],
  ['finished', 'Conversa finalizada', 'Quando um fluxo encerra a conversa pelo bloco Controlador de Chat'],
  ['ended', 'Atendimento finalizado', 'Quando uma pessoa da equipe resolve o chat'],
] as const;
type Slot = (typeof SLOTS)[number][0];

export function DefaultFlows() {
  const conns = useData<any[]>('/connections', []);
  const flows = useData<any[]>('/flows', []);
  const assigned = useData<any[]>('/connection-flows', []);
  const keywords = useData<any[]>('/connection-keywords', []);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'incomplete' | 'none'>('all');
  const [open, setOpen] = useState('');
  const [mass, setMass] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [draft, setDraft] = useState<Partial<Record<Slot, string>>>({});
  const [kw, setKw] = useState({ keyword: '', flow_id: '' });
  const { run, error, busy } = useAction();
  const slotsOf = (id: string) => Object.fromEntries(assigned.data.filter((a) => a.connection_id === id).map((a) => [a.slot, a.flow_id])) as Partial<Record<Slot, string>>;
  const done = (id: string) => Object.keys(slotsOf(id)).length;
  const shown = conns.data.filter((c) => (c.name + (c.phone ?? '')).toLowerCase().includes(q.toLowerCase())
    && (filter === 'all' || (filter === 'none' ? done(c.id) === 0 : done(c.id) > 0 && done(c.id) < 4)));
  const toggle = (id: string) => { setOpen(open === id ? '' : id); setDraft(slotsOf(id)); setKw({ keyword: '', flow_id: '' }); };
  const reload = () => Promise.all([assigned.reload(), keywords.reload()]);
  const flowName = (id?: string) => flows.data.find((f) => f.id === id)?.name;
  const FlowSelect = ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Selecione um fluxo</option>{flows.data.map((f) => <option key={f.id} value={f.id}>{f.name}{f.active ? '' : ' (pausado)'}</option>)}</Select>
  );
  const save = (ids: string[], values: Partial<Record<Slot, string>>) => run(async () => {
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v || null]));
    for (const id of ids) await api(`/connections/${id}/flows`, 'PUT', body);
    await reload();
    setOpen(''); setPicked([]);
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Buscar conexão" placeholder="Buscar conexão..." value={q} onChange={(e) => setQ(e.target.value)} className="min-w-48 flex-1" />
        {([['all', 'Todas', conns.data.length], ['incomplete', 'Incompletas', conns.data.filter((c) => done(c.id) > 0 && done(c.id) < 4).length], ['none', 'Sem fluxos', conns.data.filter((c) => done(c.id) === 0).length]] as const).map(([v, l, n]) => (
          <button key={v} onClick={() => setFilter(v)} aria-pressed={filter === v} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-bold ${filter === v ? 'border-ink bg-ink text-volt' : 'border-line bg-white'}`}>{l} <span className="opacity-60">{n}</span></button>
        ))}
        <Btn tone="ghost" onClick={() => { setMass(!mass); setPicked([]); setOpen(''); setDraft({}); }}>{mass ? 'Sair da seleção' : 'Seleção em massa'}</Btn>
      </div>
      <Err>{error}</Err>
      {mass && (
        <Card className="mb-3">
          <p className="mb-2 text-sm font-semibold">Aplicar o mesmo fluxo em {picked.length} conexão(ões)</p>
          <div className="grid gap-2 md:grid-cols-2">{SLOTS.map(([k, label]) => <Label key={k} text={label}><FlowSelect label={`Em massa: ${label}`} value={draft[k] ?? ''} onChange={(v) => setDraft({ ...draft, [k]: v })} /></Label>)}</div>
          <Btn className="mt-3" disabled={busy || !picked.length || !Object.values(draft).some(Boolean)} onClick={() => save(picked, Object.fromEntries(Object.entries(draft).filter(([, v]) => v)))}>Aplicar</Btn>
        </Card>
      )}
      <div className="space-y-2">
        {shown.map((c) => {
          const n = done(c.id);
          return (
            <Card key={c.id} className="!p-0">
              <div className="flex items-center gap-3 p-3">
                {mass && <input type="checkbox" aria-label={`Selecionar ${c.name}`} checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />}
                <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left" onClick={() => !mass && toggle(c.id)} aria-expanded={open === c.id}>
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.status === 'connected' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <span className="min-w-0 flex-1"><span className="block truncate font-bold">{c.name}</span><span className="block font-mono text-xs text-muted">{c.phone ? `+${c.phone}` : 'número não informado'}</span></span>
                  <span className="flex gap-1">{SLOTS.map(([k]) => <span key={k} className={`h-1 w-5 rounded ${slotsOf(c.id)[k] ? 'bg-ink' : 'bg-line'}`} />)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${n === 4 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{n}/4</span>
                  {open === c.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
              </div>
              {open === c.id && !mass && (
                <div className="space-y-3 border-t border-line p-4">
                  {SLOTS.map(([k, label, hint]) => (
                    <Label key={k} text={label}><FlowSelect label={label} value={draft[k] ?? ''} onChange={(v) => setDraft({ ...draft, [k]: v })} /><span className="mt-1 block text-xs text-muted">{hint}{slotsOf(c.id)[k] && !draft[k] ? ' · será removido ao salvar' : ''}</span></Label>
                  ))}
                  <div>
                    <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Palavras-chave</p>
                    <div className="mb-2 flex flex-wrap gap-2">
                      {keywords.data.filter((k) => k.connection_id === c.id).map((k) => (
                        <span key={k.id} className="flex items-center gap-1 rounded-full bg-paper px-3 py-1 text-xs"><strong>{k.keyword}</strong> → {flowName(k.flow_id) ?? '—'}
                          <button aria-label={`Remover palavra ${k.keyword}`} className="cursor-pointer text-red-600" onClick={() => run(async () => { await api(`/connection-keywords/${k.id}`, 'DELETE'); await keywords.reload(); })}><Trash2 size={12} /></button></span>
                      ))}
                      {!keywords.data.some((k) => k.connection_id === c.id) && <span className="text-xs text-muted">nenhuma</span>}
                    </div>
                    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/connections/${c.id}/keywords`, 'POST', kw); setKw({ keyword: '', flow_id: '' }); await keywords.reload(); }); }}>
                      <Input aria-label="Nova palavra-chave" required minLength={2} placeholder="palavra ou frase" value={kw.keyword} onChange={(e) => setKw({ ...kw, keyword: e.target.value })} className="w-44" />
                      <div className="w-56"><FlowSelect label="Fluxo da palavra-chave" value={kw.flow_id} onChange={(v) => setKw({ ...kw, flow_id: v })} /></div>
                      <Btn tone="ghost" disabled={busy || !kw.flow_id}>+ adicionar</Btn>
                    </form>
                  </div>
                  <div className="flex justify-end gap-2"><Btn tone="ghost" onClick={() => setOpen('')}>Cancelar</Btn><Btn disabled={busy} onClick={() => save([c.id], Object.fromEntries(SLOTS.map(([k]) => [k, draft[k] ?? ''])))}>Salvar</Btn></div>
                </div>
              )}
            </Card>
          );
        })}
        {!shown.length && <Card><Empty>Nenhuma conexão encontrada. Crie uma em Conexões.</Empty></Card>}
      </div>
      <p className="mt-3 text-center text-xs text-muted">Precisa aplicar o mesmo fluxo em várias? Ative &ldquo;Seleção em massa&rdquo;. Só fluxos ativos respondem; as palavras-chave têm prioridade sobre os gatilhos acima.</p>
    </div>
  );
}

const PLATFORMS: [string, string][] = [['tiktok', 'TikTok'], ['kwai', 'Kwai'], ['google', 'Google'], ['meta', 'Meta']];
const platformName = (p: string) => PLATFORMS.find(([k]) => k === p)?.[1] ?? p;

export function Tracking() {
  const pixels = useData<any[]>('/tracking/pixels', []);
  const links = useData<any[]>('/tracking/links', []);
  const conns = useData<any[]>('/connections', []);
  const [modal, setModal] = useState<'' | 'pixel' | 'link'>('');
  const [px, setPx] = useState({ name: '', platform: 'tiktok', pixel_code: '', token: '' });
  const [lk, setLk] = useState({ name: '', platform: 'tiktok', pixel_id: '', message: 'Olá, gostaria de receber as informações', fallback: 'random', percent: {} as Record<string, string> });
  const { run, error, busy } = useAction();
  const sum = Object.values(lk.percent).reduce((a, v) => a + (Number(v) || 0), 0);
  const preview = lk.message.length >= 6 ? `${lk.message.slice(0, 5)}${'a1b2c3'} ${lk.message.slice(5).trimStart()}` : lk.message;
  const reloadAll = () => Promise.all([pixels.reload(), links.reload()]);
  const savePixel = () => run(async () => { await api('/tracking/pixels', 'POST', { name: px.name, platform: px.platform, pixel_code: px.pixel_code, ...(px.token ? { token: px.token } : {}) }); setModal(''); setPx({ name: '', platform: 'tiktok', pixel_code: '', token: '' }); await reloadAll(); });
  const saveLink = () => run(async () => {
    const distribution = Object.entries(lk.percent).filter(([, v]) => Number(v) > 0).map(([connection_id, v]) => ({ connection_id, percent: Number(v) }));
    await api('/tracking/links', 'POST', { name: lk.name, platform: lk.platform, pixel_id: lk.pixel_id || null, message: lk.message, fallback: lk.fallback, distribution });
    setModal(''); await reloadAll();
  });
  const Head = ({ title, onNew }: { title: string; onNew: () => void }) => <div className="mb-3 flex items-center justify-between"><h2 className="font-bold">{title}</h2><Btn onClick={onNew}>+ Novo {title === 'Pixels' ? 'pixel' : 'link'}</Btn></div>;

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">O link registra o clique e liga o contato ao anúncio no primeiro contato. O envio da conversão de volta para TikTok, Kwai ou Google ainda não está implementado no MAGTRON: os pixels ficam cadastrados para quando estiver.</p>
      <Err>{error || pixels.error || links.error}</Err>
      <Card>
        <Head title="Pixels" onNew={() => setModal('pixel')} />
        {pixels.data.length === 0 ? <div className="py-8 text-center"><Radar className="mx-auto mb-2 text-muted" /><p className="font-semibold">Nenhum pixel ainda</p><p className="text-sm text-muted">Cadastre o pixel da conta de anúncio para devolver a conversão.</p></div> : (
          <ul className="divide-y divide-line text-sm">{pixels.data.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2"><span><strong>{p.name}</strong> <span className="ml-2 rounded bg-paper px-2 py-0.5 text-xs">{platformName(p.platform)}</span> <span className="font-mono text-xs text-muted">{p.pixel_code}</span>{p.has_token && <span className="ml-2 text-xs text-muted">token salvo</span>}</span>
              <Btn tone="danger" onClick={() => run(async () => { await api(`/tracking/pixels/${p.id}`, 'DELETE'); await reloadAll(); })}>Excluir</Btn></li>
          ))}</ul>
        )}
      </Card>
      <Card>
        <Head title="Links" onNew={() => { setLk({ ...lk, name: '', percent: Object.fromEntries(conns.data.length === 1 ? [[conns.data[0].id, '100']] : []) }); setModal('link'); }} />
        {links.data.length === 0 ? <div className="py-8 text-center"><Link2 className="mx-auto mb-2 text-muted" /><p className="font-semibold">Nenhum link ainda</p><p className="text-sm text-muted">Crie o link que o anúncio vai usar e escolha a conexão do WhatsApp.</p></div> : (
          <ul className="divide-y divide-line text-sm">{links.data.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0"><p><strong>{l.name}</strong> <span className="ml-2 rounded bg-paper px-2 py-0.5 text-xs">{platformName(l.platform)}</span></p><p className="break-all font-mono text-xs text-muted">{l.url}</p><p className="text-xs text-muted">{l.clicks} cliques · {l.leads} contatos atribuídos</p></div>
              <div className="flex gap-2"><CopyButton text={l.url} /><Btn tone="danger" onClick={() => run(async () => { await api(`/tracking/links/${l.id}`, 'DELETE'); await reloadAll(); })}>Excluir</Btn></div>
            </li>
          ))}</ul>
        )}
      </Card>

      {modal === 'pixel' && (
        <Modal title="Novo pixel" onClose={() => setModal('')}>
          <form className="space-y-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void savePixel(); }}>
            <Label text="Nome"><Input required autoComplete="off" value={px.name} onChange={(e) => setPx({ ...px, name: e.target.value })} /></Label>
            <Label text="Plataforma"><Select value={px.platform} onChange={(e) => setPx({ ...px, platform: e.target.value })}>{PLATFORMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Label>
            <Label text="Código do pixel"><Input required autoComplete="off" value={px.pixel_code} onChange={(e) => setPx({ ...px, pixel_code: e.target.value })} /></Label>
            <Label text="Token (opcional)"><Input type="password" autoComplete="new-password" value={px.token} onChange={(e) => setPx({ ...px, token: e.target.value })} /></Label>
            <div className="flex justify-end gap-2"><Btn type="button" tone="ghost" onClick={() => setModal('')}>Cancelar</Btn><Btn disabled={busy}>Salvar pixel</Btn></div>
          </form>
        </Modal>
      )}
      {modal === 'link' && (
        <Modal title="Novo link" onClose={() => setModal('')}>
          <form className="space-y-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void saveLink(); }}>
            <Label text="Nome"><Input required autoComplete="off" value={lk.name} onChange={(e) => setLk({ ...lk, name: e.target.value })} /></Label>
            <div className="grid grid-cols-2 gap-3">
              <Label text="Plataforma"><Select value={lk.platform} onChange={(e) => setLk({ ...lk, platform: e.target.value, pixel_id: '' })}>{PLATFORMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Label>
              <Label text="Pixel"><Select value={lk.pixel_id} onChange={(e) => setLk({ ...lk, pixel_id: e.target.value })}><option value="">Nenhum</option>{pixels.data.filter((p) => p.platform === lk.platform).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Label>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-muted">Conexões (percentual de cada uma)</p>
              {conns.data.length === 0 && <p className="text-sm text-muted">Crie uma conexão com número em Conexões.</p>}
              {conns.data.map((c) => (
                <div key={c.id} className="flex items-center gap-2 py-1 text-sm"><span className="min-w-0 flex-1 truncate">{c.name} <span className="font-mono text-xs text-muted">{c.phone ? `+${c.phone}` : 'sem número'}</span></span>
                  <Input aria-label={`Percentual de ${c.name}`} type="number" min={0} max={100} placeholder="0" className="w-20" value={lk.percent[c.id] ?? ''} onChange={(e) => setLk({ ...lk, percent: { ...lk.percent, [c.id]: e.target.value } })} /><span>%</span></div>
              ))}
              <p className={`text-xs ${sum === 100 ? 'text-emerald-700' : 'text-red-700'}`}>Soma: {sum}. A soma dos percentuais marcados tem que ser 100.</p>
            </div>
            <Label text="Se nenhuma conexão estiver conectada"><Select value={lk.fallback} onChange={(e) => setLk({ ...lk, fallback: e.target.value })}><option value="random">Usar qualquer número disponível</option><option value="none">Mostrar indisponível</option></Select></Label>
            <Label text="Mensagem"><textarea required minLength={6} rows={3} className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm outline-none focus:border-ink" value={lk.message} onChange={(e) => setLk({ ...lk, message: e.target.value })} /></Label>
            <p className="text-xs text-muted">O código entra depois da 5ª letra. A frase precisa ter pelo menos 6 caracteres. Prévia: <span className="rounded bg-paper px-1 font-mono">{preview}</span></p>
            <div className="flex justify-end gap-2"><Btn type="button" tone="ghost" onClick={() => setModal('')}>Cancelar</Btn><Btn disabled={busy || sum !== 100}>Salvar link</Btn></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function McpTools() {
  const info = useData<any>('/mcp/info', null);
  const creds = useData<any[]>('/mcp/credentials', []);
  const [modal, setModal] = useState(false);
  const [name, setName] = useState('');
  const [made, setMade] = useState<{ token: string } | null>(null);
  const { run, error, busy } = useAction();
  const url = info.data?.url ?? '';
  const cmd = `claude mcp add --transport http magtron ${url} --header "Authorization: Bearer ${made?.token ?? 'SEU_TOKEN'}"`;
  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-bold">Servidor MCP</h2><span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">{creds.data.length} credencial(is)</span></div>
        <p className="mb-3 text-sm text-muted">Use a URL e uma credencial abaixo para conectar seu agente externo de IA e gerenciar fluxos, contatos, conversas e vendas.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div><p className="mb-1 text-xs font-semibold text-muted">URL</p><div className="flex gap-2"><Input readOnly aria-label="URL do servidor MCP" value={url} className="font-mono text-xs" /><CopyButton text={url} /></div>
            <p className="mt-2 text-xs text-muted">Claude Code, Cursor e n8n: token estático + Bearer. Conectores que exigem OAuth (claude.ai, Claude Desktop) ainda não são suportados.</p></div>
          <div className="rounded-lg bg-paper p-3 text-xs"><p className="mb-1 font-bold uppercase tracking-wide">Autenticação</p>Envie o token no cabeçalho Authorization como Bearer:<code className="mt-1 block rounded bg-white p-2 font-mono">Authorization: Bearer seu-token</code></div>
        </div>
        <p className="mt-3 break-all rounded bg-paper p-2 font-mono text-xs"><span className="mb-1 block font-sans font-bold">Claude Code:</span>{cmd}</p>
        <p className="mt-2 text-xs text-muted">Fora deste computador, a URL precisa ser pública e em HTTPS (defina PUBLIC_URL no servidor). Ferramentas: listar e editar fluxos, contatos, conversas, vendas, etiquetas e produtos. Não há ferramenta para enviar mensagens nem excluir fluxos.</p>
      </Card>
      <Card>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-bold">Credenciais</h2><Btn onClick={() => { setName(''); setMade(null); setModal(true); }}>+ Nova credencial</Btn></div>
        <Err>{error || creds.error}</Err>
        {creds.data.length === 0 ? <Empty>Crie credenciais para Cursor, Claude Code, n8n e outros clientes MCP.</Empty> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-line text-xs text-muted"><th className="px-2 py-2">Nome</th><th className="px-2 py-2">Token</th><th className="px-2 py-2">Último uso</th><th className="px-2 py-2">Criada em</th><th /></tr></thead>
            <tbody className="divide-y divide-line">{creds.data.map((c) => (
              <tr key={c.id}><td className="px-2 py-2 font-semibold">{c.name}</td><td className="px-2 py-2 font-mono text-xs">{c.token_prefix}…</td><td className="px-2 py-2 text-xs">{c.last_used_at ? new Date(c.last_used_at).toLocaleString('pt-BR') : 'nunca'}</td><td className="px-2 py-2 text-xs">{new Date(c.created_at).toLocaleDateString('pt-BR')}</td>
                <td className="px-2 py-2 text-right"><button aria-label={`Revogar ${c.name}`} className="cursor-pointer rounded p-1 text-red-600 hover:bg-red-50" onClick={() => { if (confirm(`Revogar a credencial "${c.name}"? Quem usa esse token perde o acesso.`)) void run(async () => { await api(`/mcp/credentials/${c.id}`, 'DELETE'); await creds.reload(); }); }}><Trash2 size={15} /></button></td></tr>
            ))}</tbody></table></div>
        )}
      </Card>
      {modal && (
        <Modal title="Nova credencial" onClose={() => { setModal(false); setMade(null); }}>
          {made ? (
            <div className="space-y-3"><p className="text-sm">Copie o token agora. Ele <strong>não será mostrado de novo</strong>.</p>
              <code className="block break-all rounded bg-paper p-3 font-mono text-xs">{made.token}</code>
              <div className="flex justify-end gap-2"><CopyButton text={made.token} label="Copiar token" /><Btn onClick={() => { setModal(false); setMade(null); }}>Concluir</Btn></div></div>
          ) : (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { setMade(await api('/mcp/credentials', 'POST', { name })); await creds.reload(); }); }}>
              <p className="text-sm text-muted">Token estático, para Claude Code, Cursor, n8n e similares.</p>
              <Label text="Nome"><Input required autoFocus placeholder="Ex.: Claude Code" value={name} onChange={(e) => setName(e.target.value)} /></Label>
              <div className="flex justify-end gap-2"><Btn type="button" tone="ghost" onClick={() => setModal(false)}>Cancelar</Btn><Btn disabled={busy}>Criar</Btn></div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}

const CATALOG = [
  { kind: 'mercadopago', title: 'Mercado Pago', category: 'Pagamentos', hint: 'Cobrança Pix pelo bloco Pagamento, com confirmação automática.', secret: 'Access token', fields: [] as [string, string][] },
  { kind: 'meta_ads', title: 'Meta Ads e Pixel', category: 'Trackeamento', hint: 'Gasto e campanhas no painel, e eventos de conversão pelo bloco Pixel.', secret: 'Token de acesso', fields: [['adAccountId', 'ID da conta de anúncios'], ['pixelId', 'ID do pixel']] as [string, string][] },
  { kind: 'elevenlabs', title: 'ElevenLabs', category: 'Inteligência Artificial', hint: 'Mensagens de voz pelo bloco Voz.', secret: 'API key', fields: [['voiceId', 'ID da voz padrão']] as [string, string][] },
];

function IntegrationModal({ spec, saved, onClose, onSaved }: { spec: (typeof CATALOG)[number]; saved?: any; onClose: () => void; onSaved: () => void }) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const { run, error, busy } = useAction();
  useEffect(() => { const { webhookToken: _w, ...rest } = saved?.config ?? {}; setConfig(rest); }, [saved]);
  return (
    <Modal title={spec.title} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">{spec.hint}</p>
      <form className="space-y-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/integrations/${spec.kind}`, 'PUT', { config, ...(secret ? { secret } : {}) }); onSaved(); onClose(); }); }}>
        {spec.fields.map(([k, l]) => <Label key={k} text={l}><Input autoComplete="off" value={config[k] ?? ''} onChange={(e) => setConfig({ ...config, [k]: e.target.value })} /></Label>)}
        <Label text={saved?.has_secret ? `${spec.secret} (vazio mantém o atual)` : spec.secret}><Input type="password" autoComplete="new-password" required={!saved?.has_secret} value={secret} onChange={(e) => setSecret(e.target.value)} /></Label>
        {saved?.webhookUrl && <p className="break-all font-mono text-xs text-muted">Notificações: {saved.webhookUrl}</p>}
        <Err>{error}</Err>
        <div className="flex justify-between gap-2">
          {saved ? <Btn type="button" tone="danger" onClick={() => run(async () => { await api(`/integrations/${spec.kind}`, 'DELETE'); onSaved(); onClose(); })}>Desconectar</Btn> : <span />}
          <div className="flex gap-2"><Btn type="button" tone="ghost" onClick={onClose}>Cancelar</Btn><Btn disabled={busy}>Salvar</Btn></div>
        </div>
      </form>
    </Modal>
  );
}

export function Integrations() {
  const { data, reload, error } = useData<any[]>('/integrations', []);
  const [cat, setCat] = useState('Todas');
  const [editing, setEditing] = useState<(typeof CATALOG)[number] | null>(null);
  const cats = ['Todas', ...new Set(CATALOG.map((c) => c.category))];
  const list = CATALOG.filter((c) => cat === 'Todas' || c.category === cat);
  const isActive = (kind: string) => data.some((d) => d.kind === kind && d.has_secret);
  const Card1 = ({ c }: { c: (typeof CATALOG)[number] }) => (
    <div className="flex flex-col rounded-lg border border-line bg-white p-4">
      <span className="mb-2 w-fit rounded bg-paper px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">{c.category}</span>
      <h3 className="font-bold">{c.title}</h3><p className="mb-3 flex-1 text-sm text-muted">{c.hint}</p>
      <Btn tone={isActive(c.kind) ? 'ghost' : 'primary'} onClick={() => setEditing(c)}>{isActive(c.kind) ? 'Gerenciar' : 'Configurar'}</Btn>
    </div>
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">{cats.map((c) => <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-bold ${cat === c ? 'border-ink bg-ink text-volt' : 'border-line bg-white'}`}>{c}</button>)}</div>
      <Err>{error}</Err>
      <section><h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Ativas <span className="opacity-60">{list.filter((c) => isActive(c.kind)).length}</span></h2>
        {list.some((c) => isActive(c.kind)) ? <div className="grid gap-3 md:grid-cols-3">{list.filter((c) => isActive(c.kind)).map((c) => <Card1 key={c.kind} c={c} />)}</div> : <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-muted">Nenhuma integração ativa em {cat}. Escolha uma opção abaixo para começar.</p>}</section>
      <section><h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Disponíveis <span className="opacity-60">{list.filter((c) => !isActive(c.kind)).length}</span></h2>
        <div className="grid gap-3 md:grid-cols-3">{list.filter((c) => !isActive(c.kind)).map((c) => <Card1 key={c.kind} c={c} />)}</div></section>
      {(cat === 'Todas' || cat === 'Trackeamento') && <Outbound />}
      {editing && <IntegrationModal spec={editing} saved={data.find((d) => d.kind === editing.kind)} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
    </div>
  );
}

export function DispatchSettings() {
  const usage = useData<any>('/usage', null);
  const list = useData<any[]>('/dispatches', []);
  const [limit, setLimit] = useState('');
  const { run, error, busy } = useAction();
  useEffect(() => { if (usage.data) setLimit(String(usage.data.limits.dispatches ?? '')); }, [usage.data]);
  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 text-center sm:grid-cols-3">
          <div><p className="text-2xl font-bold tabular-nums">{usage.data?.dispatches ?? 0}</p><p className="text-xs text-muted">Envios planejados no mês</p></div>
          <div><p className="text-2xl font-bold tabular-nums">{list.data.filter((d) => d.status === 'running').length}</p><p className="text-xs text-muted">Em andamento</p></div>
          <div><p className="text-2xl font-bold tabular-nums">{list.data.filter((d) => d.status === 'done').length}</p><p className="text-xs text-muted">Concluídos</p></div>
        </div>
      </Card>
      <Card>
        <h2 className="mb-1 font-bold">Cota mensal</h2>
        <p className="mb-3 text-sm text-muted">Trava novos disparos quando a soma do mês passa do limite. Deixe vazio para não limitar.</p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/account', 'PATCH', { limits: { connections: usage.data?.limits.connections ?? null, dispatches: limit ? Number(limit) : null } }); await usage.reload(); }); }}>
          <Label text="Disparos por mês"><Input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} /></Label><Btn disabled={busy}>Salvar cota</Btn>
          <Link to="/disparos" className="ml-auto text-sm font-semibold underline">Abrir Disparos em massa</Link>
        </form>
        <Err>{error}</Err>
      </Card>
      <p className="text-xs text-muted">Os disparos pulam quem pediu para sair e são espaçados (até 60 por minuto) para proteger o número.</p>
    </div>
  );
}

const WEEK = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
export function Hours() {
  const { data, reload } = useData<any>('/account', null);
  const [tz, setTz] = useState('');
  const [days, setDays] = useState<{ on: boolean; start: string; end: string }[]>([]);
  const { run, error, busy } = useAction();
  useEffect(() => {
    if (!data) return;
    setTz(data.timezone);
    const saved = data.settings.business_hours?.days ?? [];
    setDays(WEEK.map((_, i) => { const d = saved.find((x: any) => x.day === i); return { on: !!d, start: d?.start ?? '09:00', end: d?.end ?? '18:00' }; }));
  }, [data]);
  const edit = (i: number, patch: object) => setDays(days.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Card>
      <p className="mb-3 text-sm text-muted">Usado pelo bloco Horário comercial. Sem nenhum dia marcado, o sistema considera sempre aberto.</p>
      <Label text="Fuso horário"><Input value={tz} onChange={(e) => setTz(e.target.value)} className="max-w-xs" /></Label>
      <div className="mt-3">
        {days.map((d, i) => (
          <div key={WEEK[i]} className="flex flex-wrap items-center gap-2 py-1 text-sm">
            <label className="flex w-28 items-center gap-2"><input type="checkbox" checked={d.on} onChange={(e) => edit(i, { on: e.target.checked })} />{WEEK[i]}</label>
            <Input aria-label={`Início ${WEEK[i]}`} type="time" className="w-32" disabled={!d.on} value={d.start} onChange={(e) => edit(i, { start: e.target.value })} />
            <Input aria-label={`Fim ${WEEK[i]}`} type="time" className="w-32" disabled={!d.on} value={d.end} onChange={(e) => edit(i, { end: e.target.value })} />
          </div>
        ))}
      </div>
      <Btn className="mt-3" disabled={busy} onClick={() => run(async () => { await api('/account', 'PATCH', { timezone: tz, business_hours: { days: days.flatMap((d, day) => (d.on ? [{ day, start: d.start, end: d.end }] : [])) } }); await reload(); })}>Salvar horários</Btn>
      <Err>{error}</Err>
    </Card>
  );
}

export { Status, money };
