import { useState, type FormEvent } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { api, Btn, Err, getToken, Input, Label, setToken, useAction, useData } from './ui';
import { Agents, Connections, Contacts, Dashboard, Dispatches, Kanban, Webhooks } from './pages';
import { Facebook, Invite } from './pages2';
import { Flows } from './flows';
import { Settings } from './settings';
import { Bot, LayoutDashboard, Megaphone, MessageSquare, Plug, Send, Settings as Cog, SquareKanban, Users, Webhook, Workflow, type LucideIcon } from 'lucide-react';
import { Chats } from './Chats';
import { FlowEditor } from './FlowEditor';

const NAV: readonly (readonly [string, readonly (readonly [string, string, LucideIcon])[]])[] = [
  ['Principal', [['/', 'Painel', LayoutDashboard], ['/chats', 'Chats', MessageSquare], ['/kanban', 'Kanban', SquareKanban], ['/contatos', 'Contatos', Users]]],
  ['Automação', [['/fluxos', 'Fluxos', Workflow], ['/agentes', 'Agentes de IA', Bot], ['/disparos', 'Disparos em massa', Send], ['/webhooks', 'Webhooks', Webhook]]],
  ['Sistema', [['/conexoes', 'Conexões', Plug], ['/facebook', 'Facebook', Megaphone], ['/config', 'Configurações', Cog]]],
];

const Mark = () => <img src="/logo.png" alt="" className="h-11 w-11 rounded-md bg-ink p-0.5" />;

function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', company: '' });
  const { run, error, busy } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = mode === 'login' ? { email: form.email, password: form.password } : form;
      setToken((await api(`/auth/${mode}`, 'POST', body)).token);
      location.reload();
    });
  };
  return (
    <main className="grid min-h-full place-items-center bg-ink p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-lg bg-white p-6">
        <div className="flex items-center gap-2 text-ink"><Mark /><span className="text-lg font-black tracking-[0.2em]">MAGTRON</span></div>
        <p className="text-sm text-muted">{mode === 'login' ? 'Entre na sua operação.' : 'Crie sua operação.'}</p>
        {mode === 'register' && <>
          <Label text="Seu nome"><Input required value={form.name} onChange={set('name')} /></Label>
          <Label text="Empresa"><Input required value={form.company} onChange={set('company')} /></Label>
        </>}
        <Label text="E-mail"><Input required type="email" value={form.email} onChange={set('email')} /></Label>
        <Label text="Senha (mínimo 8 caracteres)"><Input required type="password" minLength={8} value={form.password} onChange={set('password')} /></Label>
        <Err>{error}</Err>
        <Btn disabled={busy} className="w-full">{mode === 'login' ? 'Entrar' : 'Criar conta'}</Btn>
        <button type="button" className="w-full cursor-pointer text-sm text-muted underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Criar uma conta' : 'Já tenho conta'}
        </button>
      </form>
    </main>
  );
}

export function App() {
  const [open, setOpen] = useState(false);
  const [bell, setBell] = useState(false);
  const { data: me } = useData<any>(getToken() ? '/me' : null, null);
  const accounts = useData<any[]>(getToken() ? '/accounts' : null, []);
  const notes = useData<any[]>(getToken() ? '/notifications' : null, []);
  if (location.pathname.startsWith('/convite/')) return <Routes><Route path="/convite/:token" element={<Invite />} /></Routes>;
  if (!getToken()) return <Login />;
  const nav = me?.role === 'agent' ? NAV.slice(0, 1) : NAV;
  const switchTo = async (id: string) => { setToken((await api(`/accounts/${id}/switch`, 'POST', {})).token); location.href = '/'; };
  return (
    <div className="flex h-full">
      <aside className={`${open ? 'flex' : 'hidden'} fixed inset-y-0 z-20 w-60 flex-col bg-ink text-gray-300 md:static md:flex`}>
        <div className="flex items-center gap-2 p-5 text-volt"><Mark /><span className="font-black tracking-[0.2em]">MAGTRON</span></div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3" onClick={() => setOpen(false)}>
          {nav.map(([group, items]) => (
            <div key={group}>
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{group}</p>
              {items.map(([to, label, Icon]) => (
                <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${isActive ? 'bg-volt font-semibold text-ink' : 'hover:bg-ink-2'}`}><Icon size={16} />{label}</NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-ink-3 p-4 text-sm">
          {bell && (
            <ul className="mb-3 max-h-48 space-y-2 overflow-y-auto rounded-md bg-ink-2 p-2 text-xs">
              {notes.data.map((n) => <li key={n.id}>{n.body}<span className="block text-[10px] text-gray-500">{new Date(n.created_at).toLocaleString('pt-BR')}</span></li>)}
              {!notes.data.length && <li>Nenhuma notificação.</li>}
            </ul>
          )}
          {accounts.data.length > 1
            ? <select aria-label="Empresa ativa" className="w-full cursor-pointer rounded bg-ink-2 p-1 font-semibold text-white" value={accounts.data.find((a) => a.current)?.id ?? ''} onChange={(e) => void switchTo(e.target.value)}>{accounts.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            : <p className="truncate font-semibold text-white">{me?.company}</p>}
          <p className="truncate text-xs text-gray-400">{me?.email}</p>
          <div className="mt-2 flex gap-3 text-xs">
            <button className="cursor-pointer underline" onClick={() => { setBell(!bell); void notes.reload(); }}>Notificações{notes.data.length ? ` (${notes.data.length})` : ''}</button>
            <button className="cursor-pointer underline" onClick={() => { setToken(null); location.href = '/'; }}>Sair</button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <button aria-label="Abrir menu" className="m-3 cursor-pointer rounded border border-line bg-white px-3 py-1 text-sm md:hidden" onClick={() => setOpen(!open)}>Menu</button>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/chats" element={<Chats />} />
          <Route path="/kanban" element={<Kanban />} />
          <Route path="/contatos" element={<Contacts />} />
          <Route path="/fluxos" element={<Flows />} />
          <Route path="/fluxos/:id" element={<FlowEditor />} />
          <Route path="/agentes" element={<Agents />} />
          <Route path="/disparos" element={<Dispatches />} />
          <Route path="/webhooks" element={<Webhooks />} />
          <Route path="/conexoes" element={<Connections />} />
          <Route path="/config" element={<Settings />} />
          <Route path="/facebook" element={<Facebook />} />
        </Routes>
      </main>
    </div>
  );
}
