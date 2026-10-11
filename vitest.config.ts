import { configDefaults, defineConfig } from "vitest/config";

// Playwright specs (tests/browser, #154) run with `pnpm test:browser`, not vitest; agent worktrees hold copies of the tests.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".claude/**", ".codex/**", "tests/browser/**"] }
});
