import { readFileSync } from "node:fs";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";

export const kernelMaterializers = [
	"materializeInstructionOperands",
	"materializeInstructionResults",
	"materializeTerminatorEdge",
] as const;
export type KernelMaterializer = (typeof kernelMaterializers)[number];

export function kernelMaterializerSource(
	names: ReadonlyArray<KernelMaterializer>,
): string {
	const kernel = readFileSync("src/compiler/core/core-function-kernel.ts", "utf8");
	const functions = names.map((name) => {
		const filename =
			name === "materializeTerminatorEdge"
				? "src/compiler/core/core-ir-control-flow.ts"
				: "src/compiler/core/core-cross-call-transforms.ts";
		const source = readFileSync(filename, "utf8");
		const start = source.indexOf(`function ${name}(`);
		if (start < 0) throw new Error(`Missing materializer ${name}`);
		const tail = source.slice(start + 1).search(/\n(?:export )?function /);
		return source.slice(start, tail < 0 ? undefined : start + 1 + tail);
	});
	return stripCompactTypes(`${kernel}\n${functions.join("\n")}`);
}
