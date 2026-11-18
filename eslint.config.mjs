import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/app/renderer/**/*.ts', 'src/features/**/*.component.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['node:*', 'electron', '**/platform/**', '**/main/**'],
      }],
    },
  },
  {
    files: ['src/features/**/domain.ts', 'src/shared/finance.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['node:*', 'electron', '@angular/*', '**/platform/**', '**/main/**'],
      }],
    },
  },
);
