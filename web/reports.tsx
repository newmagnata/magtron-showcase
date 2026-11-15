import { useState, type ReactNode } from 'react';
import { api, Btn, Card, Empty, Err, Input, Label, Table, useAction, useData } from './ui';

export const money = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const Kpi = ({ label, value }: { label: string; value: ReactNode }) => (
  <Card><p className="text-xs font-semibold text-muted">{label}</p><p className="mt-1 text-2xl font-bold tabular-nums">{value}</p></Card>
);

function Ranking({ title, rows, render }: { title: string; rows: any[]; render: (r: any) => [string, string] }) {
  return (
    <Card>
      <h2 className="mb-2 text-sm font-bold">{title}</h2>
      {rows.length ? (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r) => { const [a, b] = render(r); return <li key={a} className="flex justify-between gap-3 py-1.5"><span className="truncate">{a}</span><span className="tabular-nums">{b}</span></li>; })}
        </ul>
      ) : <Empty>Sem dados no período.</Empty>}
    </Card>
  );
}

export function SalesDetails({ days, revenue, reloadTop }: { days: string; revenue: number; reloadTop: () => void }) {
  const { data, reload, error } = useData<any>(`/dashboard/details?days=${days}`, null);
  const ads = useData<any>(`/facebook/insights?days=${days}`, null);
  const [form, setForm] = useState({ product: '', amount: '' });
  const { run, error: actionError, busy } = useAction();
  if (!data) return <Err>{error}</Err>;
  const hours = Array.from({ length: 24 }, (_, h) => data.byHour.find((x: any) => x.hour === h)?.n ?? 0);
  const max = Math.max(1, ...hours);
  const spend = ads.data?.configured ? ads.data.spend as number : null;
  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const csv = ['data,cliente,telefone,conexao,produto,valor,moeda', ...data.sales.map((s: any) => [s.created_at, s.contact_name, s.contact_phone, s.connection_name, s.product, s.amount, s.currency].map(esc).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'vendas.csv';
    a.click();
  };
  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi label="Gasto Meta" value={spend === null ? '—' : money(spend)} />
        <Kpi label="ROAS" value={spend ? (revenue / spend).toFixed(2) : '—'} />
        <Kpi label="Lucro (faturamento − anúncios)" value={spend === null ? '—' : money(revenue - spend)} />
      </div>
      <Err>{ads.error}</Err>
      <Card className="mt-4">
        <h2 className="mb-3 text-sm font-bold">Vendas por horário</h2>
        <div className="flex h-28 items-end gap-1">
          {hours.map((n, h) => <div key={h} title={`${h}h: ${n}`} className="flex-1 rounded-t bg-volt-dark" style={{ height: `${Math.max(2, (n / max) * 100)}%` }} />)}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted"><span>0h</span><span>12h</span><span>23h</span></div>
      </Card>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <Ranking title="Por conexão" rows={data.byConnection} render={(r) => [r.name, money(r.revenue)]} />
        <Ranking title="Por produto" rows={data.byProduct} render={(r) => [r.name, money(r.revenue)]} />
        <Ranking title="Por estado" rows={data.byState} render={(r) => [r.uf, String(r.n)]} />
      </div>
      <Card className="mt-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-bold">Histórico de vendas</h2>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/sales', 'POST', { product: form.product, amount: Number(form.amount) }); setForm({ product: '', amount: '' }); await reload(); reloadTop(); }); }}>
            <Label text="Produto"><Input required value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} /></Label>
            <Label text="Valor"><Input required type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Label>
            <Btn disabled={busy}>Nova venda</Btn>
            <Btn type="button" tone="ghost" onClick={exportCsv}>Exportar CSV</Btn>
          </form>
        </div>
        <Err>{actionError}</Err>
        <Table head={['Data', 'Cliente', 'Conexão', 'Produto', 'Valor']}>
          {data.sales.map((s: any) => (
            <tr key={s.id}>
              <td className="px-2 py-2 text-xs">{new Date(s.created_at).toLocaleString('pt-BR')}</td>
              <td className="px-2 py-2">{s.contact_name || s.contact_phone || '—'}</td>
              <td className="px-2 py-2 text-xs">{s.connection_name ?? '—'}</td>
              <td className="px-2 py-2">{s.product}</td>
              <td className="px-2 py-2 tabular-nums">{money(Number(s.amount))}</td>
            </tr>
          ))}
        </Table>
        {!data.sales.length && <Empty>Nenhuma venda no período.</Empty>}
      </Card>
    </>
  );
}
