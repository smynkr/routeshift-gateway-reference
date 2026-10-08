'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Key,
  Shield,
  Check,
  X,
  Loader2,
  Trash2,
  FlaskConical,
  Save,
  Eye,
  EyeOff,
} from 'lucide-react';
import { ProviderLoadBalancing } from './provider-load-balancing';

interface KeyInfo {
  label: string;
  weight: number;
  enabled: boolean;
  updated_at: string;
  metadata: Record<string, unknown>;
}

interface ProviderStatus {
  provider: string;
  configured: boolean;
  updated_at: string | null;
  metadata?: Record<string, string>;
  // LAY-326: full keys list and per-(team, provider) strategy. Older
  // components ignore these fields; the LB disclosure consumes them.
  keys?: KeyInfo[];
  strategy?: 'weighted_round_robin' | 'latency_based' | 'least_busy';
}

// not-a-provider-allowlist — UI display order; sync enforced by
// tests/provider-list-sync.test.ts (ids must equal shared PROVIDERS)
const PROVIDER_DISPLAY = [
  { id: 'openai', name: 'OpenAI', color: 'emerald' },
  { id: 'anthropic', name: 'Anthropic', color: 'orange' },
  { id: 'google', name: 'Google', color: 'blue' },
  { id: 'together', name: 'Together', color: 'violet' },
  { id: 'groq', name: 'Groq', color: 'cyan' },
  { id: 'zai', name: 'Z.ai (Zhipu GLM)', color: 'pink' },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', color: 'orange' },
  { id: 'neuralwatt', name: 'NeuralWatt', color: 'slate' },
  { id: 'xiaomi', name: 'Xiaomi MiMo', color: 'rose' },
  { id: 'minimax', name: 'MiniMax', color: 'amber' },
  { id: 'moonshot', name: 'Moonshot (Kimi)', color: 'sky' },
  { id: 'qwen', name: 'Alibaba Qwen', color: 'teal' },
  { id: 'azure', name: 'Azure OpenAI', color: 'indigo' },
  { id: 'bedrock', name: 'Amazon Bedrock', color: 'yellow' },
  { id: 'xai', name: 'xAI (Grok)', color: 'slate', comingSoon: true },
  { id: 'deepseek', name: 'DeepSeek', color: 'purple', comingSoon: true },
  { id: 'mistral', name: 'Mistral', color: 'red', comingSoon: true },
  { id: 'meta', name: 'Meta (Llama)', color: 'lime', comingSoon: true },
] as const;

interface MetaFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  default?: string;
}

const PROVIDER_META_FIELDS: Record<string, MetaFieldSpec[]> = {
  'cloudflare-workers-ai': [
    { key: 'account_id', label: 'Cloudflare account ID', placeholder: '32 lowercase hexadecimal characters' },
  ],
  azure: [
    { key: 'endpoint_url', label: 'Endpoint URL', placeholder: 'https://<resource>.cognitiveservices.azure.com/openai/v1/' },
    { key: 'deployment_name', label: 'Deployment name', placeholder: 'e.g. gpt55' },
    { key: 'resource_name', label: 'Resource name (classic)', placeholder: 'e.g. myorg-eastus' },
    { key: 'api_version', label: 'API version (classic)', default: '2024-10-21' },
  ],
  bedrock: [
    { key: 'access_key_id', label: 'AWS access key ID', placeholder: 'AKIA…' },
    { key: 'region', label: 'AWS region', default: 'us-east-1' },
  ],
};

// Record keyed by the PROVIDER_DISPLAY color union: a display color missing
// here is a COMPILE error, not a settings-page render crash (kimi, round 4).
const COLOR_MAP: Record<(typeof PROVIDER_DISPLAY)[number]['color'], { badge: string; icon: string }> = {
  emerald: { badge: 'bg-emerald-500/10 text-emerald-400', icon: 'text-emerald-400' },
  orange: { badge: 'bg-orange-500/10 text-orange-400', icon: 'text-orange-400' },
  blue: { badge: 'bg-blue-500/10 text-blue-400', icon: 'text-blue-400' },
  violet: { badge: 'bg-violet-500/10 text-violet-400', icon: 'text-violet-400' },
  cyan: { badge: 'bg-cyan-500/10 text-cyan-400', icon: 'text-cyan-400' },
  pink: { badge: 'bg-pink-500/10 text-pink-400', icon: 'text-pink-400' },
  rose: { badge: 'bg-rose-500/10 text-rose-400', icon: 'text-rose-400' },
  amber: { badge: 'bg-amber-500/10 text-amber-400', icon: 'text-amber-400' },
  sky: { badge: 'bg-sky-500/10 text-sky-400', icon: 'text-sky-400' },
  teal: { badge: 'bg-teal-500/10 text-teal-400', icon: 'text-teal-400' },
  indigo: { badge: 'bg-indigo-500/10 text-indigo-400', icon: 'text-indigo-400' },
  yellow: { badge: 'bg-yellow-500/10 text-yellow-400', icon: 'text-yellow-400' },
  slate: { badge: 'bg-slate-500/10 text-slate-400', icon: 'text-slate-400' },
  purple: { badge: 'bg-purple-500/10 text-purple-400', icon: 'text-purple-400' },
  red: { badge: 'bg-red-500/10 text-red-400', icon: 'text-red-400' },
  lime: { badge: 'bg-lime-500/10 text-lime-400', icon: 'text-lime-400' },
};

type TestResult = { valid: boolean; error?: string } | null;

export function ProviderKeysSection() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [metaInputs, setMetaInputs] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/provider-keys');
      if (res.ok) {
        setStatuses(await res.json());
        setLoadError(null);
      } else {
        setLoadError('Could not load provider key statuses.');
      }
    } catch {
      setLoadError('Network error loading provider keys.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatuses();
  }, [fetchStatuses]);

  function getStatus(provider: string): ProviderStatus | undefined {
    return statuses.find((s) => s.provider === provider);
  }

  function buildMetadata(provider: string): Record<string, string> | null {
    const spec = PROVIDER_META_FIELDS[provider];
    if (!spec) return null;
    const meta = metaInputs[provider] ?? {};
    const result: Record<string, string> = {};
    for (const field of spec) {
      const value = (meta[field.key] ?? '').trim() || field.default || '';
      if (value) {
        result[field.key] = value;
      }
    }

    if (provider === 'azure') {
      if (result.endpoint_url) return result;
      if (result.resource_name && result.api_version) return result;
      return null;
    }

    for (const field of spec) {
      if (!result[field.key]) return null;
    }
    return result;
  }

  async function handleSave(provider: string) {
    const key = keyInputs[provider]?.trim();
    if (!key) return;
    const metadata = buildMetadata(provider);
    if (PROVIDER_META_FIELDS[provider] && !metadata) {
      const required = provider === 'azure'
        ? 'Endpoint URL, or Resource name + API version'
        : PROVIDER_META_FIELDS[provider].filter((f) => !f.default).map((f) => f.label).join(', ');
      setErrors((p) => ({ ...p, [provider]: `Missing required field${required.includes(',') ? 's' : ''}: ${required}` }));
      return;
    }

    setSaving((p) => ({ ...p, [provider]: true }));
    setErrors((p) => ({ ...p, [provider]: '' }));
    setTestResults((p) => ({ ...p, [provider]: null }));

    try {
      const res = await fetch(`/api/provider-keys/${provider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata ? { key, metadata } : { key }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setErrors((p) => ({ ...p, [provider]: data.error?.message ?? 'Failed to save key' }));
        return;
      }

      setKeyInputs((p) => ({ ...p, [provider]: '' }));
      if (data.proxy_cache_invalidated === false) {
        setErrors((p) => ({
          ...p,
          [provider]: `Key saved, but proxy cache may use the previous key for up to ${data.cache_ttl_seconds ?? 300} seconds.`,
        }));
      }
      await fetchStatuses();
    } catch {
      setErrors((p) => ({ ...p, [provider]: 'Network error' }));
    } finally {
      setSaving((p) => ({ ...p, [provider]: false }));
    }
  }

  async function handleTest(provider: string) {
    const key = keyInputs[provider]?.trim();
    if (!key) return;
    const metadata = buildMetadata(provider);
    if (PROVIDER_META_FIELDS[provider] && !metadata) {
      const required = provider === 'azure'
        ? 'Endpoint URL, or Resource name + API version'
        : PROVIDER_META_FIELDS[provider].filter((f) => !f.default).map((f) => f.label).join(', ');
      setErrors((p) => ({ ...p, [provider]: `Missing required field${required.includes(',') ? 's' : ''}: ${required}` }));
      return;
    }

    setTesting((p) => ({ ...p, [provider]: true }));
    setTestResults((p) => ({ ...p, [provider]: null }));
    setErrors((p) => ({ ...p, [provider]: '' }));

    try {
      const res = await fetch(`/api/provider-keys/${provider}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata ? { key, metadata } : { key }),
      });

      const data = await res.json();
      setTestResults((p) => ({ ...p, [provider]: data }));
    } catch {
      setTestResults((p) => ({ ...p, [provider]: { valid: false, error: 'Network error' } }));
    } finally {
      setTesting((p) => ({ ...p, [provider]: false }));
    }
  }

  async function handleRemove(provider: string) {
    setRemoving((p) => ({ ...p, [provider]: true }));
    setErrors((p) => ({ ...p, [provider]: '' }));

    try {
      const res = await fetch(`/api/provider-keys/${provider}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setErrors((p) => ({ ...p, [provider]: data.error?.message ?? 'Failed to remove key' }));
        return;
      }

      setTestResults((p) => ({ ...p, [provider]: null }));
      if (data.proxy_cache_invalidated === false) {
        setErrors((p) => ({
          ...p,
          [provider]: `Key removed, but proxy cache may use it for up to ${data.cache_ttl_seconds ?? 300} seconds.`,
        }));
      }
      await fetchStatuses();
    } catch {
      setErrors((p) => ({ ...p, [provider]: 'Network error' }));
    } finally {
      setRemoving((p) => ({ ...p, [provider]: false }));
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-base font-semibold text-white">Provider API Keys</h3>
        </div>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className="border-b border-white/[0.06] px-6 py-4">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-neutral-400" />
          <h3 className="text-base font-semibold text-white">Provider API Keys</h3>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          Add your own provider keys for subscription billing mode.
        </p>
        {loadError && (
          <p className="mt-2 text-xs text-red-400">{loadError}</p>
        )}
      </div>
      <div className="divide-y divide-white/[0.06]">
        {PROVIDER_DISPLAY.map(({ id, name, color, ...rest }) => {
          const comingSoon = 'comingSoon' in rest && rest.comingSoon === true;
          const status = getStatus(id);
          const configured = status?.configured ?? false;
          const colors = COLOR_MAP[color];
          const keyValue = keyInputs[id] ?? '';
          const isSaving = saving[id] ?? false;
          const isTesting = testing[id] ?? false;
          const isRemoving = removing[id] ?? false;
          const testResult = testResults[id] ?? null;
          const error = errors[id] ?? '';
          const busy = isSaving || isTesting || isRemoving;

          return (
            <div key={id} className="px-6 py-4 space-y-3">
              {/* Header row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${colors.badge}`}>
                    {name}
                  </span>
                  {comingSoon && (
                    <span className="rounded-md border border-white/[0.08] px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500">
                      Routing coming soon
                    </span>
                  )}
                  {configured ? (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                      <Shield className="h-3 w-3" />
                      Configured
                    </span>
                  ) : (
                    <span className="text-xs text-neutral-500">Not set</span>
                  )}
                </div>
                {configured && (
                  <button
                    onClick={() => handleRemove(id)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                  >
                    {isRemoving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    Remove
                  </button>
                )}
              </div>

              {/* Provider-specific structured config (e.g. Azure resource_name +
                  api_version, Bedrock access_key_id + region). Shown for both saved
                  and unsaved states — these aren't secrets, so the user gets to see
                  what's currently configured. */}
              {PROVIDER_META_FIELDS[id] && (
                <div className="grid grid-cols-2 gap-2">
                  {PROVIDER_META_FIELDS[id].map((field) => (
                    <div key={field.key} className="space-y-1">
                      <label className="text-[11px] uppercase tracking-wide text-neutral-500">{field.label}</label>
                      <input
                        type="text"
                        value={
                          metaInputs[id]?.[field.key] ??
                          (status?.metadata?.[field.key] as string | undefined) ??
                          field.default ??
                          ''
                        }
                        onChange={(e) =>
                          setMetaInputs((p) => ({
                            ...p,
                            [id]: { ...(p[id] ?? {}), [field.key]: e.target.value },
                          }))
                        }
                        placeholder={field.placeholder ?? field.default ?? ''}
                        className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 font-mono text-xs text-neutral-300 placeholder:text-neutral-600 focus:border-emerald-500/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/20"
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Key input & actions */}
              {configured ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 font-mono text-sm text-neutral-500">
                    {'••••••••••••••••••••••••'}
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type={revealed[id] ? 'text' : 'password'}
                        value={keyValue}
                        onChange={(e) =>
                          setKeyInputs((p) => ({ ...p, [id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !busy && keyValue.trim()) {
                            e.preventDefault();
                            handleSave(id);
                          }
                        }}
                        placeholder={`Paste your ${name} API key`}
                        className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 pr-9 font-mono text-sm text-neutral-300 placeholder:text-neutral-600 focus:border-emerald-500/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/20"
                      />
                      <button
                        type="button"
                        onClick={() => setRevealed((p) => ({ ...p, [id]: !p[id] }))}
                        aria-label={revealed[id] ? 'Hide key' : 'Show key'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-500 transition-colors hover:text-neutral-300"
                      >
                        {revealed[id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {!comingSoon && (
                      <button
                        onClick={() => handleTest(id)}
                        disabled={busy || !keyValue.trim()}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs font-medium text-neutral-300 transition hover:bg-white/[0.06] disabled:opacity-40"
                      >
                        {isTesting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FlaskConical className="h-3.5 w-3.5" />
                        )}
                        Test
                      </button>
                    )}
                    <button
                      onClick={() => handleSave(id)}
                      disabled={busy || !keyValue.trim()}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-400 transition hover:bg-emerald-500/25 disabled:opacity-40"
                    >
                      {isSaving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      Save
                    </button>
                  </div>

                  {/* Test result */}
                  {testResult && (
                    <div
                      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
                        testResult.valid
                          ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                          : 'border border-red-500/20 bg-red-500/10 text-red-400'
                      }`}
                    >
                      {testResult.valid ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          Key is valid
                        </>
                      ) : (
                        <>
                          <X className="h-3.5 w-3.5" />
                          {testResult.error ?? 'Invalid key'}
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Error */}
              {error && (
                <p className="text-xs text-red-400">{error}</p>
              )}

              {/* LAY-326: Load Balancing disclosure (lists labeled keys, strategy
                  selector, add-key form). Hidden when no keys exist; degrades to
                  a tiny chevron when only the default key is present. */}
              {configured && status?.keys && status.keys.length > 0 && (
                <ProviderLoadBalancing
                  provider={id}
                  keys={status.keys.map((k) => ({
                    ...k,
                    updated_at: typeof k.updated_at === 'string' ? k.updated_at : new Date(k.updated_at as unknown as string).toISOString(),
                  }))}
                  strategy={status.strategy ?? 'weighted_round_robin'}
                  onMutate={fetchStatuses}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
