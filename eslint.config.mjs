import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'spikes/**', 'src/renderer/public/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Security invariant helpers — these catch the patterns SECURITY.md bans.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // electron-builder loads its hooks with require(); a .cjs file is the point.
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // MISTAKES.md M-022: Electron on Windows is a GUI-subsystem binary, so
    // main-process stdout goes nowhere. A console.* call here is equivalent to
    // deleting the message - two recordings died and left a one-line log file.
    // src/main/log.ts is the only place allowed to touch the console.
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/log.ts'],
    rules: { 'no-console': 'error' },
  },
)
