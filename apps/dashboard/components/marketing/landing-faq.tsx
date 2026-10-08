import { ChevronRight } from 'lucide-react';
import { PUBLIC_PROXY_BASE_URL } from '@/lib/public-urls';

const PUBLIC_SDK_BASE_URL = `${PUBLIC_PROXY_BASE_URL}/v1`;
export const LANDING_FAQ_ITEMS = [
  {
    question: 'Can I use my existing OpenAI-compatible client?',
    answer:
      `Yes. Set the OpenAI SDK base URL to ${PUBLIC_SDK_BASE_URL}; the OpenAI-compatible chat completions endpoint is /v1/chat/completions. Keep the request and response flow your application already uses, then add a scoped RouteShift key and apply policy from the dashboard.`,
  },
  {
    question: 'How are savings measured?',
    answer:
      'Savings are measured per request by comparing the cost of the route selected by your policy with the documented baseline for the request. The savings-share fee applies only to positive measured savings; if routing saves you nothing in a period, the share is zero.',
  },
  {
    question: 'What is the difference between BYOK and credits?',
    answer:
      'BYOK means you bring provider credentials and provider spend remains separate from RouteShift’s savings-share formula. Credits mode supplies provider credentials through RouteShift and is billed separately, with the applicable credits markup.',
  },
  {
    question: 'How do budgets and guardrails work?',
    answer:
      'Daily, weekly, and monthly budgets alert or enforce according to the configured action at team, person, and API-key scopes. Allowlists and data-policy requirements are evaluated before dispatch according to their configuration. Prompt guardrails run as pre-dispatch checks when configured and available; inspect the resulting reason codes to see how a policy applied.',
  },
  {
    question: 'What security and data-policy controls are available?',
    answer:
      'RouteShift uses encrypted transport, encrypted API-key storage, role-based access controls, provider and model allowlists, and residency or zero-data-retention requirements where the selected endpoint supports them. See the privacy policy for the data-handling details.',
  },
  {
    question: 'Which tools are supported today?',
    answer:
      'The Connect CLI auto-configures opencode, Continue/Cline, and aider for the current OpenAI-compatible surface. Cursor setup is guided. Claude Code support is pending the Anthropic /v1/messages surface. Agents can also read the MCP catalog, and the typed SDK covers chat, streaming, and embeddings.',
  },
  {
    question: 'How is RouteShift different from OpenRouter?',
    answer:
      'OpenRouter focuses on broad model access. RouteShift focuses on policy-based routing, budgets, response caching, fallback chains, and savings evidence through an OpenAI-compatible endpoint. RouteShift’s public pricing is tied to positive measured savings rather than unqualified traffic volume.',
  },
  {
    question: 'What do the error codes mean?',
    answer:
      'Every rejection carries an exact machine-readable code. 402 means a budget cap was hit (the response includes reset_at); 429 means rate, TPM, or throttle limits (includes retry_after). 503 Budget service unavailable means the budget ledger could not admit the request, and 503 budget_estimate_unavailable means a hard cap could not be priced so the request failed closed rather than admitting unbilled traffic. Preset-bound keys return 403 key_preset_model_mismatch when routing escapes the pinned model, 403 key_preset_unavailable when the binding stops resolving, and 400 key_preset_conflict for request-level preset or models[] overrides. Plugin misuse returns 400 invalid_plugin, and a required plugin that fails returns 502 plugin_required_failed — other failures from optional plugins are skipped with the reason preserved.',
  },
  ];

export function LandingFaq() {
  return (
    <section id="faq" aria-labelledby="landing-faq-heading" className="scroll-mt-16 border-b border-white/[0.04] py-20 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <div className="text-center">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">FAQ</p>
          <h2 id="landing-faq-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
            Clear answers before you route.
          </h2>
        </div>
        <div className="mt-10 space-y-3">
          {LANDING_FAQ_ITEMS.map((item) => (
            <details key={item.question} className="faq-details group rounded-xl border border-white/[0.08] bg-white/[0.02]">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-left sm:px-5">
                <span className="text-base font-semibold text-white">{item.question}</span>
                <ChevronRight className="faq-chevron h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
              </summary>
              <div className="faq-answer border-t border-white/[0.05] px-4 pb-5 pt-4 sm:px-5">
                <p className="text-sm leading-relaxed text-zinc-400">{item.answer}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
