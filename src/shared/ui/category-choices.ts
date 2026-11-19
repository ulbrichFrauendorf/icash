import type { Category } from '../../features/categories/contract';
import type { SuggestedCategory } from '../../features/openai/contract';

export function reviewCategoryChoices(categories: Category[], kind: SuggestedCategory['kind'], empty: string, suggestion?: SuggestedCategory) {
  const choices = [{ value: '', label: empty }];
  if (suggestion) choices.push({
    value: 'suggested',
    label: suggestion.id ? 'AI · ' + suggestion.label : 'Create expense category · ' + suggestion.label,
  });
  for (const category of categories) {
    if (!category.leaf || category.archived || category.kind !== kind) continue;
    const parent = categories.find((item) => item.id === category.parentId);
    choices.push({ value: category.id, label: parent ? parent.name + ' / ' + category.name : category.name });
  }
  return choices;
}
