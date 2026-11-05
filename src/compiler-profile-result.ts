import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { artifactFileDigest } from "./artifact-store.ts";
import type { BuildCommandResult } from "./cli-commands.ts";
import { PreparedProfile } from "./profile-artifact.ts";

export type CompilerResultMessage = Omit<BuildCommandResult, "profile"> & {
	profileArtifact?: {
		bytes: number;
		sha256: string;
		buildId: string;
		captureIdentity: string;
	};
};

/** Snapshot profiling data in the caller's directory before the worker can rebuild it. */
export function publishCompilerResult(
	value: BuildCommandResult,
	directory: string,
): CompilerResultMessage {
	const { profile, ...result } = value;
	if (profile === undefined) return result;
	if (value.binaryPath === undefined)
		throw new Error("profile metadata has no compiled binary");
	const file = join(directory, "profile.json");
	profile.writeMetadata(file);
	return {
		...result,
		profileArtifact: {
			bytes: statSync(file).size,
			sha256: artifactFileDigest(file),
			buildId: profile.buildId,
			captureIdentity: profile.captureIdentity,
		},
	};
}

/** Materialize the verified snapshot while the caller still owns its handoff directory. */
export function restoreCompilerResult(
	value: CompilerResultMessage,
	directory: string,
): BuildCommandResult {
	const { profileArtifact, ...result } = value;
	if (profileArtifact === undefined) return result;
	const file = join(directory, "profile.json");
	if (
		statSync(file).size !== profileArtifact.bytes ||
		artifactFileDigest(file) !== profileArtifact.sha256
	)
		throw new Error("compiler profile metadata does not match its published bytes");
	const profile = PreparedProfile.fromJson(readFileSync(file, "utf8"));
	if (
		profile.buildId !== profileArtifact.buildId ||
		profile.captureIdentity !== profileArtifact.captureIdentity
	)
		throw new Error("compiler profile metadata does not match its prepared identity");
	return { ...result, profile };
}
