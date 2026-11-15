/** Conteúdos de um bloco Mensagem: vários itens em sequência dentro do mesmo bloco. */
export type MessageItem =
  | { type: 'text'; text?: string; typingSec?: number }
  | { type: 'image' | 'video' | 'audio' | 'file' | 'sticker'; url?: string; caption?: string; mode?: 'normal' | 'ptv'; recordingSec?: number; asVoice?: boolean }
  | { type: 'delay'; seconds?: number }
  | { type: 'contact'; name?: string; phone?: string };

/** Blocos antigos (texto + mídia únicos) continuam funcionando: viram uma lista de um item. */
export function messageItems(d: Record<string, any>): MessageItem[] {
  if (Array.isArray(d.items)) return d.items as MessageItem[];
  if (d.mediaUrl) {
    const t = d.mediaType === 'document' ? 'file' : d.mediaType ?? 'image';
    return [{ type: t, url: d.mediaUrl, caption: d.text }];
  }
  return [{ type: 'text', text: d.text }];
}

const clamp = (v: unknown, max: number) => Math.max(0, Math.min(max, Number(v) || 0));
export const typingMs = (sec: unknown) => clamp(sec, 60) * 1000;
export const recordingMs = (sec: unknown) => clamp(sec, 120) * 1000;
export const pauseMs = (sec: unknown) => clamp(sec, 120) * 1000;

/** Resumo curto do bloco para o cartão e para o fluxo (ex.: "Texto · Áudio · Vídeo"). */
export const ITEM_LABEL: Record<MessageItem['type'], string> = { text: 'Texto', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', file: 'Arquivo', sticker: 'Sticker', delay: 'Intervalo', contact: 'Contato' };
