CREATE TABLE IF NOT EXISTS pricing_entries (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_price NUMERIC(10,4) NOT NULL,
  output_price NUMERIC(10,4) NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_lookup
ON pricing_entries(provider, model, effective_from);

-- Seed current pricing
INSERT INTO pricing_entries (id, provider, model, input_price, output_price, effective_from) VALUES
  ('p01', 'openai', 'gpt-5', 1.25, 10.0, '2025-01-01'),
  ('p02', 'openai', 'gpt-4.1', 2.0, 8.0, '2025-01-01'),
  ('p03', 'openai', 'gpt-4.1-mini', 0.4, 1.6, '2025-01-01'),
  ('p04', 'openai', 'gpt-4.1-nano', 0.1, 0.4, '2025-01-01'),
  ('p05', 'openai', 'o3', 2.0, 8.0, '2025-01-01'),
  ('p06', 'openai', 'o4-mini', 1.1, 4.4, '2025-01-01'),
  ('p07', 'anthropic', 'claude-opus-4-6', 5.0, 25.0, '2025-01-01'),
  ('p08', 'anthropic', 'claude-sonnet-4-6', 3.0, 15.0, '2025-01-01'),
  ('p09', 'anthropic', 'claude-haiku-4-5', 1.0, 5.0, '2025-01-01'),
  ('p10', 'google', 'gemini-2.5-pro', 1.25, 10.0, '2025-01-01'),
  ('p11', 'google', 'gemini-2.5-flash', 0.15, 0.6, '2025-01-01')
ON CONFLICT (id) DO NOTHING;
