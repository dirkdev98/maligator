import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** Measure an executable's code section; the raw `size` report is written before validation. */
export function measureBinaryTextBytes(
	binaryPath: string,
	options: { readonly env?: NodeJS.ProcessEnv; readonly reportPath?: string } = {},
): number {
	const size = spawnSync(
		"size",
		process.platform === "darwin"
			? ["-m", binaryPath]
			: ["--format=sysv", "--radix=10", binaryPath],
		{ encoding: "utf8", timeout: 10_000, env: options.env },
	);
	if (options.reportPath !== undefined)
		writeFileSync(options.reportPath, `${size.stdout ?? ""}\n${size.stderr ?? ""}`);
	if (size.error !== undefined) throw size.error;
	const textBytes =
		process.platform === "darwin"
			? size.stdout.match(/^\s*Section __text: (\d+)\s/m)?.[1]
			: size.stdout.match(/^\.text\s+(\d+)\s/m)?.[1];
	if (size.status !== 0 || textBytes === undefined || !/^\d+$/.test(textBytes))
		throw new Error("size did not produce a decimal .text section measurement");
	return Number(textBytes);
}
