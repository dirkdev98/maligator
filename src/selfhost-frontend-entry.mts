import { writeFileSync } from "node:fs";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { compileEntrypointToBuffer } from "./compiler/pipeline/compile-runtime-program.ts";
import { profilePhaseId } from "./profile-phases.ts";
import type { ProfilePhaseName } from "./profile-phases.ts";

interface ProfileRuntime {
	_profilePhaseBegin?: (phaseId: number) => void;
	_profilePhaseEnd?: (phaseId: number) => void;
}

const profileRuntime = (globalThis as typeof globalThis & { mal?: ProfileRuntime }).mal;
const profilePhaseBegin = profileRuntime?._profilePhaseBegin;
const profilePhaseEnd = profileRuntime?._profilePhaseEnd;

function runProfilePhase<T>(phase: ProfilePhaseName, run: () => T): T {
	if (profilePhaseBegin === undefined || profilePhaseEnd === undefined) return run();
	const id = profilePhaseId(phase);
	profilePhaseBegin(id);
	try {
		return run();
	} finally {
		profilePhaseEnd(id);
	}
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (inputPath === undefined || outputPath === undefined) {
	throw new Error("usage: selfhost-frontend <input> <output>");
}

const bytes = compileEntrypointToBuffer(inputPath, {
	stripTypes: stripCompactTypes,
	buildConfig: {
		entry: undefined,
		outputName: undefined,
		assets: {},
		modules: { aliases: {} },
		engine: {
			primordials: "locked",
			eval: false,
			realms: false,
			regexp: true,
			temporal: false,
			intl: { enabled: false, features: [], languages: [] },
		},
		host: { scheduler: "single" },
		surface: { webPlatform: false, node: true, maligator: true },
	},
	runPhase: runProfilePhase,
});
writeFileSync(outputPath, bytes);
