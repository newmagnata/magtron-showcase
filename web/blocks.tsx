import {
  Bell, Bot, Building2, CalendarClock, Clock, CreditCard, DollarSign, FileText, Globe, GitBranch, Kanban, LayoutGrid, List,
  MessageCircle, MessageSquare, Mic, PhoneCall, Play, Save, Share2, SlidersHorizontal, Tag, Target, type LucideIcon,
} from 'lucide-react';
import { itemsSummary } from './message-items';

export type Field = { k: string; label: string; kind: 'text' | 'area' | 'number' | 'lines' | 'select' | 'ref'; options?: [string, string][]; source?: 'flows' | 'agents' | 'kanbans' };
export type Block = { label: string; color: string; icon: LucideIcon; fields: Field[]; handles?: (d: any) => [string, string][]; summary?: (d: any) => string };

const optionHandles = (key: string) => (d: any) => ((d[key] ?? []) as string[]).map((o, i): [string, string] => [`opt-${i}`, String(o).slice(0, 14) || `${i + 1}`]);
const text = (d: any) => String(d.text ?? '');

export const BLOCKS: Record<string, Block> = {
  start: { label: 'Início', color: '#16a34a', icon: Play, fields: [] },
  message: { label: 'Mensagem', color: '#3b82f6', icon: MessageSquare, summary: itemsSummary, fields: [] },
  template: { label: 'Template WhatsApp', color: '#1d4ed8', icon: FileText, summary: (d) => d.templateName ?? text(d), fields: [{ k: 'templateName', label: 'Nome do template', kind: 'text' }, { k: 'language', label: 'Idioma (pt_BR)', kind: 'text' }, { k: 'vars', label: 'Variáveis (uma por linha)', kind: 'lines' }, { k: 'text', label: 'Texto alternativo (Evolution)', kind: 'area' }] },
  tags: { label: 'Etiquetas', color: '#6366f1', icon: Tag, summary: (d) => ((d.add ?? []) as string[]).join(', '), fields: [{ k: 'add', label: 'Etiquetas (uma por linha)', kind: 'lines' }] },
  pix: { label: 'Botão PIX', color: '#10b981', icon: CreditCard, summary: text, fields: [{ k: 'text', label: 'Instrução', kind: 'area' }, { k: 'code', label: 'Código copia e cola', kind: 'area' }] },
  menu: { label: 'Menu', color: '#a855f7', icon: List, summary: text, handles: (d) => [...optionHandles('options')(d), ['invalid', 'Inválida']], fields: [{ k: 'text', label: 'Pergunta', kind: 'area' }, { k: 'options', label: 'Opções (uma por linha)', kind: 'lines' }, { k: 'variable', label: 'Salvar em variável', kind: 'text' }] },
  carousel: { label: 'Carrossel', color: '#0ea5e9', icon: LayoutGrid, summary: (d) => `${(d.cards ?? []).length} cards`, fields: [{ k: 'cards', label: 'Um card por linha', kind: 'lines' }] },
  wait_reply: { label: 'Aguarda Resposta', color: '#f97316', icon: Save, summary: (d) => `${d.mediaOnly === 'yes' ? 'Comprovante (imagem/PDF)' : 'Resposta'} · ${d.timeoutMin ? `até ${d.timeoutMin} min` : 'sem limite'}`, handles: (d) => d.mediaOnly === 'yes' ? [['out', 'Enviou imagem/PDF'], ['other', 'Outra resposta'], ['timeout', 'Tempo limite']] : [['out', 'Respondeu'], ['timeout', 'Tempo limite']], fields: [{ k: 'mediaOnly', label: 'Esperar', kind: 'select', options: [['', 'Qualquer resposta'], ['yes', 'Só imagem ou PDF (comprovante)']] }, { k: 'variable', label: 'Salvar em variável', kind: 'text' }, { k: 'timeoutMin', label: 'Tempo limite (min)', kind: 'number' }] },
  chat_control: { label: 'Controlador de Chat', color: '#64748b', icon: MessageCircle, summary: (d) => `Mover para ${d.status ?? 'open'}`, fields: [{ k: 'status', label: 'Mover para', kind: 'select', options: [['open', 'Atendendo'], ['waiting', 'Aguardando'], ['resolved', 'Resolvido']] }] },
  notify: { label: 'Notificação', color: '#14b8a6', icon: Bell, summary: text, fields: [{ k: 'text', label: 'Aviso para a equipe', kind: 'area' }, { k: 'phone', label: 'Avisar também no WhatsApp (opcional)', kind: 'text' }] },
  condition: { label: 'Condicional', color: '#38bdf8', icon: GitBranch, summary: (d) => `${d.left ?? ''} ${d.op ?? ''} ${d.right ?? ''}`, handles: () => [['true', 'Verdadeiro'], ['false', 'Falso']], fields: [{ k: 'left', label: 'Valor, ex.: {{vars.cor}}', kind: 'text' }, { k: 'op', label: 'Operador', kind: 'select', options: [['eq', 'Igual'], ['neq', 'Diferente'], ['contains', 'Contém'], ['gt', 'Maior'], ['lt', 'Menor'], ['exists', 'Preenchido']] }, { k: 'right', label: 'Comparar com', kind: 'text' }] },
  distributor: { label: 'Distribuidor', color: '#f59e0b', icon: GitBranch, summary: (d) => `${(d.weights ?? []).length} caminhos`, handles: optionHandles('weights'), fields: [{ k: 'weights', label: 'Pesos (um por linha)', kind: 'lines' }] },
  flow_link: { label: 'Conexão de Fluxo', color: '#f43f5e', icon: Share2, summary: () => 'Vai para outro fluxo', handles: () => [], fields: [{ k: 'flowId', label: 'Ir para o fluxo', kind: 'ref', source: 'flows' }] },
  pixel: { label: 'Pixel', color: '#eab308', icon: Target, summary: (d) => `${d.event ?? 'Purchase'} ${d.value ?? ''}`, fields: [{ k: 'pixelId', label: 'ID do pixel (opcional)', kind: 'text' }, { k: 'event', label: 'Evento', kind: 'text' }, { k: 'value', label: 'Valor', kind: 'text' }] },
  delay: { label: 'Intervalo Inteligente', color: '#06b6d4', icon: Clock, summary: (d) => `${d.seconds ?? 0}s${d.jitter ? ` + até ${d.jitter}s` : ''}`, fields: [{ k: 'seconds', label: 'Segundos', kind: 'number' }, { k: 'jitter', label: 'Variação aleatória (s)', kind: 'number' }] },
  department: { label: 'Departamento', color: '#8b5cf6', icon: Building2, summary: (d) => d.department ?? '', fields: [{ k: 'department', label: 'Departamento', kind: 'text' }] },
  http: { label: 'Integração', color: '#3b82f6', icon: Globe, summary: (d) => `${d.method ?? 'POST'} ${d.url ?? ''}`, handles: () => [['ok', 'Sucesso'], ['error', 'Erro']], fields: [{ k: 'url', label: 'URL', kind: 'text' }, { k: 'method', label: 'Método', kind: 'select', options: [['POST', 'POST'], ['GET', 'GET'], ['PUT', 'PUT']] }, { k: 'body', label: 'Corpo JSON', kind: 'area' }, { k: 'variable', label: 'Salvar resposta em', kind: 'text' }] },
  ai: { label: 'Bloco de IA', color: '#10b981', icon: Bot, summary: (d) => String(d.prompt ?? ''), handles: (d) => [...((d.routes ?? []) as string[]).filter((l) => l.trim()).map((l): [string, string] => { const k = l.split('|')[0].trim(); return [`route-${k}`, k.slice(0, 14)]; }), ['out', 'Padrão'], ['error', 'Erro']], fields: [{ k: 'system', label: 'Instruções', kind: 'area' }, { k: 'prompt', label: 'Pedido', kind: 'area' }, { k: 'variable', label: 'Salvar em variável', kind: 'text' }, { k: 'routes', label: 'Saídas (chave | quando usar, uma por linha)', kind: 'lines' }, { k: 'autoSend', label: 'Enviar resposta ao cliente', kind: 'select', options: [['', 'Não'], ['1', 'Sim']] }, { k: 'keepContext', label: 'Usar histórico da conversa', kind: 'select', options: [['', 'Não'], ['1', 'Sim']] }] },
  ai_agent: { label: 'Agente de IA', color: '#111827', icon: Bot, summary: () => 'Conversa até concluir', handles: () => [['out', 'Concluiu'], ['error', 'Erro']], fields: [{ k: 'agentId', label: 'Agente', kind: 'ref', source: 'agents' }] },
  kanban: { label: 'Kanban', color: '#a855f7', icon: Kanban, summary: (d) => `${d.kanbanName ?? ''} ${d.column ? `› ${d.column}` : ''}`, fields: [{ k: 'kanbanId', label: 'Kanban', kind: 'ref', source: 'kanbans' }, { k: 'kanbanName', label: 'Ou nome (cria se não existir)', kind: 'text' }, { k: 'column', label: 'Coluna', kind: 'text' }] },
  manipulator: { label: 'Manipulador', color: '#f97316', icon: SlidersHorizontal, summary: (d) => `${d.field ?? ''} = ${d.value ?? ''}`, fields: [{ k: 'field', label: 'Campo do contato', kind: 'text' }, { k: 'value', label: 'Valor', kind: 'text' }] },
  sale: { label: 'Venda aprovada', color: '#16a34a', icon: DollarSign, summary: (d) => `${d.product ?? ''} ${d.amount ?? ''}`, fields: [{ k: 'product', label: 'Produto', kind: 'text' }, { k: 'amount', label: 'Valor', kind: 'text' }, { k: 'currency', label: 'Moeda', kind: 'text' }] },
  payment: { label: 'Pagamento', color: '#8b5cf6', icon: CreditCard, summary: (d) => `Pix ${d.amount ?? ''}`, handles: () => [['paid', 'Pago'], ['timeout', 'Tempo limite'], ['error', 'Erro']], fields: [{ k: 'product', label: 'Produto', kind: 'text' }, { k: 'amount', label: 'Valor', kind: 'text' }, { k: 'text', label: 'Instrução', kind: 'area' }, { k: 'email', label: 'E-mail do pagador (opcional)', kind: 'text' }, { k: 'timeoutMin', label: 'Tempo limite (min)', kind: 'number' }] },
  call: { label: 'Ligar', color: '#14b8a6', icon: PhoneCall, summary: (d) => `Toca ${d.seconds ?? 10}s`, handles: () => [['out', 'Ligou'], ['error', 'Erro']], fields: [{ k: 'seconds', label: 'Duração do toque (s)', kind: 'number' }] },
  voice: { label: 'Voz', color: '#d946ef', icon: Mic, summary: text, handles: () => [['out', 'Enviado'], ['error', 'Erro']], fields: [{ k: 'text', label: 'Texto falado', kind: 'area' }, { k: 'voiceId', label: 'ID da voz (opcional)', kind: 'text' }] },
  business_hours: { label: 'Horário comercial', color: '#0369a1', icon: CalendarClock, summary: () => 'Aberto ou fechado', handles: () => [['open', 'Aberto'], ['closed', 'Fechado']], fields: [] },
};

/**
 * Cores do cartão em degradê por categoria: cabeçalho em degradê do tom 600 para o 500,
 * corpo no tom 100 e borda no tom 300 da cor do bloco.
 */
export const tone = (color: string) => ({
  header: `linear-gradient(90deg, color-mix(in srgb, ${color} 84%, black), ${color})`,
  body: `color-mix(in srgb, ${color} 14%, white)`,
  border: `color-mix(in srgb, ${color} 40%, white)`,
});

/** Palette order, followed by blocks that only MAGTRON has. */
export const PALETTE = ['message', 'template', 'tags', 'pix', 'menu', 'carousel', 'wait_reply', 'chat_control', 'notify', 'condition', 'distributor', 'flow_link', 'pixel', 'delay', 'department', 'http', 'ai', 'ai_agent', 'kanban', 'manipulator', 'sale', 'payment', 'call', 'voice', 'business_hours'];
