export const ACTIVITY_CATEGORIES = [
  'coding',
  'debugging',
  'feature_dev',
  'refactoring',
  'testing',
  'exploration',
  'planning',
  'delegation',
  'git_ops',
  'build_deploy',
  'brainstorming',
  'conversation',
  'general',
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

const LABELS: Record<ActivityCategory, string> = {
  coding: 'Coding',
  debugging: 'Debugging',
  feature_dev: 'Feature dev',
  refactoring: 'Refactoring',
  testing: 'Testing',
  exploration: 'Exploration',
  planning: 'Planning',
  delegation: 'Delegation',
  git_ops: 'Git ops',
  build_deploy: 'Build / deploy',
  brainstorming: 'Brainstorming',
  conversation: 'Conversation',
  general: 'General',
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return 'Uncategorized';
  return LABELS[category as ActivityCategory] ?? category;
}

const HUES: Record<ActivityCategory, string> = {
  coding: 'bg-emerald-500',
  debugging: 'bg-red-500',
  feature_dev: 'bg-cyan-500',
  refactoring: 'bg-purple-500',
  testing: 'bg-amber-500',
  exploration: 'bg-blue-500',
  planning: 'bg-pink-500',
  delegation: 'bg-fuchsia-500',
  git_ops: 'bg-orange-500',
  build_deploy: 'bg-indigo-500',
  brainstorming: 'bg-violet-500',
  conversation: 'bg-teal-500',
  general: 'bg-neutral-500',
};

export function categoryColor(category: string | null | undefined): string {
  if (!category) return 'bg-neutral-700';
  return HUES[category as ActivityCategory] ?? 'bg-neutral-500';
}
