import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishCompilerResult } from "../../../src/compiler-profile-result.ts";
import {
	PreparedProfile,
	profileCaptureIdentity,
} from "../../../src/profile-artifact.ts";
import type { ProfileMetadata } from "../../../src/profile-artifact.ts";

function makeMetadata(): ProfileMetadata {
	const functions = Array.from({ length: 512 }, (_, index) => ({
		name: `operation${index}_${"x".repeat(256)}`,
		file: "fictional.mjs",
		identity: { status: "unknown", reason: "no-source-origin" } as const,
	}));
	const profile: ProfileMetadata = {
		schema: 8,
		mode: "sampling",
		buildId: "b".repeat(64),
		entrypoint: "fictional.mjs",
		calls: [],
		functions,
		sites: [],
		remarks: [],
	};
	profile.captureIdentity = profileCaptureIdentity(profile);
	return profile;
}

export function raw(_context: unknown) {
	return makeMetadata();
}

export function produce(_context: unknown, directory: string) {
	const metadata = makeMetadata();
	const profile = PreparedProfile.fromMetadata(metadata);
	const binaryPath = join(directory, "application");
	profile.writeMetadata(`${binaryPath}.profile.json`);
	const value = publishCompilerResult(
		{ binaryPath, profile },
		join(directory, "handoff"),
	);
	writeFileSync(`${binaryPath}.profile.json`, "{}");
	return {
		value,
		count: metadata.functions.length,
		lastName: metadata.functions.at(-1)!.name,
	};
}
