import { hash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

export const FRONTEND_CACHE_DIRECTORY = ".cache/mal-cache/frontend";

export function frontendDigest(contents: string | Uint8Array): string {
	return hash("sha256", contents, "hex");
}

export function frontendWirePath(digest: string, root = FRONTEND_CACHE_DIRECTORY): string {
	return path.resolve(root, "artifacts", `${digest}.malw`);
}

function validArtifact(file: string, expectedDigest: string): boolean {
	try {
		return frontendDigest(new Uint8Array(readFileSync(file))) === expectedDigest;
	} catch {
		return false;
	}
}

/** Publish a VM image into the frontend-wide content-addressed artifact store. */
export function cacheFrontendWire(
	wire: Uint8Array,
	root = FRONTEND_CACHE_DIRECTORY,
): string {
	const digest = frontendDigest(wire);
	const file = frontendWirePath(digest, root);
	if (validArtifact(file, digest)) return file;

	const directory = path.dirname(file);
	mkdirSync(directory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
	const temporaryPath = path.join(temporaryDirectory, path.basename(file));
	try {
		writeFileSync(temporaryPath, wire);
		try {
			renameSync(temporaryPath, file);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" || !validArtifact(file, digest)) throw error;
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	if (!existsSync(file) || !validArtifact(file, digest)) {
		throw new Error(`frontend artifact publication failed: ${file}`);
	}
	return file;
}
