import { describe, expect, it } from 'vitest';
import { autoLayout, looksMessy, NODE_W } from '../web/layout';

const n = (id: string, type = 'message') => ({ id, type, height: 150 });
const e = (source: string, target: string) => ({ source, target });

describe('autoLayout', () => {
  it('põe cada bloco à direita de quem o chama e sem sobreposição', () => {
    const nodes = [n('s', 'start'), ...'abcdefgh'.split('').map((id) => n(id))];
    const edges = [e('s', 'a'), e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd'), e('d', 'e'), e('d', 'f'), e('f', 'g'), e('g', 'h'), e('e', 'h')];
    const p = autoLayout(nodes, edges);
    for (const ed of edges) expect(p[ed.target].x).toBeGreaterThan(p[ed.source].x);
    const ids = Object.keys(p);
    for (const a of ids) for (const b of ids) {
      if (a >= b || p[a].x !== p[b].x) continue;
      expect(Math.abs(p[a].y - p[b].y)).toBeGreaterThanOrEqual(150);
    }
    expect(p.s.x).toBeLessThan(p.a.x);
  });

  it('aguenta ciclos e blocos soltos', () => {
    const nodes = [n('s', 'start'), n('a'), n('b'), n('x')];
    const p = autoLayout(nodes, [e('s', 'a'), e('a', 'b'), e('b', 'a')]);
    expect(Object.keys(p).sort()).toEqual(['a', 'b', 's', 'x']);
    expect(p.b.x).toBeGreaterThan(p.a.x);
    for (const k of Object.keys(p)) { expect(Number.isFinite(p[k].x)).toBe(true); expect(Number.isFinite(p[k].y)).toBe(true); }
  });

  it('usa colunas com a largura do cartão mais folga', () => {
    const p = autoLayout([n('s', 'start'), n('a')], [e('s', 'a')]);
    expect(p.a.x - p.s.x).toBeGreaterThan(NODE_W);
  });

  it('organiza 167 blocos em poucos segundos, sem sobrepor', () => {
    const nodes = [n('s', 'start')]; const edges = [];
    for (let i = 0; i < 166; i++) { nodes.push(n(`n${i}`)); edges.push(e(i < 3 ? 's' : `n${Math.floor(i / 2) - 1}`, `n${i}`)); }
    const t = Date.now(); const p = autoLayout(nodes, edges);
    expect(Date.now() - t).toBeLessThan(2000);
    const byCol = new Map<number, number[]>();
    for (const k of Object.keys(p)) byCol.set(p[k].x, [...(byCol.get(p[k].x) ?? []), p[k].y].sort((a, b) => a - b));
    for (const ys of byCol.values()) for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(150);
  });
});

describe('looksMessy', () => {
  it('detecta blocos empilhados e aceita fluxo arrumado', () => {
    expect(looksMessy(Array.from({ length: 10 }, () => ({ position: { x: 100, y: 100 } })))).toBe(true);
    const tidy = Array.from({ length: 10 }, (_, i) => ({ position: { x: i * 340, y: 60 } }));
    expect(looksMessy(tidy)).toBe(false);
  });
});
