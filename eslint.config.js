import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier'

export default tseslint.config([
  // `.claude/worktrees` is where subagent runs check out their own copy of
  // the repo. Every one of them is a full second tree, so without this a
  // single running agent multiplies every lint error by two and buries the
  // real ones — and the errors it reports are for files nobody is editing
  // here. Gitignored already; eslint does not read .gitignore.
  globalIgnores(['dist', '.claude']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // Playwright fixtures take a parameter literally named `use`, which
    // react-hooks/rules-of-hooks misreads as a React Hook call.
    files: ['e2e/**/*.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
])
