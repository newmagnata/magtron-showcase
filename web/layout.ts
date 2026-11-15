/** Organização automática do canvas: colunas da esquerda para a direita, cada bloco perto do bloco que o chama. */
export type LNode = { id: string; type?: string; height?: number };
export type LEdge = { source: string; target: string };
export type Pos = { x: number; y: number };

export const NODE_W = 224;
const COL_GAP = 120;
const ROW_GAP = 36;
const GROUP_GAP = 90;

/** Altura aproximada do cartão (cabeçalho + contadores + resumo + uma linha por saída). */
export const estimateHeight = (type: string | undefined, outputs: number) => (type === 'start' ? 92 : 148) + Math.max(0, outputs - 1) * 20;

export function autoLayout(nodes: LNode[], edges: LEdge[], origin: Pos = { x: 60, y: 60 }): Record<string, Pos> {
  const ids = new Set(nodes.map((n) => n.id));
  const valid = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const out = new Map<string, string[]>(); const inn = new Map<string, string[]>();
  for (const n of nodes) { out.set(n.id, []); inn.set(n.id, []); }
  for (const e of valid) { out.get(e.source)!.push(e.target); inn.get(e.target)!.push(e.source); }

  // 1) Remove ciclos (arestas que voltam) com uma busca em profundidade a partir do início.
  const roots = [...nodes.filter((n) => n.type === 'start'), ...nodes.filter((n) => n.type !== 'start' && inn.get(n.id)!.length === 0)];
  const state = new Map<string, 1 | 2>(); const forward = new Map<string, string[]>(); for (const n of nodes) forward.set(n.id, []);
  const dfs = (root: string) => {
    const stack: [string, number][] = [[root, 0]]; state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]; const [id, i] = top; const next = out.get(id)![i];
      if (next === undefined) { state.set(id, 2); stack.pop(); continue; }
      top[1]++;
      if (state.get(next) === 1) continue; // volta para um bloco anterior: ignora no cálculo das colunas
      forward.get(id)!.push(next);
      if (!state.has(next)) { state.set(next, 1); stack.push([next, 0]); }
    }
  };
  for (const r of roots) if (!state.has(r.id)) dfs(r.id);
  for (const n of nodes) if (!state.has(n.id)) dfs(n.id);

  // 2) Coluna = caminho mais longo desde o início (ordem topológica de Kahn).
  const indeg = new Map<string, number>(); for (const n of nodes) indeg.set(n.id, 0);
  for (const [, ts] of forward) for (const t of ts) indeg.set(t, indeg.get(t)! + 1);
  const layer = new Map<string, number>(); const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  const preds = new Map<string, string[]>(); for (const n of nodes) preds.set(n.id, []);
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    for (const t of forward.get(id)!) {
      preds.get(t)!.push(id);
      layer.set(t, Math.max(layer.get(t) ?? 0, layer.get(id)! + 1));
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }

  // 3) Dentro da coluna, cada bloco fica na altura média dos blocos que chegam nele; o que sobrepõe desce.
  const height = new Map(nodes.map((n) => [n.id, n.height ?? 150]));
  const cols: string[][] = [];
  for (const n of nodes) { const l = layer.get(n.id) ?? 0; (cols[l] ??= []).push(n.id); }
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const y = new Map<string, number>(); const pos: Record<string, Pos> = {};
  cols.forEach((col, c) => {
    if (!col) return;
    const want = new Map<string, number>();
    for (const id of col) {
      const ps = preds.get(id)!;
      want.set(id, ps.length ? ps.reduce((s, p) => s + (y.get(p) ?? 0), 0) / ps.length : (c === 0 ? 0 : Number.MAX_SAFE_INTEGER));
    }
    col.sort((a, b) => want.get(a)! - want.get(b)! || index.get(a)! - index.get(b)!);
    let cursor = origin.y; let lastParent = '';
    for (const id of col) {
      const ps = preds.get(id)!; const parent = ps[0] ?? '';
      const w = want.get(id)!; const desired = w === Number.MAX_SAFE_INTEGER ? cursor : w;
      const gap = parent && parent !== lastParent && lastParent ? GROUP_GAP : ROW_GAP;
      const top = Math.max(desired, cursor === origin.y ? origin.y : cursor + (gap - ROW_GAP));
      y.set(id, top); cursor = top + height.get(id)! + ROW_GAP; lastParent = parent || lastParent;
      pos[id] = { x: origin.x + c * (NODE_W + COL_GAP), y: top };
    }
  });
  return pos;
}

/** Muitos blocos uns sobre os outros (ou todos na mesma posição) = fluxo que precisa ser arrumado. */
export function looksMessy(nodes: { position: Pos; height?: number }[]): boolean {
  if (nodes.length < 4) return false;
  let hit = 0;
  const sorted = [...nodes].sort((a, b) => a.position.x - b.position.x);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].position.x - sorted[i].position.x < NODE_W; j++) {
      const h = sorted[i].height ?? 150;
      if (Math.abs(sorted[j].position.y - sorted[i].position.y) < h) { hit++; break; }
    }
  }
  return hit / nodes.length > 0.15;
}
