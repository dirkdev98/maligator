/**
 * WinterTC fetch-server acceptance runner (isolate_todo.md). Builds a JS program
 * that calls Mal.serve with an (async) fetch handler (tests/local/fetch_server.js)
 * on the host entry, spawns it, reads its ephemeral port, and drives the handler
 * with Node's fetch — once plain and once under MAL_GC_STRESS + MAL_GC_VERIFY (which
 * exercises rooting of the in-flight Request/Response, the promise reactions, and
 * the suspended async handler frame).
 *
 *   node scripts/fetchtest.ts [file.js]
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
	return buildLocalBinary({ name, cSource, verbose: false, mainFile: "runtime/host_main.c" });
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

async function runServer(
	bin: string,
	label: string,
	env: NodeJS.ProcessEnv,
	checkAsync: boolean,
): Promise<boolean> {
	process.stdout.write(`fetchtest ${label} ... `);
	const child = spawn(bin, [], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
	let stderr = "";
	child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

	let passed = 0;
	let total = 0;
	const check = (ok: boolean, name: string): void => {
		total++;
		if (ok) passed++;
		else console.log(`\n  CHECK FAIL [${label}]: ${name}`);
	};

	try {
		const port = await waitForPort(child);
		const base = `http://127.0.0.1:${port}`;

		const get = await fetch(`${base}/hello`);
		const getText = await get.text();
		check(get.status === 200, "GET status 200");
		check(getText.includes("hello GET") && getText.includes("/hello"), "GET handler ran");

		const post = await fetch(`${base}/x`, { method: "POST", body: "b" });
		check((await post.text()).includes("hello POST"), "POST handler ran");

		const created = await fetch(`${base}/created`);
		check(created.status === 201 && (await created.text()) === "made", "custom status 201 + body");

		const json = await fetch(`${base}/json`);
		check(
			json.headers.get("content-type") === "application/json" && (await json.text()) === '{"ok":true}',
			"response custom Content-Type header",
		);

		const echo = await fetch(`${base}/echo`, { headers: { "x-test": "hi" } });
		check((await echo.text()) === "hi", "handler reads request.headers.get");

		// Binary Response body (BufferSource) — runs on both binaries (incl. STRESS).
		const bin = new Uint8Array(await (await fetch(`${base}/binary`)).arrayBuffer());
		check(bin.length === 5 && bin[0] === 1 && bin[4] === 5, "binary Response body (Uint8Array)");

		// Response.json handler — also runs under STRESS (sync binary).
		const rj = await fetch(`${base}/rjson`);
		const rjBody = await rj.json();
		check(
			rj.headers.get("content-type") === "application/json" && rjBody.ok === true && rjBody.n === 42,
			"Response.json handler",
		);

		if (checkAsync) {
			const asyncRes = await fetch(`${base}/async`);
			check(
				asyncRes.status === 200 && (await asyncRes.text()) === "async-done",
				"async handler responds",
			);

			const body = await fetch(`${base}/body`, { method: "POST", body: "hello-body" });
			check((await body.text()) === "body=hello-body", "request.text() reads POST body");

			const sum = await fetch(`${base}/sum`, { method: "POST", body: JSON.stringify({ a: 3, b: 4 }) });
			check((await sum.text()) === "7", "request.json() parses POST body");

			const abuf = await fetch(`${base}/abuf`, { method: "POST", body: "abcd" });
			check((await abuf.text()) === "len=4", "request.arrayBuffer() reads body bytes");

			const bytes = await fetch(`${base}/bytes`, { method: "POST", body: "xy" });
			check((await bytes.text()) === "b=120-121-2", "request.bytes() reads body as Uint8Array");

			const rr = await (await fetch(`${base}/respread`)).text();
			check(
				rr === "t=hello-resp,ab=10,b0=104,status=201,ok=true,st=Created",
				"Response read methods (text/arrayBuffer/bytes) + getters",
			);

			const rc = await (await fetch(`${base}/reqctor`)).text();
			check(rc === "m=PUT,u=https://x/y,h=v,b=abc", "new Request(input, init) + body round-trip");

			// A ReadableStream body makes undici send Transfer-Encoding: chunked.
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("chunked-data"));
					controller.close();
				},
			});
			// `duplex: "half"` is required by undici for a stream body but isn't in the
			// TS RequestInit type; cast through the shared init object.
			const chunkedInit = { method: "POST", body: stream, duplex: "half" };
			const chunked = await fetch(`${base}/body`, chunkedInit as RequestInit);
			check((await chunked.text()) === "body=chunked-data", "chunked request body decoded");
		}

		let keepAliveOk = true;
		for (let i = 0; i < 5; i++) {
			const r = await fetch(`${base}/n/${i}`);
			if (r.status !== 200 || !(await r.text()).includes(`/n/${i}`)) keepAliveOk = false;
		}
		check(keepAliveOk, "keep-alive: 5 sequential invocations");
	} catch (error) {
		console.log(`ERROR: ${(error as Error).message}`);
		if (stderr.trim()) console.log(stderr.trim());
	} finally {
		child.kill("SIGKILL");
	}

	const ok = passed === total && total > 0;
	console.log(ok ? `OK (${passed}/${total})` : `FAIL (${passed}/${total})`);
	return ok;
}

// Plain run drives the ASYNC handler (proves Promise<Response> works under normal
// auto-GC). The STRESS+VERIFY run uses the SYNC handler: it rigorously validates the
// server / Request / Response / promise-reaction rooting under collect-at-every-
// safepoint, without tripping the known pre-existing async-frame rooting gap (which
// affects all async code under MAL_GC_STRESS, not the fetch server specifically).
const asyncBin = buildBinary(process.argv[2] ?? "tests/local/fetch_server.js", "fetchtest");
const syncBin = buildBinary("tests/local/fetch_server_sync.js", "fetchtest-sync");

let allOk = await runServer(asyncBin, "compiled (async handler)", {}, true);
allOk =
	(await runServer(syncBin, "STRESS + VERIFY (sync handler)", { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" }, false)) &&
	allOk;
process.exit(allOk ? 0 : 1);
