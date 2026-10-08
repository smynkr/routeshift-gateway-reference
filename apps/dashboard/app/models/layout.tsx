import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Supported Models — OpenAI, Claude, Gemini, GLM, Qwen & More',
  description:
    'Explore the RouteShift model catalog across OpenAI, Anthropic, Google, Z.ai, Qwen, Moonshot, MiniMax, and Xiaomi. Compare pricing, context windows, endpoint policy, and capabilities.',
  keywords: [
    'RouteShift supported models',
    'LLM proxy models',
    'GPT proxy',
    'Claude proxy',
    'Gemini proxy',
    'LLM API gateway models',
    'AI model comparison',
  ],
};

export default function ModelsLayout({ children }: { children: React.ReactNode }) {
  return children;
}

