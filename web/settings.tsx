import type { ComponentType } from 'react';
import { useSearchParams } from 'react-router';
import { AtSign, Bot, Building2, Clock, Database, FileText, MessageSquare, Package, Plug, Radar, Send, Tag, Users, Zap, type LucideIcon } from 'lucide-react';
import { Select } from './ui';
import { SimpleCrud } from './pages';
import { Team, Templates } from './pages2';
import { DefaultFlows, DispatchSettings, Hours, Integrations, McpTools, Tracking } from './settings-parts';

interface Tab { key: string; label: string; icon: LucideIcon; hint: string; Body: ComponentType }

const crud = (path: string, title: string, columns: { k: string; label: string; area?: boolean }[]) => () => <SimpleCrud path={path} columns={columns} title={title} />;

const GROUPS: { title: string; tabs: Tab[] }[] = [
  { title: 'Conta', tabs: [
    { key: 'team', label: 'Equipe', icon: Users, hint: 'Convide pessoas e defina o que cada uma pode fazer.', Body: Team },
    { key: 'hours', label: 'Horário de atendimento', icon: Clock, hint: 'Fuso e horários usados pelo bloco Horário comercial.', Body: Hours },
    { key: 'departments', label: 'Departamentos', icon: Building2, hint: 'Setores para direcionar conversas.', Body: crud('/departments', 'Departamentos', [{ k: 'name', label: 'Nome' }]) },
  ] },
  { title: 'Automação', tabs: [
    { key: 'default-flows', label: 'Fluxos Padrões', icon: Zap, hint: 'Defina os fluxos padrões de cada conexão do WhatsApp.', Body: DefaultFlows },
    { key: 'dispatches', label: 'Disparos em massa', icon: Send, hint: 'Cota e situação dos disparos.', Body: DispatchSettings },
    { key: 'quick-replies', label: 'Respostas Rápidas', icon: MessageSquare, hint: 'Atalhos de texto para o chat: digite / e o atalho.', Body: crud('/quick-replies', 'Respostas rápidas', [{ k: 'shortcut', label: 'Atalho' }, { k: 'body', label: 'Texto', area: true }]) },
    { key: 'templates', label: 'Templates WhatsApp', icon: FileText, hint: 'Modelos aprovados da API Oficial.', Body: Templates },
    { key: 'variables', label: 'Variáveis Globais', icon: AtSign, hint: 'Valores reutilizáveis nos fluxos com {{global.chave}}.', Body: crud('/global-variables', 'Variáveis globais', [{ k: 'key', label: 'Chave' }, { k: 'value', label: 'Valor' }]) },
    { key: 'fields', label: 'Campos Personalizados', icon: Database, hint: 'Dados extras do contato, usados em {{contact.chave}}.', Body: crud('/custom-fields', 'Campos personalizados', [{ k: 'label', label: 'Rótulo' }, { k: 'key', label: 'Chave' }]) },
    { key: 'labels', label: 'Etiquetas', icon: Tag, hint: 'Marque contatos para segmentar e disparar.', Body: crud('/labels', 'Etiquetas', [{ k: 'name', label: 'Nome' }]) },
  ] },
  { title: 'Integrações', tabs: [
    { key: 'integrations', label: 'Integrações', icon: Plug, hint: 'Conecte pagamentos, anúncios e inteligência artificial à sua conta.', Body: Integrations },
    { key: 'tracking', label: 'Trackeamento', icon: Radar, hint: 'Liga o anúncio ao WhatsApp e mostra de onde veio cada contato.', Body: Tracking },
    { key: 'products', label: 'Produtos', icon: Package, hint: 'Crie produtos para usar em vendas e fluxos.', Body: crud('/products', 'Produtos', [{ k: 'name', label: 'Nome' }, { k: 'price', label: 'Preço' }]) },
    { key: 'mcp', label: 'Ferramentas MCP', icon: Bot, hint: 'Conecte e gerencie seu servidor MCP.', Body: McpTools },
  ] },
];
const ALL = GROUPS.flatMap((g) => g.tabs);

export function Settings() {
  const [params, setParams] = useSearchParams();
  const current = ALL.find((t) => t.key === params.get('tab')) ?? ALL[0];
  const go = (key: string) => setParams({ tab: key });
  const Body = current.Body;
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      <p className="text-[11px] font-bold uppercase tracking-wider text-muted">Configurações</p>
      <h1 className="text-2xl font-bold tracking-tight">{current.label}</h1>
      <p className="mb-5 text-sm text-muted">{current.hint}</p>
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div className="md:hidden"><Select aria-label="Seção das configurações" value={current.key} onChange={(e) => go(e.target.value)}>{GROUPS.map((g) => <optgroup key={g.title} label={g.title}>{g.tabs.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</optgroup>)}</Select></div>
        <nav aria-label="Configurações" className="hidden md:block">
          {GROUPS.map((g) => (
            <div key={g.title} className="mb-5">
              <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">{g.title}</p>
              {g.tabs.map((t) => {
                const Icon = t.icon;
                return <button key={t.key} onClick={() => go(t.key)} aria-current={current.key === t.key ? 'page' : undefined} className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-semibold ${current.key === t.key ? 'bg-ink text-volt' : 'hover:bg-white'}`}><Icon size={16} />{t.label}</button>;
              })}
            </div>
          ))}
        </nav>
        <div className="min-w-0"><Body key={current.key} /></div>
      </div>
    </div>
  );
}
