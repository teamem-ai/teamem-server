// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // Vendored M2 web-UI design reference (static HTML/CSS/JS mockups + data
      // exports) — not product source; must not be subject to the server's
      // TypeScript ESLint rules. See docs/ui-design/DESIGN.md.
      'docs/ui-design/**',
    ],
  },
  ...tseslint.configs.recommended,
);
