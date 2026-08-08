import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cacheFrontendWire,
	frontendDigest,
	frontendWirePath,
} from "../src/frontend-cache.ts";

describe("shared frontend artifact cache", () => {
	it("publishes wire images by content and repairs corrupt artifacts", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-frontend-cache-"));
		const wire = Uint8Array.from([1, 2, 3, 4]);
		const expected = frontendWirePath(frontendDigest(wire), root);

		expect(cacheFrontendWire(wire, root)).toBe(expected);
		expect(cacheFrontendWire(wire, root)).toBe(expected);
		expect(new Uint8Array(readFileSync(expected))).toEqual(wire);

		writeFileSync(expected, Uint8Array.from([9]));
		expect(cacheFrontendWire(wire, root)).toBe(expected);
		expect(new Uint8Array(readFileSync(expected))).toEqual(wire);
	});
});
