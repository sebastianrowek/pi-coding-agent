/**
 * Regression test: when Anthropic OAuth automatic token refresh is blocked by a
 * corporate proxy (e.g. Zscaler), pi should fall back to prompting the user for a
 * manual curl exchange instead of failing with a generic "No API key" error.
 */

import { describe, it } from "vitest";

describe.skip("regression: anthropic oauth refresh blocked by proxy", () => {
	it.todo("setRefreshCallbacks API not yet implemented on AuthStorage");
});
