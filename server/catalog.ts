export interface NodeSpec { label: string; data: Record<string, string>; outputs: string[] }

const T = 'texto; aceita {{contact.name}}, {{contact.phone}}, {{vars.x}}, {{global.x}}, {{sys.date}}, {{sys.time}}';

/** Block types the flow engine understands, with the data each one reads and its output handles. */
export const NODE_CATALOG: Record<string, NodeSpec> = {
  start: { label: 'Início', data: {}, outputs: ['out'] },
  message: { label: 'Mensagem', data: { items: 'lista em ordem de envio: {type:"text",text,typingSec} | {type:"image|video|audio|file|sticker",url,caption,mode:"normal|ptv"(vídeo),recordingSec,asVoice(áudio)} | {type:"delay",seconds} | {type:"contact",name,phone}. Formato antigo ainda vale: text, mediaUrl, mediaType' }, outputs: ['out'] },
  template: { label: 'Template WhatsApp', data: { templateName: 'nome', language: 'pt_BR', vars: 'lista de textos', text: 'texto alternativo' }, outputs: ['out'] },
  menu: { label: 'Menu', data: { text: T, options: 'lista de textos', variable: 'nome da variável' }, outputs: ['opt-0..N', 'invalid'] },
  carousel: { label: 'Sequência de cards', data: { cards: 'lista de textos' }, outputs: ['out'] },
  pix: { label: 'Botão PIX', data: { text: T, code: 'código copia e cola' }, outputs: ['out'] },
  wait_reply: { label: 'Aguarda resposta', data: { variable: 'nome', timeoutMin: 'minutos', mediaOnly: '"yes" = só aceita imagem ou PDF (comprovante); texto sai por "other"' }, outputs: ['out', 'timeout', 'other (só com mediaOnly)'] },
  condition: { label: 'Condicional', data: { left: T, op: 'eq|neq|contains|gt|lt|exists', right: T }, outputs: ['true', 'false'] },
  distributor: { label: 'Distribuidor', data: { weights: 'lista de pesos' }, outputs: ['opt-0..N'] },
  delay: { label: 'Intervalo inteligente', data: { seconds: 'número', jitter: 'variação em segundos' }, outputs: ['out'] },
  flow_link: { label: 'Conexão de fluxo', data: { flowId: 'id do fluxo' }, outputs: [] },
  tags: { label: 'Etiquetas', data: { add: 'lista de nomes' }, outputs: ['out'] },
  manipulator: { label: 'Manipulador', data: { field: 'chave do campo', value: T }, outputs: ['out'] },
  kanban: { label: 'Kanban', data: { kanbanId: 'id', kanbanName: 'nome (cria se não existir)', column: 'coluna' }, outputs: ['out'] },
  department: { label: 'Departamento', data: { department: 'nome' }, outputs: ['out'] },
  chat_control: { label: 'Controlador de chat', data: { status: 'open|waiting|resolved' }, outputs: ['out'] },
  notify: { label: 'Notificação', data: { text: T, phone: 'WhatsApp opcional' }, outputs: ['out'] },
  sale: { label: 'Venda aprovada', data: { product: 'nome', amount: 'valor', currency: 'BRL' }, outputs: ['out'] },
  ai: { label: 'Bloco de IA', data: { system: T, prompt: T, variable: 'nome', routes: 'lista "chave | quando usar"', autoSend: '1 para enviar', keepContext: '1 para usar histórico' }, outputs: ['out', 'error', 'route-<chave>'] },
  ai_agent: { label: 'Agente de IA', data: { agentId: 'id do agente' }, outputs: ['out', 'error'] },
  http: { label: 'Integração HTTP', data: { url: 'URL pública', method: 'GET|POST|PUT', body: 'JSON', variable: 'nome' }, outputs: ['ok', 'error'] },
  pixel: { label: 'Pixel Meta', data: { pixelId: 'opcional', event: 'Purchase', value: 'valor' }, outputs: ['out'] },
  business_hours: { label: 'Horário comercial', data: {}, outputs: ['open', 'closed'] },
  voice: { label: 'Voz', data: { text: T, voiceId: 'opcional' }, outputs: ['out', 'error'] },
  payment: { label: 'Pagamento Pix', data: { product: 'nome', amount: 'valor', text: T, email: 'opcional', timeoutMin: 'minutos' }, outputs: ['paid', 'timeout', 'error'] },
  call: { label: 'Ligar', data: { seconds: 'duração do toque' }, outputs: ['out', 'error'] },
};
