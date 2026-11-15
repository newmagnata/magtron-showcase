-- Registro de atividades suspeitas (logins errados, bloqueios, rotas proibidas, uploads recusados...).
CREATE TABLE IF NOT EXISTS security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  ip text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_recent_idx ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_account_idx ON security_events (account_id, created_at DESC);
