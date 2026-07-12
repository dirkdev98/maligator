import tsBlankSpace from "ts-blank-space";

/** Node-hosted TypeScript blanking adapter used at disk-pipeline boundaries. */
export function stripTypesWithTypeScript(source: string, _filePath: string): string {
	return tsBlankSpace(source);
}
