export type Choice = { value: unknown; label: string };

export function rowChoices<T>(
  rows: readonly T[],
  value: keyof T | 'index',
  label: keyof T | 'index' | ((row: T) => string),
): Choice[] {
  return rows.map((row, index) => ({
    value: value === 'index' ? index : row[value as keyof T],
    label: typeof label === 'function' ? label(row) : label === 'index'
      ? (index + 1) + ' · ' + String(row) : String(row[label as keyof T]),
  }));
}

// ISelect is object-valued. Keep the model reference stable when the same options
// are projected again so NgModel does not schedule another model write each pass.
export function retainChoice() {
  const byValue = new Map<unknown, Map<string, Choice>>();
  return (choices: readonly Choice[], value: unknown): Choice | null => {
    const choice = choices.find((entry) => entry.value === value);
    if (!choice) return null;
    let byLabel = byValue.get(value);
    if (!byLabel) {
      byLabel = new Map();
      byValue.set(value, byLabel);
    }
    const retained = byLabel.get(choice.label);
    if (retained) return retained;
    byLabel.set(choice.label, choice);
    return choice;
  };
}
