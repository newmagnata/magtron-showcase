CREATE TABLE flow_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);
CREATE TABLE connection_flows (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('welcome','default','finished','ended')),
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  PRIMARY KEY (connection_id, slot)
);
INSERT INTO connection_flows (connection_id, slot, flow_id)
  SELECT id, 'welcome', default_flow_id FROM connections WHERE default_flow_id IS NOT NULL;
CREATE TABLE connection_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, keyword)
);
CREATE TABLE tracking_pixels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('tiktok','kwai','google','meta')),
  pixel_code text NOT NULL,
  secret text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tracking_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('tiktok','kwai','google','meta')),
  pixel_id uuid REFERENCES tracking_pixels(id) ON DELETE SET NULL,
  slug text NOT NULL UNIQUE,
  message text NOT NULL,
  distribution jsonb NOT NULL DEFAULT '[]',
  fallback text NOT NULL DEFAULT 'random' CHECK (fallback IN ('random','none')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tracking_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES tracking_links(id) ON DELETE CASCADE,
  code text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracking_clicks_code_idx ON tracking_clicks (code) WHERE contact_id IS NULL;
CREATE TABLE mcp_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
