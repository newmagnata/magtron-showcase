import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { io } from 'socket.io-client';
import { api, Btn, Card, Empty, Err, getToken, Input, Label, Select, useAction, useData } from './ui';

const TABS = [['waiting', 'Aguardando'], ['open', 'Atendendo'], ['resolved', 'Resolvidos'], ['', 'Tudo']] as const;

export const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Não foi possível ler o arquivo'));
  r.readAsDataURL(file);
});
const mediaKind = (mime: string) => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document');

export function Chats() {
  const [tab, setTab] = useState<string>('waiting');
  const [filter, setFilter] = useState('');
  const [dept, setDept] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const [text, setText] = useState('');
  const [panel, setPanel] = useState<'' | 'new' | 'schedule'>('');
  const [when, setWhen] = useState('');
  const [newChat, setNewChat] = useState({ phone: '', name: '', connection_id: '' });
  const query = new URLSearchParams({ ...(tab ? { status: tab } : {}), ...(filter ? { filter } : {}), ...(dept ? { department: dept } : {}), ...(q ? { q } : {}) }).toString();
  const chats = useData<any[]>(`/chats?${query}`, []);
  const messages = useData<any[]>(selected ? `/chats/${selected.id}/messages` : null, []);
  const replies = useData<any[]>('/quick-replies', []);
  const departments = useData<any[]>('/departments', []);
  const flows = useData<any[]>('/flows', []);
  const runFlow = (flow_id: string) => run(async () => { await api(`/chats/${selected.id}/run-flow`, 'POST', { flow_id }); await refresh(); });
  const team = useData<any[]>('/team', []);
  const connections = useData<any[]>('/connections', []);
  const scheduled = useData<any[]>('/scheduled-messages', []);
  const { run, error, busy } = useAction();
  const bottom = useRef<HTMLDivElement>(null);
  const live = useRef({ chats: chats.reload, messages: messages.reload });
  live.current = { chats: chats.reload, messages: messages.reload };

  useEffect(() => {
    const socket = io({ auth: { token: getToken() } });
    socket.on('message', () => { void live.current.chats(); void live.current.messages(); });
    socket.on('chat', () => void live.current.chats());
    return () => void socket.disconnect();
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView(); }, [messages.data]);
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => void live.current.chats(), 400); // limpa o contador de não lidas
    return () => clearTimeout(t);
  }, [selected?.id]);

  const refresh = () => Promise.all([messages.reload(), chats.reload()]);
  const send = () => run(async () => { await api(`/chats/${selected.id}/messages`, 'POST', { text }); setText(''); await refresh(); });
  const setStatus = (status: string) => run(async () => { await api(`/chats/${selected.id}`, 'PATCH', { status }); setSelected(null); await chats.reload(); });
  const assign = (patch: object) => run(async () => { setSelected({ ...selected, ...(await api(`/chats/${selected.id}/assign`, 'PATCH', patch)) }); await chats.reload(); });
  const schedule = () => run(async () => {
    await api(`/chats/${selected.id}/schedule`, 'POST', { text, run_at: new Date(when).toISOString() });
    setText(''); setWhen(''); setPanel(''); await scheduled.reload();
  });
  const attach = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void run(async () => {
      const mime = file.type || 'application/octet-stream';
      const up = await api('/media', 'POST', { filename: file.name, mime, base64: await fileToBase64(file) });
      await api(`/chats/${selected.id}/media`, 'POST', { url: up.url, mediaType: mediaKind(mime), caption: text || undefined });
      setText(''); await refresh();
    });
  };
  const createChat = () => run(async () => {
    const chat = await api('/chats', 'POST', newChat);
    setPanel(''); setNewChat({ phone: '', name: '', connection_id: '' }); setTab('');
    setSelected({ ...chat, contact_name: newChat.name, contact_phone: newChat.phone.replace(/\D/g, '') });
  });
  const quick = text.startsWith('/') ? replies.data.filter((r) => `/${r.shortcut}`.startsWith(text)) : [];
  const pending = selected ? scheduled.data.filter((s) => s.chat_id === selected.id) : [];

  return (
    <div className="flex h-full">
      <div className={`${selected ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-line bg-white md:w-80`}>
        <div className="flex border-b border-line" role="tablist">
          {TABS.map(([v, l]) => <button key={v} role="tab" aria-selected={tab === v} onClick={() => setTab(v)} className={`flex-1 cursor-pointer py-3 text-xs font-semibold ${tab === v ? 'border-b-2 border-ink' : 'text-muted'}`}>{l}</button>)}
        </div>
        <div className="space-y-2 border-b border-line p-2">
          <Input aria-label="Buscar chats" placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex gap-2">
            <Select aria-label="Filtro" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">Todos</option><option value="unread">Não lidas</option><option value="unanswered">Não respondidas</option></Select>
            <Select aria-label="Departamento" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">Departamentos</option>{departments.data.map((d) => <option key={d.id}>{d.name}</option>)}</Select>
          </div>
          <Btn tone="ghost" className="w-full" onClick={() => setPanel(panel === 'new' ? '' : 'new')}>Novo chat</Btn>
          {panel === 'new' && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void createChat(); }}>
              <Input aria-label="Telefone do novo chat" required placeholder="Telefone com DDI" value={newChat.phone} onChange={(e) => setNewChat({ ...newChat, phone: e.target.value })} />
              <Input aria-label="Nome do novo chat" placeholder="Nome" value={newChat.name} onChange={(e) => setNewChat({ ...newChat, name: e.target.value })} />
              <Select aria-label="Conexão do novo chat" required value={newChat.connection_id} onChange={(e) => setNewChat({ ...newChat, connection_id: e.target.value })}><option value="">Conexão</option>{connections.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              <Btn disabled={busy} className="w-full">Abrir conversa</Btn>
            </form>
          )}
        </div>
        <ul className="flex-1 divide-y divide-line overflow-y-auto">
          {chats.data.map((c) => (
            <li key={c.id}>
              <button onClick={() => setSelected(c)} className={`w-full cursor-pointer px-4 py-3 text-left hover:bg-paper ${selected?.id === c.id ? 'bg-paper' : ''}`}>
                <div className="flex justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{c.contact_name || c.contact_phone}</span>
                  {c.unread > 0 && <span className="rounded-full bg-volt px-2 text-xs font-bold">{c.unread}</span>}
                </div>
                <p className="truncate text-xs text-muted">{c.last_message}</p>
                {c.department && <p className="mt-0.5 text-[11px] font-semibold text-volt-dark">{c.department}</p>}
              </button>
            </li>
          ))}
          {!chats.data.length && <Empty>Nenhuma conversa aqui.</Empty>}
        </ul>
      </div>
      {selected ? (
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-white p-3">
            <div className="min-w-0">
              <button className="mr-2 cursor-pointer text-sm underline md:hidden" onClick={() => setSelected(null)}>Voltar</button>
              <strong className="text-sm">{selected.contact_name || selected.contact_phone}</strong>
              <span className="ml-2 font-mono text-xs text-muted">{selected.contact_phone}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Atribuir departamento" className="w-36" value={selected.department ?? ''} onChange={(e) => assign({ department: e.target.value || null })}><option value="">Sem depto.</option>{departments.data.map((d) => <option key={d.id}>{d.name}</option>)}</Select>
              <Select aria-label="Atribuir atendente" className="w-36" value={selected.assigned_user_id ?? ''} onChange={(e) => assign({ assigned_user_id: e.target.value || null })}><option value="">Sem atendente</option>{team.data.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
              <Select aria-label="Rodar fluxo nesta conversa" className="w-36" value="" onChange={(e) => { if (e.target.value && confirm(`Rodar o fluxo "${flows.data.find((f) => f.id === e.target.value)?.name}" nesta conversa? O fluxo atual dela é interrompido.`)) runFlow(e.target.value); }}><option value="">Rodar fluxo…</option>{flows.data.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
              <Btn tone="ghost" onClick={() => setStatus('open')}>Atender</Btn>
              <Btn tone="ghost" onClick={() => setStatus('resolved')}>Resolver</Btn>
            </div>
          </header>
          <div className="flex-1 space-y-2 overflow-y-auto p-4">
            {messages.data.map((m) => (
              <div key={m.id} className={`max-w-[75%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${m.direction === 'out' ? 'ml-auto bg-ink text-white' : 'bg-white'}`}>
                {m.media_url && /^https?:\/\//i.test(m.media_url) && <a className="block underline" href={m.media_url} target="_blank" rel="noreferrer noopener">Abrir anexo</a>}
                {m.body}
              </div>
            ))}
            <div ref={bottom} />
          </div>
          {pending.length > 0 && (
            <Card className="mx-3 mb-2 p-2 text-xs">
              <p className="mb-1 font-semibold">Mensagens agendadas</p>
              {pending.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="truncate">{new Date(s.run_at).toLocaleString('pt-BR')} · {s.body}</span>
                  <button className="cursor-pointer underline" onClick={() => run(async () => { await api(`/scheduled-messages/${s.id}`, 'DELETE'); await scheduled.reload(); })}>Cancelar</button>
                </div>
              ))}
            </Card>
          )}
          <form className="border-t border-line bg-white p-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send(); }}>
            {quick.map((r) => <button type="button" key={r.id} onClick={() => setText(r.body)} className="mr-2 mb-2 cursor-pointer rounded bg-paper px-2 py-1 text-xs">/{r.shortcut}</button>)}
            {panel === 'schedule' && (
              <div className="mb-2 flex flex-wrap items-end gap-2">
                <Label text="Enviar em"><Input aria-label="Data do agendamento" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Label>
                <Btn type="button" disabled={busy || !when || !text.trim()} onClick={schedule}>Confirmar agendamento</Btn>
              </div>
            )}
            <div className="flex gap-2">
              <label className="grid cursor-pointer place-items-center rounded-md border border-line px-3 text-sm font-semibold hover:border-ink">
                Anexo<input type="file" aria-label="Anexar arquivo" className="sr-only" onChange={attach} />
              </label>
              <Btn type="button" tone="ghost" onClick={() => setPanel(panel === 'schedule' ? '' : 'schedule')}>Agendar</Btn>
              <Input aria-label="Mensagem" placeholder="Mensagem, ou / para respostas rápidas" value={text} onChange={(e) => setText(e.target.value)} />
              <Btn disabled={busy || !text.trim()}>Enviar</Btn>
            </div>
            <Err>{error}</Err>
          </form>
        </section>
      ) : <div className="hidden flex-1 place-items-center text-sm text-muted md:grid">Selecione uma conversa.<Err>{error}</Err></div>}
    </div>
  );
}
