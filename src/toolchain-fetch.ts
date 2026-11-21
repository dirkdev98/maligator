import { execFileSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import * as path from "node:path";
import {
	artifactFileDigest,
	artifactProducer,
	withArtifactActionLock,
} from "./artifact-store.ts";

export const PINNED_ZIG_VERSION = "0.17.1";
const zigDigests: Readonly<Record<string, string>> = {
	"aarch64-macos": "75f1bc7a1e9852f17ec9a0c1895f767c4ec56d46bc8a834920eece1d0359dd8d",
	"x86_64-macos": "9af07b20319fbd0c92ee46ad23e81d6a782b1aaea2cfb8dcbff35f1d2c7ddbb7",
	"aarch64-linux": "a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795",
	"x86_64-linux": "3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a",
};

export interface ZigDownload {
	url: string;
	sha256: string;
	directory: string;
	executable: string;
}

export function pinnedZigDownload(
	platform: NodeJS.Platform,
	arch: string,
	cacheDirectory: string,
): ZigDownload | undefined {
	const host = `${arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch}-${platform === "darwin" ? "macos" : platform}`;
	const sha256 = zigDigests[host];
	if (sha256 === undefined) return undefined;
	const name = `zig-${host}-${PINNED_ZIG_VERSION}`;
	const directory = path.join(cacheDirectory, "zig", "releases", name);
	return {
		url: `https://ziglang.org/download/${PINNED_ZIG_VERSION}/${name}.tar.xz`,
		sha256,
		directory,
		executable: path.join(directory, "zig"),
	};
}

export type FetchZigArchive = (url: string, destination: string) => void;

const fetchArchive: FetchZigArchive = (url, destination) => {
	execFileSync(
		"/usr/bin/curl",
		[
			"-q",
			"--proto",
			"=https",
			"--proto-redir",
			"=https",
			"--fail",
			"--location",
			"--silent",
			"--show-error",
			"--connect-timeout",
			"15",
			"--max-time",
			"180",
			"--output",
			destination,
			url,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
};

function isExecutable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

const ZIG_INSTALL_PRODUCER = artifactProducer("zig-install", 1, "zig-distribution");

/** Publish only a complete, verified release directory, even across concurrent builds. */
export function installPinnedZig(
	download: ZigDownload,
	cacheDirectory: string,
	fetch: FetchZigArchive = fetchArchive,
): void {
	withArtifactActionLock(
		cacheDirectory,
		"zig-install",
		ZIG_INSTALL_PRODUCER,
		download.sha256,
		() => {
			if (isExecutable(download.executable)) return;
			const parent = path.dirname(download.directory);
			mkdirSync(parent, { recursive: true });
			const temporary = mkdtempSync(path.join(parent, ".download-"));
			try {
				const archive = path.join(temporary, "zig.tar.xz");
				process.stderr.write(
					`Downloading Zig ${PINNED_ZIG_VERSION} from ${download.url} to ${download.directory}\n`,
				);
				fetch(download.url, archive);
				const digest = artifactFileDigest(archive);
				if (digest !== download.sha256)
					throw new Error(
						`SHA-256 checksum mismatch (expected ${download.sha256}, received ${digest})`,
					);
				execFileSync("/usr/bin/tar", ["-xJf", archive, "-C", temporary], {
					env: { ...process.env, PATH: "/usr/bin:/bin", TAR_OPTIONS: undefined },
					stdio: ["ignore", "ignore", "pipe"],
				});
				const extracted = path.join(temporary, path.basename(download.directory));
				if (!isExecutable(path.join(extracted, "zig")))
					throw new Error("the archive did not contain an executable named zig");
				rmSync(download.directory, { recursive: true, force: true });
				renameSync(extracted, download.directory);
			} catch (error) {
				throw new Error(
					`could not install Zig from ${download.url}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			} finally {
				rmSync(temporary, { recursive: true, force: true });
			}
		},
	);
}
