import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	MALIGATOR_CACHE_LAYOUT,
	maligatorCacheBaseDirectory,
	maligatorCacheDirectory,
} from "../src/cache-root.ts";

describe("Maligator user cache root", () => {
	it("uses an explicit override as the complete cache root", () => {
		expect(maligatorCacheDirectory("relative-cache")).toBe(
			path.resolve("relative-cache"),
		);
	});

	it("uses XDG_CACHE_HOME on Linux without a package-version partition", () => {
		expect(
			maligatorCacheDirectory(undefined, { XDG_CACHE_HOME: "/cache" }, "linux"),
		).toBe(path.join("/cache", "maligator", MALIGATOR_CACHE_LAYOUT));
	});

	it("lets MALIGATOR_CACHE_DIR replace the platform default", () => {
		expect(
			maligatorCacheDirectory(
				undefined,
				{ MALIGATOR_CACHE_DIR: "/shared/maligator" },
				"darwin",
			),
		).toBe(path.join("/shared/maligator", MALIGATOR_CACHE_LAYOUT));
		expect(
			maligatorCacheBaseDirectory({ MALIGATOR_CACHE_DIR: "/shared/maligator" }, "darwin"),
		).toBe("/shared/maligator");
	});
});
