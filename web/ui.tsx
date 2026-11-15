import { X } from 'lucide-react';
import { useCallback, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export const getToken = () => localStorage.getItem('magtron_token');
export const setToken = (t: string | null) => (t ? localStorage.setItem('magtron_token', t) : localStorage.removeItem('magtron_token'));

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/auth')) { setToken(null); location.href = '/'; }
  if (res.status === 204) return null as T;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error ?? 'Erro na requisição');
  return data;
}

export function useData<T = any>(path: string | null, fallback: T) {
  const [data, setData] = useState<T>(fallback);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await api<T>(path)); setError(''); } catch (e: any) { setError(e.message); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, reload, error };
}

const field = 'w-full rounded-md border border-line bg-white px-3 py-2 text-sm outline-none focus:border-ink';
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${field} ${p.className ?? ''}`} />;
export const Area = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={3} {...p} className={`${field} ${p.className ?? ''}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${field} ${p.className ?? ''}`} />;

export function Btn({ tone = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' }) {
  const tones = {
    primary: 'bg-ink text-volt hover:bg-ink-3',
    ghost: 'border border-line bg-white text-ink hover:border-ink',
    danger: 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
  };
  return <button {...p} className={`cursor-pointer rounded-md px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${className}`} />;
}

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) =>
  <section className={`rounded-lg border border-line bg-white p-4 ${className}`}>{children}</section>;

export const Page = ({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) => (
  <div className="mx-auto max-w-6xl p-4 md:p-8">
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      {action}
    </header>
    {children}
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-10 text-center text-sm text-muted">{children}</p>;
export const Err = ({ children }: { children: ReactNode }) => (children ? <p role="alert" className="mt-2 text-sm text-red-700">{children}</p> : null);

export const Label = ({ text, children }: { text: string; children: ReactNode }) => (
  <label className="block text-xs font-semibold text-muted">{text}<div className="mt-1 font-normal text-ink">{children}</div></label>
);

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead><tr className="border-b border-line text-xs text-muted">{head.map((h) => <th key={h} className="px-2 py-2 font-semibold">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

const STATUS: Record<string, string> = {
  connected: 'bg-volt text-ink', disconnected: 'bg-red-100 text-red-800', connecting: 'bg-amber-100 text-amber-900',
  running: 'bg-amber-100 text-amber-900', done: 'bg-volt text-ink', cancelled: 'bg-gray-200 text-gray-700',
};
const STATUS_TEXT: Record<string, string> = { connected: 'Conectada', disconnected: 'Desconectada', connecting: 'Aguardando QR', running: 'Em andamento', done: 'Concluído', cancelled: 'Cancelado' };
export const Status = ({ value }: { value: string }) => <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS[value] ?? 'bg-gray-100'}`}>{STATUS_TEXT[value] ?? value}</span>;

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-bold">{title}</h2><button aria-label="Fechar" onClick={onClose} className="cursor-pointer rounded p-1 hover:bg-paper"><X size={18} /></button></div>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <Btn type="button" tone="ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* navegador sem permissão */ } }}>{done ? 'Copiado' : label}</Btn>;
}

/** Wraps an async action and exposes its error message. */
export function useAction() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return { run, error, busy };
}
