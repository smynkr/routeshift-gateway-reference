export interface SemanticCategory {
  tag: string;
  keywords: readonly string[];
}

// RSH-73: temporary built-in examples so semantic pre-routing tags are usable
// before admin-authored category storage/UI exists. Keep this intentionally
// small; real category definitions are expected to become configurable later.
export const DEFAULT_SEMANTIC_CATEGORIES: readonly SemanticCategory[] = [
  {
    tag: 'coding',
    keywords: ['code', 'debug', 'function', 'javascript', 'typescript', 'unit test'],
  },
] as const;

export function classifyPromptTags(prompt: string, categories: readonly SemanticCategory[]): string[] {
  const normalizedPrompt = prompt.toLowerCase();
  if (!normalizedPrompt) return [];

  const tags = new Set<string>();
  for (const category of categories) {
    const tag = category.tag.trim();
    if (!tag) continue;

    for (const keyword of category.keywords) {
      const normalizedKeyword = keyword.trim().toLowerCase();
      if (!normalizedKeyword) continue;
      if (normalizedPrompt.includes(normalizedKeyword)) {
        tags.add(tag);
        break;
      }
    }
  }

  return [...tags];
}
