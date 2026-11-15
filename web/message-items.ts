/** Espelho de server/message-items.ts: mesmo formato de conteúdos do bloco Mensagem. */
export type ItemType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'delay' | 'contact';
export type MessageItem = {
  type: ItemType;
  text?: string; typingSec?: number;
  url?: string; caption?: string; mode?: 'normal' | 'ptv'; recordingSec?: number; asVoice?: boolean;
  source?: 'file' | 'url'; fileName?: string;
  seconds?: number; name?: string; phone?: string;
};

export const ITEM_LABEL: Record<ItemType, string> = { text: 'Texto', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', file: 'Arquivo', sticker: 'Sticker', delay: 'Intervalo', contact: 'Contato' };

/** Blocos antigos (texto + mídia única) viram uma lista de um item. */
export function messageItems(d: Record<string, any>): MessageItem[] {
  if (Array.isArray(d.items)) return d.items as MessageItem[];
  if (d.mediaUrl) return [{ type: d.mediaType === 'document' ? 'file' : (d.mediaType ?? 'image'), url: d.mediaUrl, caption: d.text }];
  return d.text ? [{ type: 'text', text: d.text }] : [];
}

export const newItem = (type: ItemType): MessageItem => ({
  text: { type, text: '', typingSec: 6 },
  image: { type, url: '', caption: '' },
  video: { type, url: '', caption: '', mode: 'normal' },
  audio: { type, url: '', recordingSec: 20, asVoice: true },
  file: { type, url: '', caption: '' },
  sticker: { type, url: '' },
  delay: { type, seconds: 5 },
  contact: { type, name: '', phone: '' },
} as Record<ItemType, MessageItem>)[type];

export function itemsSummary(d: Record<string, any>): string {
  return messageItems(d).map((i) => (i.type === 'text' ? (i.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Texto vazio'
    : i.type === 'delay' ? `Intervalo ${i.seconds ?? 0}s` : ITEM_LABEL[i.type] + (i.type === 'video' && i.caption ? `: ${i.caption.slice(0, 30)}` : ''))).join(' + ');
}
