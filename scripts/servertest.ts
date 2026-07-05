/**
 * HTTP server acceptance runner (isolate_todo.md — fetch server). Builds the server
 * binary (runtime/server_test_main.c), spawns it, reads its ephemeral port, drives
 * it with Node's fetch (GET, POST, keep-alive reuse), asserts, and kills it.
 *
 *   node scripts/servertest.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { emitVmDefinition } from "../src/emit-vm.ts";
import { executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { buildLocalBinary } from "../src/local-build.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { allocateRegisters } from "../src/register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/semantic-program.ts";

function buildBinary(file: string, name: string): string {
	const semanticProgram = loadEntrypointAndRunSemanticAnalysis(path.resolve(file));
	const ir = compileSemanticProgramToIr(semanticProgram);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	const definition = lowerIrProgramToVmDefinition(ir);
	const cSource = emitVmDefinition(definition, { compiled: true });
	return buildLocalBinary({ name, cSource, verbose: false, mainFile: "runtime/server_test_main.c" });
}

function waitForPort(child: ChildProcess): Promise<number> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error("timeout waiting for PORT")), 15000);
		child.stdout?.on("data", (d: Buffer) => {
			buf += d.toString();
			const m = buf.match(/PORT (\d+)/);
			if (m) {
				clearTimeout(timer);
				resolve(Number(m[1]));
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`server exited early (code ${code})`));
		});
	});
}

let passed = 0;
let total = 0;
function check(ok: boolean, name: string): void {
	total++;
	if (ok) passed++;
	else console.log(`servertest CHECK FAIL: ${name}`);
}

const bin = buildBinary("tests/local/fibertest_stub.js", "servertest");
const child = spawn(bin, [], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

try {
	const port = await waitForPort(child);
	const base = `http://127.0.0.1:${port}`;

	const get = await fetch(`${base}/hello`);
	const getText = await get.text();
	check(get.status === 200, "GET status 200");
	check(getText.includes("GET /hello"), "GET echoes method + target");

	const post = await fetch(`${base}/api/x`, { method: "POST", body: "payload" });
	const postText = await post.text();
	check(post.status === 200, "POST status 200");
	check(postText.includes("POST /api/x"), "POST echoes method + target");

	// Keep-alive: several sequential requests (undici reuses the connection).
	let keepAliveOk = true;
	for (let i = 0; i < 5; i++) {
		const r = await fetch(`${base}/n/${i}`);
		const t = await r.text();
		if (r.status !== 200 || !t.includes(`/n/${i}`)) keepAliveOk = false;
	}
	check(keepAliveOk, "keep-alive: 5 sequential requests all served");
} catch (error) {
	console.log(`servertest ERROR: ${(error as Error).message}`);
	if (stderr.trim()) console.log(stderr.trim());
} finally {
	child.kill("SIGKILL");
}

console.log(`servertest PASS ${passed}/${total}`);
process.exit(passed === total && total > 0 ? 0 : 1);
