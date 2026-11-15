import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api, Area, Btn, Card, Empty, Err, Input, Label, Page, Select, Table, setToken, useAction, useData } from './ui';
import { SimpleCrud } from './pages';
import { money } from './reports';

export function Team() {
  const members = useData<any[]>('/team', []);
  const invites = useData<any[]>('/team/invites', []);
  const [form, setForm] = useState({ email: '', role: 'agent' });
  const { run, error, busy } = useAction();
  return (
    <Card>
      <h2 className="mb-3 font-bold">Equipe</h2>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/team/invites', 'POST', form); setForm({ email: '', role: 'agent' }); await invites.reload(); }); }}>
        <div className="min-w-48 flex-1"><Label text="E-mail do convidado"><Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Label></div>
        <Label text="Função"><Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="agent">Atendente</option><option value="admin">Administrador</option></Select></Label>
        <Btn disabled={busy}>Gerar convite</Btn>
      </form>
      <Err>{error || invites.error}</Err>
      {invites.data.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-bold">Convites pendentes</h3>
          <p className="mb-2 text-xs text-muted">Envie o link para a pessoa. Ele vale por 7 dias.</p>
          {invites.data.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 text-sm last:border-0">
              <div className="min-w-0"><p className="font-semibold">{i.email}</p><p className="break-all font-mono text-xs text-muted">{i.url}</p></div>
              <Btn tone="danger" onClick={() => run(async () => { await api(`/team/invites/${i.id}`, 'DELETE'); await invites.reload(); })}>Revogar</Btn>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4">
        <Table head={['Nome', 'E-mail', 'Função', '']}>
          {members.data.map((m) => (
            <tr key={m.id}>
              <td className="px-2 py-2 font-semibold">{m.name}</td>
              <td className="px-2 py-2 text-xs">{m.email}</td>
              <td className="px-2 py-2">
                {m.role === 'owner' ? <span className="text-xs">Proprietário</span> : (
                  <Select aria-label={`Função de ${m.name}`} value={m.role} onChange={(e) => run(async () => { await api(`/team/${m.id}`, 'PATCH', { role: e.target.value }); await members.reload(); })}><option value="agent">Atendente</option><option value="admin">Administrador</option></Select>
                )}
              </td>
              <td className="px-2 py-2 text-right">{m.role !== 'owner' && <Btn tone="danger" onClick={() => run(async () => { await api(`/team/${m.id}`, 'DELETE'); await members.reload(); })}>Remover</Btn>}</td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

export function Templates() {
  const { data, reload, error: loadError } = useData<any[]>('/templates', []);
  const conns = useData<any[]>('/connections', []);
  const metas = conns.data.filter((c) => c.provider === 'meta');
  const [conn, setConn] = useState('');
  const [form, setForm] = useState({ name: '', category: 'UTILITY', body: '' });
  const { run, error, busy } = useAction();
  return (
    <Card>
      <h2 className="mb-1 font-bold">Templates WhatsApp</h2>
      <p className="mb-3 text-xs text-muted">Exclusivo da API Oficial. Na Evolution, o bloco Template envia o texto alternativo.</p>
      {metas.length === 0 ? <Empty>Adicione uma conexão da API Oficial com WABA ID para usar templates.</Empty> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Label text="Conexão"><Select value={conn} onChange={(e) => setConn(e.target.value)}><option value="">Selecione</option>{metas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Label>
            <Btn tone="ghost" disabled={busy || !conn} onClick={() => run(async () => { await api('/templates/sync', 'POST', { connection_id: conn }); await reload(); })}>Sincronizar</Btn>
          </div>
          <form className="grid gap-2 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/templates', 'POST', { ...form, connection_id: conn }); setForm({ name: '', category: 'UTILITY', body: '' }); await reload(); }); }}>
            <Label text="Nome (minúsculas e _)"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Label>
            <Label text="Categoria"><Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option value="UTILITY">Utilidade</option><option value="MARKETING">Marketing</option><option value="AUTHENTICATION">Autenticação</option></Select></Label>
            <Label text="Corpo, com {{1}} para variáveis"><Area required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Label>
            <div><Btn disabled={busy || !conn}>Enviar para aprovação</Btn></div>
          </form>
        </div>
      )}
      <Err>{error || loadError}</Err>
      {data.length > 0 && <div className="mt-3"><Table head={['Nome', 'Idioma', 'Categoria', 'Status', 'Conexão']}>{data.map((t) => <tr key={t.id}><td className="px-2 py-2 font-mono text-xs">{t.name}</td><td className="px-2 py-2 text-xs">{t.language}</td><td className="px-2 py-2 text-xs">{t.category}</td><td className="px-2 py-2 text-xs">{t.status}</td><td className="px-2 py-2 text-xs">{t.connection_name}</td></tr>)}</Table></div>}
    </Card>
  );
}

export function Outbound() {
  const { data, reload } = useData<any[]>('/outbound-webhooks', []);
  const [form, setForm] = useState({ name: '', url: '' });
  const { run, error, busy } = useAction();
  return (
    <Card>
      <h2 className="mb-1 font-bold">Webhooks de saída</h2>
      <p className="mb-3 text-xs text-muted">Avisa sistemas externos, como emissores de nota e rastreadores, a cada venda aprovada. O corpo é assinado em HMAC-SHA256 no cabeçalho X-Magtron-Signature.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/outbound-webhooks', 'POST', form); setForm({ name: '', url: '' }); await reload(); }); }}>
        <Label text="Nome"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Label>
        <div className="min-w-48 flex-1"><Label text="URL HTTPS"><Input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Label></div>
        <Btn disabled={busy}>Adicionar</Btn>
      </form>
      <Err>{error}</Err>
      {data.map((w) => (
        <div key={w.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-sm">
          <div className="min-w-0"><p className="font-semibold">{w.name}</p><p className="break-all font-mono text-xs text-muted">{w.url}</p><p className="break-all font-mono text-xs text-muted">Segredo: {w.secret}</p></div>
          <Btn tone="danger" onClick={() => run(async () => { await api(`/outbound-webhooks/${w.id}`, 'DELETE'); await reload(); })}>Excluir</Btn>
        </div>
      ))}
    </Card>
  );
}

export function Facebook() {
  const [days, setDays] = useState('30');
  const { data, error } = useData<any>(`/facebook/insights?days=${days}`, null);
  return (
    <Page title="Facebook" hint="Campanhas e gasto da conta de anúncios." action={
      <Select aria-label="Período" className="w-40" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">7 dias</option><option value="30">30 dias</option><option value="90">90 dias</option></Select>}>
      <Err>{error}</Err>
      <Card>
        {data && !data.configured && <Empty>Configure Meta Ads em Configurações, aba Integrações.</Empty>}
        {data?.configured && <>
          <p className="mb-3 text-sm">Gasto total: <strong className="tabular-nums">{money(data.spend)}</strong></p>
          <Table head={['Campanha', 'Gasto', 'Impressões', 'Cliques']}>{data.campaigns.map((c: any) => <tr key={c.name}><td className="px-2 py-2 font-semibold">{c.name}</td><td className="px-2 py-2 tabular-nums">{money(c.spend)}</td><td className="px-2 py-2 tabular-nums">{c.impressions}</td><td className="px-2 py-2 tabular-nums">{c.clicks}</td></tr>)}</Table>
          {!data.campaigns.length && <Empty>Sem campanhas no período.</Empty>}
        </>}
      </Card>
    </Page>
  );
}

export function Invite() {
  const { token } = useParams();
  const { data, error: loadError } = useData<any>(`/auth/invite/${token}`, null);
  const [form, setForm] = useState({ name: '', password: '' });
  const { run, error, busy } = useAction();
  return (
    <main className="grid min-h-full place-items-center bg-ink p-4">
      <form className="w-full max-w-sm space-y-3 rounded-lg bg-white p-6" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api(`/auth/invite/${token}`, 'POST', form.name ? form : { password: form.password }); setToken(r.token); location.href = '/'; }); }}>
        <p className="text-lg font-black tracking-[0.2em]">MAGTRON</p>
        <Err>{loadError}</Err>
        {data && <>
          <p className="text-sm">Você foi convidado para <strong>{data.company}</strong> como <span className="font-mono text-xs">{data.email}</span>.</p>
          {!data.hasUser && <Label text="Seu nome"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Label>}
          <Label text={data.hasUser ? 'Sua senha atual' : 'Crie uma senha (mínimo 8 caracteres)'}><Input required type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Label>
          <Err>{error}</Err>
          <Btn disabled={busy} className="w-full">Aceitar convite</Btn>
        </>}
      </form>
    </main>
  );
}
