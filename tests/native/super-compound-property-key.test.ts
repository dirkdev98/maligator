import { beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

let binaries: ReturnType<typeof buildBackendPairFromOneProgramImage>;

beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/super-compound-property-key.mjs",
		name: "super-compound-property-key",
		evalEnabled: false,
	});
});

it.each(["compiled", "interpreted"] as const)(
	"reuses the converted symbol for the write to a computed super property (%s)",
	(backend) => {
		expect(runToStdout(binaries[backend])).toBe('[5,5,["string","get","rhs","set"]]\n');
	},
);
