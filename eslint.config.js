export default [
  {
    ignores: ['node_modules/**', 'dist/**']
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        document: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
        console: 'readonly'
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    },
    rules: {
      'semi': ['error', 'always'],
      'quotes': ['error', 'single'],
      'indent': ['error', 2],
      'no-unused-vars': 'warn'
    }
  }
];