type BillingMode = 'subscription' | 'credits';

/**
 * Resolve a RouteShift-funded credential. Platform keys are credits-only by
 * contract; making billing mode mandatory prevents a future BYOK call site
 * from accidentally reintroducing a platform-key fallback.
 */
export function getPlatformKey(provider: string, billingMode: BillingMode): string | undefined {
  if (billingMode !== 'credits') return undefined;

  switch (provider) {
    case 'openai': return process.env.OPENAI_API_KEY;
    case 'anthropic': return process.env.ANTHROPIC_API_KEY;
    case 'google': return process.env.GOOGLE_API_KEY;
    case 'together': return process.env.TOGETHER_API_KEY;
    case 'groq': return process.env.GROQ_API_KEY;
    case 'cloudflare-workers-ai': {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      return accountId && /^[0-9a-f]{32}$/.test(accountId)
        ? process.env.CLOUDFLARE_WORKERS_AI_TOKEN
        : undefined;
    }
    case 'neuralwatt': return process.env.NEURALWATT_API_KEY;
    default: return undefined;
  }
}
