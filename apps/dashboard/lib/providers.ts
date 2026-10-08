// Single source of truth for provider visual styling in the dashboard.
// Canonical provider list lives in @routeshift/shared.

// Keys are kept as plain strings (not Record<Provider, string>) so this file
// keeps typechecking when @routeshift/shared/dist hasn't been rebuilt locally
// — production builds rebuild dist before consuming it.
const PROVIDER_BADGE: Record<string, string> = {
  openai: 'bg-emerald-500/10 text-emerald-400',
  anthropic: 'bg-orange-500/10 text-orange-400',
  google: 'bg-blue-500/10 text-blue-400',
  together: 'bg-violet-500/10 text-violet-400',
  groq: 'bg-cyan-500/10 text-cyan-400',
  zai: 'bg-purple-500/10 text-purple-400',
  'cloudflare-workers-ai': 'bg-orange-600/10 text-orange-400',
  neuralwatt: 'bg-slate-500/10 text-slate-400',
  xiaomi: 'bg-sky-500/10 text-sky-400',
  minimax: 'bg-amber-500/10 text-amber-400',
  moonshot: 'bg-pink-500/10 text-pink-400',
  qwen: 'bg-indigo-500/10 text-indigo-400',
  azure: 'bg-blue-400/10 text-blue-300',
  bedrock: 'bg-orange-400/10 text-orange-300',
};

// Border-style variant used on the models page header badges.
const PROVIDER_BADGE_BORDERED: Record<string, string> = {
  openai: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  anthropic: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  google: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  together: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  groq: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  zai: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  'cloudflare-workers-ai': 'bg-orange-600/10 text-orange-400 border-orange-600/20',
  neuralwatt: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  xiaomi: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  minimax: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  moonshot: 'bg-pink-500/10 text-pink-400 border-pink-500/20',
  qwen: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  azure: 'bg-blue-400/10 text-blue-300 border-blue-400/20',
  bedrock: 'bg-orange-400/10 text-orange-300 border-orange-400/20',
};

// Hex for chart series (recharts doesn't take Tailwind classes).
const PROVIDER_HEX: Record<string, string> = {
  openai: '#10b981',
  anthropic: '#f97316',
  google: '#3b82f6',
  together: '#8b5cf6',
  groq: '#06b6d4',
  zai: '#a855f7',
  'cloudflare-workers-ai': '#ea580c',
  neuralwatt: '#64748b',
  xiaomi: '#0ea5e9',
  minimax: '#f59e0b',
  moonshot: '#ec4899',
  qwen: '#6366f1',
  azure: '#60a5fa',
  bedrock: '#fb923c',
};

// Proper-cased display names. The default `capitalize` would produce Openai,
// Minimax, etc. — keep this map for the small set of branded names.
const PROVIDER_DISPLAY_NAME: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  together: 'Together',
  groq: 'Groq',
  zai: 'Z.ai',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  neuralwatt: 'NeuralWatt',
  xiaomi: 'Xiaomi',
  minimax: 'MiniMax',
  moonshot: 'Moonshot',
  qwen: 'Qwen',
  azure: 'Azure',
  bedrock: 'Bedrock',
};

const FALLBACK_BADGE = 'bg-white/[0.06] text-zinc-400';
const FALLBACK_BADGE_BORDERED = 'bg-white/[0.06] text-zinc-400 border-white/[0.1]';
const FALLBACK_HEX = '#737373';

export function providerBadgeClass(provider: string): string {
  return PROVIDER_BADGE[provider] ?? FALLBACK_BADGE;
}

export function providerBorderedBadgeClass(provider: string): string {
  return PROVIDER_BADGE_BORDERED[provider] ?? FALLBACK_BADGE_BORDERED;
}

export function providerHex(provider: string): string {
  return PROVIDER_HEX[provider] ?? FALLBACK_HEX;
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAME[provider]
    ?? (provider.charAt(0).toUpperCase() + provider.slice(1));
}
