import type { Db } from './db.js';

/** Registra atividade suspeita no banco e no console (uma linha JSON por evento, fácil de filtrar). Nunca derruba a requisição. */
export async function audit(db: Db, kind: string, o: { accountId?: string | null; ip?: string; detail?: Record<string, unknown> } = {}) {
  const detail = o.detail ?? {};
  console.warn(JSON.stringify({ security: kind, ip: o.ip, account: o.accountId ?? undefined, ...detail }));
  try {
    await db.query('INSERT INTO security_events (account_id, kind, ip, detail) VALUES ($1,$2,$3,$4::jsonb)', [o.accountId ?? null, kind, o.ip ?? null, JSON.stringify(detail)]);
    if (Math.random() < 0.01) await db.query(`DELETE FROM security_events WHERE created_at < now() - interval '90 days'`);
  } catch (e) { console.error('Falha ao registrar evento de segurança', e); }
}

/** Trava o login de um e-mail depois de várias senhas erradas seguidas (além do limite por IP). */
export class LoginGuard {
  private fails = new Map<string, { n: number; first: number; lockedUntil: number }>();
  constructor(private max = 8, private windowMs = 15 * 60_000) {}

  locked(key: string): number {
    const f = this.fails.get(key);
    return f && f.lockedUntil > Date.now() ? Math.ceil((f.lockedUntil - Date.now()) / 1000) : 0;
  }
  /** Devolve true no momento em que o e-mail acabou de ser travado. */
  fail(key: string): boolean {
    const now = Date.now();
    const f = this.fails.get(key);
    const cur = f && now - f.first < this.windowMs ? f : { n: 0, first: now, lockedUntil: 0 };
    cur.n++;
    const justLocked = cur.n >= this.max && cur.lockedUntil <= now;
    if (justLocked) cur.lockedUntil = now + this.windowMs;
    this.fails.set(key, cur);
    if (this.fails.size > 5000) for (const [k, v] of this.fails) if (now - v.first > this.windowMs) this.fails.delete(k);
    return justLocked;
  }
  ok(key: string) { this.fails.delete(key); }
}
