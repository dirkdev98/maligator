import { runConstantsMacro } from "./constants.mts";
import { runEmissionIoMacro } from "./emission-io.mts";
import { runEmissionMacro } from "./emission.mts";
import { runFlowMacro } from "./flow.mts";

const iterations = Number(process.argv[2] ?? 1);
const image = process.argv[3]!;
const mode = process.argv[4];
const result =
	mode === "flow"
		? runFlowMacro(iterations)
		: mode === "constants"
			? runConstantsMacro(iterations, image)
			: mode === "emission"
				? runEmissionMacro(iterations, image)
				: mode === "emission-io"
					? runEmissionIoMacro(iterations, image)
					: undefined;
if (result === undefined)
	throw new Error("expected flow, constants, emission, or emission-io");
console.log(JSON.stringify(result));
