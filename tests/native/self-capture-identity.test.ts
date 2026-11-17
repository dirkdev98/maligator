import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/self-capture-identity.cjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-self-capture-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["conservative", "precise"] as const)(
	"%s self capture roots",
	(nativeStackRoots) => {
		let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
		beforeAll(() => {
			pair = buildBackendPairFromOneProgramImage({
				fixture,
				outDir,
				name: `self-capture-${nativeStackRoots}`,
				nativeStackRoots,
				config: resolveBuildConfig({
					engine: { eval: false, realms: false, primordials: "mutable" },
					surface: { node: true },
				}),
			});
			const byName = (name: string) =>
				pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
			expect(
				byName("f").body.instructions.some((op) => op.opcode === "LOAD_CALLEE"),
			).toBe(true);
			expect(
				byName("makeMapped").storage!.captures.copiedClosureIps.length,
			).toBeGreaterThan(0);
		});
		it.each([
			{
				scenario: "constructors",
				behavior: "preserves owning callee through bound, Proxy and Reflect construction",
			},
			{
				scenario: "identity",
				behavior: "preserves each self identity through direct, bound and Proxy calls",
			},
			{ scenario: "mutation", behavior: "keeps owner and sibling writes authoritative" },
			{
				scenario: "tdz",
				behavior: "keeps external temporal dead zones before self initialization",
			},
			{
				scenario: "arguments",
				behavior: "preserves empty-map arguments and owning callee in copied closures",
			},
		])("$behavior", ({ scenario }) => {
			const env = { SELF_CAPTURE_CASE: scenario };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary, { env })).toBe(expected);
				expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
			}
		});
	},
);
