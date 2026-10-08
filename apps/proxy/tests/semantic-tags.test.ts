import { describe, expect, it } from 'vitest';
import { classifyPromptTags, type SemanticCategory } from '../src/routing/semantic-tags.js';

describe('classifyPromptTags', () => {
  const categories: SemanticCategory[] = [
    { tag: 'coding', keywords: ['debug', 'typescript'] },
    { tag: 'legal', keywords: ['contract'] },
  ];

  it('returns a category tag when the prompt matches one of its keywords', () => {
    expect(classifyPromptTags('Please debug this failing handler', categories)).toEqual(['coding']);
  });

  it('returns no tags when the prompt does not match any category keyword', () => {
    expect(classifyPromptTags('Summarize the launch notes', categories)).toEqual([]);
  });

  it('matches keywords case-insensitively', () => {
    expect(classifyPromptTags('Can you review this TypeScript module?', categories)).toEqual(['coding']);
  });
});
