import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bold, ChevronDown, ChevronUp, Clock, Code, Contact, FileText, Image as ImageIcon, Italic, Link as LinkIcon, MessageSquare, Mic, Smile,
  Sticker, Strikethrough, Trash2, Upload, Video, X, type LucideIcon,
} from 'lucide-react';
import { api, Btn, Err, Input, Label } from './ui';
import { fileToBase64 } from './Chats';
import { ITEM_LABEL, messageItems, newItem, type ItemType, type MessageItem } from './message-items';

const META: Record<ItemType, { icon: LucideIcon; color: string; accept?: string }> = {
  text: { icon: MessageSquare, color: '#3b82f6' },
  image: { icon: ImageIcon, color: '#16a34a', accept: 'image/png,image/jpeg,image/webp,image/gif' },
  video: { icon: Video, color: '#8b5cf6', accept: 'video/mp4' },
  audio: { icon: Mic, color: '#f97316', accept: 'audio/mpeg,audio/ogg,audio/mp4,.mp3,.ogg,.m4a' },
  delay: { icon: Clock, color: '#06b6d4' },
  contact: { icon: Contact, color: '#ec4899' },
  file: { icon: FileText, color: '#6366f1', accept: '' },
  sticker: { icon: Sticker, color: '#f59e0b', accept: 'image/webp' },
};
const ADD_ORDER: ItemType[] = ['text', 'image', 'video', 'audio', 'delay', 'contact', 'file', 'sticker'];
const EMOJIS = ['😊', '😉', '😍', '🥰', '💜', '❤️', '🔥', '✨', '👆', '👇', '👉', '🎁', '✅', '⭐', '🙏', '👏', '😅', '🤩', '💬', '📦', '🚚', '🔒', '😘', '🥳'];
const MAX_MB = 16;

/** Endereço de um arquivo guardado no MAGTRON vira caminho relativo, para a prévia abrir de qualquer endereço de acesso. */
const previewSrc = (url: string) => (/\/media\/[0-9a-f-]{36}$/.test(url) ? new URL(url).pathname : url);

function Slider({ label, value, max, onChange, hint }: { label: string; value: number; max: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-muted"><span>{label}</span><b className="text-sm text-ink">{value} segundos</b><span>{max} segundos</span></div>
      <input type="range" min={0} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full cursor-pointer accent-ink" aria-label={label} />
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string, ReactNode?][]; onChange: (v: T) => void }) {
  return (
    <div className="grid rounded-lg border border-line bg-paper p-0.5 text-sm" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }} role="tablist">
      {options.map(([v, l, icon]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} onClick={() => onChange(v)}
          className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-semibold ${value === v ? 'bg-ink text-volt' : 'text-muted hover:text-ink'}`}>{icon}{l}</button>
      ))}
    </div>
  );
}

/** Escolhe arquivo (envia para o MAGTRON) ou cola uma URL, com prévia. */
function MediaSource({ item, set }: { item: MessageItem; set: (p: Partial<MessageItem>) => void }) {
  const meta = META[item.type];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const source = item.source ?? (item.url && !/\/media\/[0-9a-f-]{36}$/.test(item.url) ? 'url' : 'file');
  const pick = async (file?: File) => {
    if (!file) return;
    setError('');
    if (file.size > MAX_MB * 1024 * 1024) return setError(`Arquivo maior que ${MAX_MB} MB (limite do WhatsApp)`);
    setBusy(true);
    try {
      const up = await api('/media', 'POST', { filename: file.name, mime: file.type || 'application/octet-stream', base64: await fileToBase64(file) });
      set({ url: up.url, fileName: file.name, source: 'file' });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const src = item.url ? previewSrc(item.url) : '';
  return (
    <div className="space-y-2">
      <Tabs value={source} onChange={(v) => set({ source: v })} options={[['file', 'Arquivo', <Upload key="u" size={14} />], ['url', 'URL', <LinkIcon key="l" size={14} />]]} />
      {source === 'url'
        ? <Input placeholder="https://…" value={item.url ?? ''} onChange={(e) => set({ url: e.target.value.trim() })} aria-label="URL do arquivo" />
        : (
          <div className="rounded-lg border-2 border-dashed border-line p-3 text-center text-sm">
            {item.url && !busy ? (
              <div className="space-y-2">
                {item.type === 'video' && <video src={src} controls className="mx-auto max-h-64 rounded bg-black" />}
                {item.type === 'audio' && <audio src={src} controls className="w-full" />}
                {(item.type === 'image' || item.type === 'sticker') && <img src={src} alt="Prévia" className="mx-auto max-h-48 rounded" />}
                {item.type === 'file' && <p className="font-semibold">{item.fileName ?? 'Arquivo enviado'}</p>}
                <div className="flex items-center justify-center gap-3 text-xs text-muted">
                  {item.fileName && <span>{item.fileName}</span>}
                  <button type="button" className="cursor-pointer font-semibold text-red-700 hover:underline" onClick={() => set({ url: '', fileName: '' })}>Remover</button>
                </div>
              </div>
            ) : (
              <label className="block cursor-pointer py-4 text-muted hover:text-ink">
                <Upload className="mx-auto mb-1" size={20} />
                {busy ? 'Enviando…' : `Clique para escolher o ${ITEM_LABEL[item.type].toLowerCase()} (até ${MAX_MB} MB)`}
                <input type="file" className="sr-only" accept={meta.accept || undefined} disabled={busy} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            )}
          </div>
        )}
      <Err>{error}</Err>
    </div>
  );
}

function RichText({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [emoji, setEmoji] = useState(false);
  const wrap = (mark: string) => {
    const el = ref.current; if (!el) return;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    onChange(value.slice(0, a) + mark + value.slice(a, b) + mark + value.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + mark.length, b + mark.length); });
  };
  const insert = (t: string) => {
    const el = ref.current; const a = el?.selectionStart ?? value.length;
    onChange(value.slice(0, a) + t + value.slice(el?.selectionEnd ?? a));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + t.length, a + t.length); });
  };
  const tool = 'grid h-8 w-8 cursor-pointer place-items-center rounded text-muted hover:bg-paper hover:text-ink';
  return (
    <div className="relative overflow-hidden rounded-md border border-line bg-white focus-within:border-ink">
      <textarea ref={ref} rows={5} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Digite a mensagem…" className="block w-full resize-y bg-paper/40 px-3 py-2 text-sm outline-none" aria-label="Conteúdo da mensagem" />
      <div className="flex items-center gap-0.5 border-t border-line px-2 py-1">
        <button type="button" className={tool} title="Negrito" aria-label="Negrito" onClick={() => wrap('*')}><Bold size={15} /></button>
        <button type="button" className={tool} title="Itálico" aria-label="Itálico" onClick={() => wrap('_')}><Italic size={15} /></button>
        <button type="button" className={tool} title="Riscado" aria-label="Riscado" onClick={() => wrap('~')}><Strikethrough size={15} /></button>
        <button type="button" className={tool} title="Emoji" aria-label="Emoji" onClick={() => setEmoji((v) => !v)}><Smile size={15} /></button>
        <button type="button" className={tool} title="Código" aria-label="Código" onClick={() => wrap('```')}><Code size={15} /></button>
      </div>
      {emoji && (
        <div className="absolute bottom-11 left-2 z-10 grid w-64 grid-cols-8 gap-1 rounded-lg border border-line bg-white p-2 shadow-lg">
          {EMOJIS.map((e) => <button key={e} type="button" className="cursor-pointer rounded p-1 text-lg hover:bg-paper" onClick={() => { insert(e); setEmoji(false); }}>{e}</button>)}
        </div>
      )}
    </div>
  );
}

function ItemCard({ item, index, count, set, move, remove }: { item: MessageItem; index: number; count: number; set: (p: Partial<MessageItem>) => void; move: (d: -1 | 1) => void; remove: () => void }) {
  const { icon: Icon, color } = META[item.type];
  const caption = (
    <Label text="Legenda"><RichText value={item.caption ?? ''} onChange={(v) => set({ caption: v })} /></Label>
  );
  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-sm" aria-label={`${ITEM_LABEL[item.type]} ${index + 1}`}>
      <header className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold" style={{ color }}><Icon size={16} />{ITEM_LABEL[item.type]}</h3>
        <div className="flex items-center gap-1 text-muted">
          <button type="button" aria-label="Mover para cima" disabled={index === 0} onClick={() => move(-1)} className="cursor-pointer rounded p-1 hover:bg-paper disabled:opacity-30"><ChevronUp size={16} /></button>
          <button type="button" aria-label="Mover para baixo" disabled={index === count - 1} onClick={() => move(1)} className="cursor-pointer rounded p-1 hover:bg-paper disabled:opacity-30"><ChevronDown size={16} /></button>
          <button type="button" aria-label="Excluir conteúdo" onClick={remove} className="cursor-pointer rounded p-1 text-red-600 hover:bg-red-50"><Trash2 size={16} /></button>
        </div>
      </header>
      <div className="space-y-3">
        {item.type === 'text' && (<>
          <Label text="Conteúdo da Mensagem *"><RichText value={item.text ?? ''} onChange={(v) => set({ text: v })} /></Label>
          <Slider label={'Delay do "digitando"'} value={item.typingSec ?? 0} max={60} onChange={(v) => set({ typingSec: v })} hint="Tempo que o WhatsApp ficará “digitando” antes de enviar esta mensagem." />
        </>)}
        {item.type === 'image' && (<><MediaSource item={item} set={set} />{caption}</>)}
        {item.type === 'video' && (<>
          <Tabs value={item.mode ?? 'normal'} onChange={(v) => set({ mode: v })} options={[['normal', 'Normal', <Video key="v" size={14} />], ['ptv', 'Vídeo msg.']]} />
          <p className="text-xs text-muted">Normal: envio padrão, com legenda. Vídeo msg.: formato de mensagem de vídeo redonda do WhatsApp (sem legenda).</p>
          <MediaSource item={item} set={set} />
          {(item.mode ?? 'normal') === 'normal' && caption}
        </>)}
        {item.type === 'audio' && (<>
          <MediaSource item={item} set={set} />
          <Slider label={'Delay do "gravando"'} value={item.recordingSec ?? 0} max={120} onChange={(v) => set({ recordingSec: v })} hint="Tempo que o WhatsApp ficará “gravando” antes de enviar o áudio." />
          <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-ink" checked={item.asVoice !== false} onChange={(e) => set({ asVoice: e.target.checked })} />Enviar como gravado</label>
        </>)}
        {item.type === 'file' && (<><MediaSource item={item} set={set} />{caption}</>)}
        {item.type === 'sticker' && <MediaSource item={item} set={set} />}
        {item.type === 'delay' && <Slider label="Aguardar" value={item.seconds ?? 0} max={120} onChange={(v) => set({ seconds: v })} hint="O fluxo espera esse tempo antes de enviar o próximo conteúdo." />}
        {item.type === 'contact' && (<>
          <Label text="Nome do contato"><Input value={item.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Label>
          <Label text="Telefone com DDI e DDD (ex.: 5511999999999)"><Input inputMode="numeric" value={item.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} /></Label>
        </>)}
      </div>
    </section>
  );
}

const problems = (items: MessageItem[]) => items.map((it, i) => {
  const n = `${i + 1}º conteúdo (${ITEM_LABEL[it.type]})`;
  if (it.type === 'text' && !(it.text ?? '').trim()) return `${n}: escreva o texto`;
  if (['image', 'video', 'audio', 'file', 'sticker'].includes(it.type) && !(it.url ?? '').trim()) return `${n}: envie um arquivo ou informe a URL`;
  if (it.type === 'contact' && !(it.phone ?? '').replace(/\D/g, '')) return `${n}: informe o telefone`;
  return '';
}).filter(Boolean);

export function MessageEditor({ data, onSave, onClose }: { data: Record<string, any>; onSave: (d: Record<string, any>) => void; onClose: () => void }) {
  const [items, setItems] = useState<MessageItem[]>(() => messageItems(data).map((i) => ({ ...i })));
  const [warn, setWarn] = useState<string[]>([]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  const update = (i: number, p: Partial<MessageItem>) => setItems((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: -1 | 1) => setItems((l) => { const c = [...l]; [c[i], c[i + d]] = [c[i + d], c[i]]; return c; });
  const save = () => {
    const p = problems(items);
    if (p.length) return setWarn(p);
    const { text: _t, mediaUrl: _u, mediaType: _m, ...rest } = data; // o formato antigo sai: tudo fica em "items"
    onSave({ ...rest, items: items.map(({ source: _s, ...i }) => i) });
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-3" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Editar Mensagem" className="flex max-h-[94vh] w-full max-w-[480px] flex-col rounded-xl bg-white shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#3b82f6] text-white"><MessageSquare size={20} /></span>
          <h2 className="flex-1 text-lg font-bold">Editar Mensagem</h2>
          <button type="button" aria-label="Fechar" onClick={onClose} className="cursor-pointer rounded p-1 text-muted hover:bg-paper"><X size={20} /></button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto bg-paper/40 p-4">
          {items.length === 0 && <p className="py-6 text-center text-sm text-muted">Nenhum conteúdo ainda. Adicione abaixo.</p>}
          {items.map((it, i) => <ItemCard key={i} item={it} index={i} count={items.length} set={(p) => update(i, p)} move={(d) => move(i, d)} remove={() => setItems((l) => l.filter((_, j) => j !== i))} />)}
          <div>
            <h3 className="mb-2 text-sm font-bold">Adicionar Conteúdo</h3>
            <div className="grid grid-cols-4 gap-2">
              {ADD_ORDER.map((t) => {
                const { icon: Icon, color } = META[t];
                return (
                  <button key={t} type="button" onClick={() => { setItems((l) => [...l, newItem(t)]); setWarn([]); }}
                    className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-line bg-white px-1 py-3 text-xs font-semibold hover:border-ink">
                    <span className="grid h-9 w-9 place-items-center rounded-full" style={{ background: `color-mix(in srgb, ${color} 15%, white)`, color }}><Icon size={17} /></span>{ITEM_LABEL[t]}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-muted">Variáveis: {'{{contact.name}}'}, {'{{contact.phone}}'}, {'{{vars.nome}}'}, {'{{global.chave}}'}. Formatação do WhatsApp: *negrito*, _itálico_, ~riscado~.</p>
        </div>
        <footer className="border-t border-line px-5 py-3">
          {warn.length > 0 && <ul role="alert" className="mb-2 list-disc pl-5 text-sm text-red-700">{warn.map((w) => <li key={w}>{w}</li>)}</ul>}
          <div className="flex justify-end gap-2"><Btn tone="ghost" onClick={onClose}>Cancelar</Btn><Btn onClick={save}>Salvar</Btn></div>
        </footer>
      </div>
    </div>
  );
}
