import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export async function matchingNativeSymbols(
	binary: string,
	accept: (symbol: string, type: string) => boolean,
): Promise<Array<string>> {
	const child = spawn("nm", ["-g", binary], { stdio: ["ignore", "pipe", "pipe"] });
	const symbols: Array<string> = [];
	let stderr = "";
	child.stderr.setEncoding("utf-8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-8192);
	});
	const completion = new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`nm failed (${signal ?? code}): ${stderr}`));
		});
	});
	await Promise.all([
		completion,
		(async () => {
			for await (const line of createInterface({
				input: child.stdout,
				crlfDelay: Infinity,
			})) {
				const columns = line.trim().split(/\s+/);
				const raw = columns.at(-1) ?? "";
				const symbol = raw.startsWith("_") ? raw.slice(1) : raw;
				if (accept(symbol, columns.at(-2) ?? "")) symbols.push(symbol);
			}
		})(),
	]);
	return symbols.sort();
}
