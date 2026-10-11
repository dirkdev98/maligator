import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import * as path from "node:path";

export interface VerificationSource {
	revision: string | null;
	digest: string;
	dirty: boolean;
	files: number;
}

export function verificationSourceDigest(
	root: string,
	files: ReadonlyArray<string>,
): string {
	const digest = createHash("sha256").update("maligator-verification-source-v1\0");
	for (const file of files) {
		const absolute = path.join(root, file);
		let contents: Buffer;
		let mode: number;
		try {
			const stat = lstatSync(absolute);
			mode = stat.isSymbolicLink() ? 0o120000 : stat.mode & 0o111;
			contents = stat.isSymbolicLink()
				? Buffer.from(readlinkSync(absolute))
				: readFileSync(absolute);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
				throw error;
			mode = -1;
			contents = Buffer.alloc(0);
		}
		digest.update(`${file}\0${mode}\0${contents.length}\0`).update(contents);
	}
	return digest.digest("hex");
}

export function captureVerificationSource(root: string): VerificationSource {
	const git = (...args: Array<string>) =>
		execFileSync("git", args, {
			cwd: root,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 32 * 1024 * 1024,
		});
	if (realpathSync(git("rev-parse", "--show-toplevel").trim()) !== realpathSync(root)) {
		throw new Error("verification source must be the Git checkout root");
	}
	let revision: string | null = null;
	try {
		revision = git("rev-parse", "--verify", "HEAD").trim();
	} catch {
		// Unborn fixture repositories still have a complete working source identity.
	}
	const files = [
		...new Set(
			git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
				.split("\0")
				.filter(Boolean),
		),
	].sort();
	return {
		revision,
		digest: verificationSourceDigest(root, files),
		dirty: git("status", "--porcelain=v1", "--untracked-files=normal", "-z").length > 0,
		files: files.length,
	};
}

export function captureVerificationEnvironment(root: string) {
	const version = (command: string, cwd: string) => {
		try {
			return (
				execFileSync(command, ["--version"], {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 5000,
				})
					.trim()
					.split("\n")[0] ?? null
			);
		} catch {
			return null;
		}
	};
	const cc = process.env.CC?.trim() || "cc";
	return {
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		cc: { command: cc, version: version(cc, root) },
		rustc: {
			version: version("rustc", path.join(root, "runtime/rust")),
			toolchain: process.env.RUSTUP_TOOLCHAIN ?? null,
		},
	};
}
