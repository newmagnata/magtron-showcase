import { useEffect, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, Area, Btn, Card, Empty, Err, Input, Label, Page, Select, Status, Table, getToken, useAction, useData } from './ui';
import { Kpi, money, SalesDetails } from './reports';

export function Dashboard() {
  const [days, setDays] = useState('30');
  const { data, error, reload } = useData<any>(`/dashboard?days=${days}`, null);
  const max = Math.max(1, ...(data?.byDay ?? []).map((d: any) => d.revenue));
  const chats = Object.fromEntries((data?.chats ?? []).map((c: any) => [c.status, c.n]));
  return (
    <Page title="Painel" hint="Resultado da operação no período." action={
      <Select aria-label="Período" value={days} onChange={(e) => setDays(e.target.value)} className="w-40">
        <option value="1">Hoje</option><option value="7">7 dias</option><option value="30">30 dias</option><option value="90">90 dias</option>
      </Select>}>
      <Err>{error}</Err>
      {data && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Leads novos" value={data.leads} />
          <Kpi label="Faturamento" value={money(data.revenue)} />
          <Kpi label="Vendas" value={data.sales} />
          <Kpi label="Ticket médio" value={money(data.ticket)} />
          <Kpi label="Conversão" value={`${(data.conversion * 100).toFixed(1)}%`} />
          <Kpi label="Aguardando" value={chats.waiting ?? 0} />
          <Kpi label="Em atendimento" value={chats.open ?? 0} />
          <Kpi label="Automações ativas" value={data.runs.active} />
        </div>
        <Card className="mt-4">
          <h2 className="mb-3 text-sm font-bold">Faturamento por dia</h2>
          {data.byDay.length ? (
            <div className="flex h-44 items-end gap-1">
              {data.byDay.map((d: any) => <div key={d.day} title={`${d.day}: ${money(d.revenue)}`} className="min-w-3 flex-1 rounded-t bg-ink" style={{ height: `${(d.revenue / max) * 100}%` }} />)}
            </div>
          ) : <Empty>Nenhuma venda no período.</Empty>}
        </Card>
        {data.runs.failed > 0 && <p className="mt-3 text-sm text-red-700">{data.runs.failed} execuções de fluxo falharam.</p>}
        <SalesDetails days={days} revenue={data.revenue} reloadTop={reload} />
      </>}
    </Page>
  );
}

function ContactEditor({ contact, onClose }: { contact: any; onClose: () => void }) {
  const defs = useData<any[]>('/custom-fields', []);
  const labels = useData<any[]>('/labels', []);
  const current = useData<string[]>(`/contacts/${contact.id}/label-ids`, []);
  const [name, setName] = useState<string>(contact.name);
  const [fields, setFields] = useState<Record<string, string>>(contact.fields ?? {});
  const [chosen, setChosen] = useState<string[]>([]);
  const { run, error, busy } = useAction();
  useEffect(() => setChosen(current.data), [current.data]);
  const save = () => run(async () => {
    await api(`/contacts/${contact.id}`, 'PATCH', { name, fields });
    await api(`/contacts/${contact.id}/labels`, 'PUT', { labels: chosen });
    onClose();
  });
  return (
    <Card className="mt-4">
      <h2 className="mb-3 font-bold">Editar contato <span className="font-mono text-xs font-normal text-muted">{contact.phone}</span></h2>
      <div className="grid gap-3 md:grid-cols-3">
        <Label text="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Label>
        {defs.data.map((d) => <Label key={d.id} text={d.label}><Input value={fields[d.key] ?? ''} onChange={(e) => setFields({ ...fields, [d.key]: e.target.value })} /></Label>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        {labels.data.map((l) => (
          <label key={l.id} className="flex items-center gap-1.5">
            <input type="checkbox" checked={chosen.includes(l.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, l.id] : chosen.filter((x) => x !== l.id))} />{l.name}
          </label>
        ))}
      </div>
      <Err>{error}</Err>
      <div className="mt-3 flex gap-2"><Btn disabled={busy} onClick={save}>Salvar</Btn><Btn tone="ghost" onClick={onClose}>Cancelar</Btn></div>
    </Card>
  );
}

export function Contacts() {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const { data, reload, error: loadError } = useData<any[]>(`/contacts?q=${encodeURIComponent(q)}`, []);
  const [form, setForm] = useState({ name: '', phone: '' });
  const [csv, setCsv] = useState('');
  const { run, error, busy } = useAction();
  const exportCsv = () => run(async () => {
    const res = await fetch('/api/contacts/export', { headers: { authorization: `Bearer ${getToken()}` } });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = 'contatos.csv';
    a.click();
  });
  return (
    <Page title="Contatos" action={<Btn tone="ghost" onClick={exportCsv}>Exportar CSV</Btn>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/contacts', 'POST', form); setForm({ name: '', phone: '' }); await reload(); }); }}>
            <div className="min-w-32 flex-1"><Label text="Nome"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Label></div>
            <div className="min-w-32 flex-1"><Label text="Telefone com DDI"><Input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Label></div>
            <Btn disabled={busy}>Adicionar</Btn>
          </form>
        </Card>
        <Card>
          <Label text="Importar CSV (nome,telefone)"><Area rows={2} value={csv} onChange={(e) => setCsv(e.target.value)} /></Label>
          <Btn tone="ghost" className="mt-2" disabled={busy || !csv} onClick={() => run(async () => { await api('/contacts/import', 'POST', { csv }); setCsv(''); await reload(); })}>Importar</Btn>
        </Card>
      </div>
      <Err>{error || loadError}</Err>
      {editing && <ContactEditor key={editing.id} contact={editing} onClose={() => { setEditing(null); void reload(); }} />}
      <Card className="mt-4">
        <Input aria-label="Buscar" placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
        <Table head={['Nome', 'Telefone', 'Etiquetas', 'Origem', 'Situação', '']}>
          {data.map((c) => (
            <tr key={c.id}>
              <td className="px-2 py-2">{c.name || '—'}</td>
              <td className="px-2 py-2 font-mono text-xs">{c.phone}</td>
              <td className="px-2 py-2 text-xs">{c.labels.join(', ')}</td>
              <td className="px-2 py-2 text-xs">{c.origin}</td>
              <td className="px-2 py-2 text-xs">{c.opted_out ? 'Pediu para sair' : 'Ativo'}</td>
              <td className="space-x-2 whitespace-nowrap px-2 py-2 text-right">
                <Btn tone="ghost" onClick={() => setEditing(c)}>Editar</Btn>
                <Btn tone="danger" onClick={() => run(async () => { await api(`/contacts/${c.id}`, 'DELETE'); await reload(); })}>Excluir</Btn>
              </td>
            </tr>
          ))}
        </Table>
        {!data.length && <Empty>Nenhum contato.</Empty>}
      </Card>
    </Page>
  );
}

export function Kanban() {
  const boards = useData<any[]>('/kanbans', []);
  const contacts = useData<any[]>('/contacts?q=', []);
  const [boardId, setBoardId] = useState('');
  const [name, setName] = useState('');
  const [columns, setColumns] = useState('Novo, Em andamento, Fechado');
  const [contact, setContact] = useState('');
  const board =boards.data.find((b) => b.id === boardId) ?? boards.data[0];
  const cards = useData<any[]>(board ? `/kanbans/${board.id}/cards` : null, []);
  const { run, error } = useAction();
  const drop = (e: DragEvent, column: string) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    void run(async () => { await api(`/kanban-cards/${id}`, 'PATCH', { column_name: column }); await cards.reload(); });
  };
  return (
    <Page title="Kanban" hint="Arraste os cartões entre as colunas.">
      <div className="mb-4 flex flex-wrap items-end gap-2">
        {boards.data.length > 0 && <Select aria-label="Kanban" className="w-52" value={board?.id ?? ''} onChange={(e) => setBoardId(e.target.value)}>{boards.data.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/kanbans', 'POST', { name, columns: columns.split(',').map((c) => c.trim()).filter(Boolean) }); setName(''); await boards.reload(); }); }}>
          <Input aria-label="Nome do kanban" required placeholder="Novo kanban" value={name} onChange={(e) => setName(e.target.value)} />
          <Input aria-label="Colunas do kanban" required value={columns} onChange={(e) => setColumns(e.target.value)} /><Btn>Criar</Btn>
        </form>
        {board && <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/kanbans/${board.id}/cards`, 'POST', { contact_id: contact, column_name: board.columns[0] }); await cards.reload(); }); }}>
          <Select aria-label="Contato" required value={contact} onChange={(e) => setContact(e.target.value)} className="w-52"><option value="">Contato</option>{contacts.data.map((c) => <option key={c.id} value={c.id}>{c.name || c.phone}</option>)}</Select>
          <Btn tone="ghost">Adicionar</Btn>
        </form>}
      </div>
      <Err>{error}</Err>
      {board ? (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {board.columns.map((col: string) => (
            <div key={col} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, col)} className="min-h-72 w-64 shrink-0 rounded-lg bg-[#e8e6dd] p-2">
              <h2 className="px-1 pb-2 text-sm font-bold">{col}</h2>
              {cards.data.filter((c) => c.column_name === col).map((c) => (
                <div key={c.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', c.id)} className="mb-2 cursor-grab rounded-md bg-white p-3 text-sm">
                  <p className="font-semibold">{c.contact_name || c.contact_phone}</p><p className="font-mono text-xs text-muted">{c.contact_phone}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : <Card><Empty>Crie o primeiro kanban.</Empty></Card>}
    </Page>
  );
}

const PROVIDERS: Record<string, string> = { sandbox: 'Sandbox (teste sem WhatsApp)', evolution: 'Evolution API', meta: 'API Oficial Meta Cloud' };

export function Connections() {
  const { data, reload } = useData<any[]>('/connections', []);
  const flows = useData<any[]>('/flows', []);
  const [form, setForm] = useState({ name: '', provider: 'evolution', baseUrl: '', phoneNumberId: '', wabaId: '', apiKey: '', appSecret: '' });
  const [info, setInfo] = useState('');
  const [qrId, setQrId] = useState('');
  const [qr, setQr] = useState('');
  const [metaInfo, setMetaInfo] = useState<any>(null);
  const [sim, setSim] = useState({ phone: '5511999990000', name: 'Cliente Teste', text: 'Olá' });
  const { run, error, busy } = useAction();
  const create = () => run(async () => {
    const config = form.provider === 'evolution' ? (form.baseUrl ? { baseUrl: form.baseUrl } : {}) : form.provider === 'meta' ? { phoneNumberId: form.phoneNumberId, wabaId: form.wabaId } : {};
    const usesKey = form.provider === 'meta' || (form.provider === 'evolution' && form.baseUrl);
    await api('/connections', 'POST', { name: form.name, provider: form.provider, config, ...(usesKey && form.apiKey ? { apiKey: form.apiKey } : {}), ...(form.provider === 'meta' && form.appSecret ? { appSecret: form.appSecret } : {}) });
    setForm({ ...form, name: '', apiKey: '', appSecret: '' });
    await reload();
  });
  useEffect(() => {
    if (!qrId) return;
    let ticks = 0;
    const timer = setInterval(async () => {
      ticks++;
      const state = await api(`/connections/${qrId}/refresh`, 'POST').catch(() => null);
      if (state?.status === 'connected') { setQr(''); setQrId(''); void reload(); return; }
      if (ticks % 6 === 0) { // o QR expira em cerca de 40 segundos
        const fresh = await api(`/connections/${qrId}/connect`, 'POST').catch(() => null);
        if (fresh?.qr) setQr(fresh.qr);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [qrId, reload]);
  const connect = (c: any) => run(async () => {
    const r = await api(`/connections/${c.id}/connect`, 'POST');
    setQr(r.qr ?? '');
    setQrId(r.qr ? c.id : '');
    if (r.verifyToken) setMetaInfo(r);
    await reload();
  });
  const sandbox = data.find((c) => c.provider === 'sandbox');
  return (
    <Page title="Conexões" hint="Números de WhatsApp e o fluxo que recebe cada novo contato.">
      <Card>
        <form className="grid gap-3 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Label text="Nome"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Label>
          <Label text="Provedor"><Select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>{Object.entries(PROVIDERS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Label>
          {form.provider === 'evolution' && <Label text="URL da Evolution (vazio = a instalada aqui)"><Input type="url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></Label>}
          {form.provider === 'meta' && <Label text="ID do número"><Input required value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} /></Label>}
          {form.provider === 'meta' && <Label text="WABA ID"><Input required value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} /></Label>}
          {(form.provider === 'meta' || (form.provider === 'evolution' && form.baseUrl)) && <Label text={form.provider === 'meta' ? 'Token de acesso' : 'API key'}><Input required type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></Label>}
          {form.provider === 'meta' && <Label text="App Secret (confere a assinatura dos webhooks)"><Input type="password" autoComplete="off" minLength={8} value={form.appSecret} onChange={(e) => setForm({ ...form, appSecret: e.target.value })} /></Label>}
          <div className="self-end"><Btn disabled={busy}>Adicionar conexão</Btn></div>
        </form>
        {form.provider === 'evolution' && <p className="mt-3 text-xs text-amber-800">A Evolution conecta pelo WhatsApp Web, um canal não oficial. Automação intensa pode causar banimento do número.</p>}
      </Card>
      <Err>{error}</Err>
      {info && <p role="status" className="mt-2 text-sm text-volt-dark">{info}</p>}
      {qr && <Card className="mt-4 text-center"><p className="mb-2 text-sm font-semibold">Escaneie no WhatsApp: Aparelhos conectados</p>{qr.startsWith('data:') ? <img src={qr} alt="QR code de conexão" className="mx-auto w-64" /> : <code className="break-all text-xs">{qr}</code>}<Btn tone="ghost" className="mt-3" onClick={() => { setQr(''); setQrId(''); void reload(); }}>Fechar</Btn></Card>}
      {metaInfo && <Card className="mt-4 text-sm"><p className="font-semibold">Configure o webhook na Meta</p><p className="mt-1 break-all font-mono text-xs">URL: {metaInfo.webhookUrl}</p><p className="break-all font-mono text-xs">Verify token: {metaInfo.verifyToken}</p></Card>}
      <Card className="mt-4">
        <Table head={['Conexão', 'Provedor', 'Número', 'Status', 'Boas-vindas', '']}>
          {data.map((c) => (
            <tr key={c.id}>
              <td className="px-2 py-2 font-semibold">{c.name}</td>
              <td className="px-2 py-2 text-xs">{PROVIDERS[c.provider]}</td>
              <td className="px-2 py-2"><Input aria-label={`Número de ${c.name}`} key={c.phone ?? 'x'} className="w-36 font-mono text-xs" placeholder="5511999999999" defaultValue={c.phone ?? ''}
                onBlur={(e) => { const v = e.target.value.replace(/\D/g, ''); if (v !== (c.phone ?? '')) void run(async () => { await api(`/connections/${c.id}`, 'PATCH', { phone: v || null }); await reload(); }); }} /></td>
              <td className="px-2 py-2"><Status value={c.status} /></td>
              <td className="px-2 py-2">
                <Select aria-label={`Fluxo padrão de ${c.name}`} value={c.default_flow_id ?? ''} onChange={(e) => run(async () => { await api(`/connections/${c.id}`, 'PATCH', { default_flow_id: e.target.value || null }); await reload(); })}>
                  <option value="">Nenhum</option>{flows.data.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </td>
              <td className="space-x-2 whitespace-nowrap px-2 py-2 text-right">
                {c.provider === 'evolution' && <Btn tone="ghost" onClick={() => run(async () => { const r = await api(`/connections/${c.id}/import-contacts`, 'POST', {}); setInfo(`${r.imported} contatos importados.`); })}>Importar contatos</Btn>}
                {c.provider !== 'sandbox' && <Btn tone="ghost" onClick={() => connect(c)}>Conectar</Btn>}
                <Btn tone="danger" onClick={() => run(async () => { await api(`/connections/${c.id}`, 'DELETE'); await reload(); })}>Excluir</Btn>
              </td>
            </tr>
          ))}
        </Table>
        {!data.length && <Empty>Adicione a primeira conexão.</Empty>}
      </Card>
      {sandbox && (
        <Card className="mt-4">
          <h2 className="mb-2 text-sm font-bold">Simular mensagem recebida no Sandbox</h2>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/connections/${sandbox.id}/simulate`, 'POST', sim)); }}>
            <Label text="Telefone"><Input value={sim.phone} onChange={(e) => setSim({ ...sim, phone: e.target.value })} /></Label>
            <Label text="Nome"><Input value={sim.name} onChange={(e) => setSim({ ...sim, name: e.target.value })} /></Label>
            <div className="min-w-48 flex-1"><Label text="Mensagem"><Input value={sim.text} onChange={(e) => setSim({ ...sim, text: e.target.value })} /></Label></div>
            <Btn disabled={busy}>Simular</Btn>
          </form>
        </Card>
      )}
    </Page>
  );
}

export function Dispatches() {
  const { data, reload } = useData<any[]>('/dispatches', []);
  const flows = useData<any[]>('/flows', []);
  const conns = useData<any[]>('/connections', []);
  const labels = useData<any[]>('/labels', []);
  const [form, setForm] = useState({ name: '', flow_id: '', connection_id: '', label_id: '', per_minute: 20 });
  const { run, error, busy } = useAction();
  useEffect(() => { const t = setInterval(() => void reload(), 3000); return () => clearInterval(t); }, [reload]);
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Page title="Disparos em massa" hint="Quem pediu para sair nunca entra no disparo. O envio é espaçado para proteger o número.">
      <Card>
        <form className="grid gap-3 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/dispatches', 'POST', { ...form, label_id: form.label_id || null, per_minute: Number(form.per_minute) }); await reload(); }); }}>
          <Label text="Nome"><Input required value={form.name} onChange={set('name')} /></Label>
          <Label text="Fluxo"><Select required value={form.flow_id} onChange={set('flow_id')}><option value="">Selecione</option>{flows.data.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Label>
          <Label text="Conexão"><Select required value={form.connection_id} onChange={set('connection_id')}><option value="">Selecione</option>{conns.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Label>
          <Label text="Público"><Select value={form.label_id} onChange={set('label_id')}><option value="">Todos os contatos</option>{labels.data.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Label>
          <Label text="Envios por minuto (máx. 60)"><Input type="number" min={1} max={60} value={form.per_minute} onChange={set('per_minute')} /></Label>
          <div className="self-end"><Btn disabled={busy}>Iniciar disparo</Btn></div>
        </form>
      </Card>
      <Err>{error}</Err>
      <Card className="mt-4">
        <Table head={['Nome', 'Fluxo', 'Status', 'Enviados', 'Ignorados', 'Falhas', '']}>
          {data.map((d) => (
            <tr key={d.id}>
              <td className="px-2 py-2 font-semibold">{d.name}</td><td className="px-2 py-2">{d.flow_name}</td><td className="px-2 py-2"><Status value={d.status} /></td>
              <td className="px-2 py-2 tabular-nums">{d.sent} / {d.total}</td><td className="px-2 py-2 tabular-nums">{d.skipped}</td><td className="px-2 py-2 tabular-nums">{d.failed}</td>
              <td className="px-2 py-2 text-right">{d.status === 'running' && <Btn tone="danger" onClick={() => run(async () => { await api(`/dispatches/${d.id}/cancel`, 'POST'); await reload(); })}>Cancelar</Btn>}</td>
            </tr>
          ))}
        </Table>
        {!data.length && <Empty>Nenhum disparo ainda.</Empty>}
      </Card>
    </Page>
  );
}

export function Webhooks() {
  const { data, reload } = useData<any[]>('/inbound-webhooks', []);
  const flows = useData<any[]>('/flows', []);
  const conns = useData<any[]>('/connections', []);
  const [form, setForm] = useState({ name: '', flow_id: '', connection_id: '', phone: 'phone', contactName: 'name' });
  const { run, error, busy } = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Page title="Webhooks de entrada" hint="Receba eventos de checkouts e outros sistemas e inicie um fluxo.">
      <Card>
        <form className="grid gap-3 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/inbound-webhooks', 'POST', { name: form.name, flow_id: form.flow_id, connection_id: form.connection_id, mapping: { phone: form.phone, name: form.contactName } }); await reload(); }); }}>
          <Label text="Nome"><Input required value={form.name} onChange={set('name')} /></Label>
          <Label text="Fluxo"><Select required value={form.flow_id} onChange={set('flow_id')}><option value="">Selecione</option>{flows.data.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Label>
          <Label text="Conexão"><Select required value={form.connection_id} onChange={set('connection_id')}><option value="">Selecione</option>{conns.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Label>
          <Label text="Caminho do telefone no JSON"><Input value={form.phone} onChange={set('phone')} /></Label>
          <Label text="Caminho do nome no JSON"><Input value={form.contactName} onChange={set('contactName')} /></Label>
          <div className="self-end"><Btn disabled={busy}>Criar webhook</Btn></div>
        </form>
      </Card>
      <Err>{error}</Err>
      <Card className="mt-4">
        {data.map((w) => (
          <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-0">
            <div className="min-w-0"><p className="font-semibold">{w.name}</p><p className="break-all font-mono text-xs text-muted">{w.url}</p></div>
            <Btn tone="danger" onClick={() => run(async () => { await api(`/inbound-webhooks/${w.id}`, 'DELETE'); await reload(); })}>Excluir</Btn>
          </div>
        ))}
        {!data.length && <Empty>Nenhum webhook cadastrado.</Empty>}
      </Card>
    </Page>
  );
}

type Column = { k: string; label: string; area?: boolean };
export function SimpleCrud({ path, columns, title }: { path: string; columns: Column[]; title: string }) {
  const { data, reload } = useData<any[]>(path, []);
  const [form, setForm] = useState<Record<string, string>>({});
  const { run, error, busy } = useAction();
  return (
    <Card className="mb-4">
      <h2 className="mb-3 font-bold">{title}</h2>
      <form className="grid gap-2 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(path, 'POST', form); setForm({}); await reload(); }); }}>
        {columns.map((c) => (
          <Label key={c.k} text={c.label}>
            {c.area ? <Area required value={form[c.k] ?? ''} onChange={(e) => setForm({ ...form, [c.k]: e.target.value })} />
              : <Input required value={form[c.k] ?? ''} onChange={(e) => setForm({ ...form, [c.k]: e.target.value })} />}
          </Label>
        ))}
        <div className="self-end"><Btn disabled={busy}>Adicionar</Btn></div>
      </form>
      <Err>{error}</Err>
      <ul className="mt-3 divide-y divide-line">
        {data.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 whitespace-pre-wrap break-words"><strong>{r[columns[0].k]}</strong>{columns[1] && <span className="ml-2 text-muted">{String(r[columns[1].k]).slice(0, 160)}</span>}</span>
            <Btn tone="danger" onClick={() => run(async () => { await api(`${path}/${r.id}`, 'DELETE'); await reload(); })}>Excluir</Btn>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export const Agents = () => (
  <Page title="Agentes de IA" hint="Atendentes que conversam no WhatsApp. Use no bloco Agente de IA. Requer ANTHROPIC_API_KEY no servidor.">
    <SimpleCrud path="/ai-agents" title="Agentes" columns={[{ k: 'name', label: 'Nome' }, { k: 'prompt', label: 'Instruções', area: true }]} />
  </Page>
);