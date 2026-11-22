import { prepareCommand } from "./cli-commands.ts";
import type { CommandContext } from "./cli-commands.ts";
import { installCompilerProducerDigests } from "./compiler-cache-identity.ts";
import { publishCompilerResult } from "./compiler-profile-result.ts";
import type {
	CompilationRequest,
	CompilationTaskContext,
	CompilerRequestContext,
	TestCompilationRequest,
} from "./compiler-service.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import { serializeRootFailure } from "./compiler/root-compilation.ts";
import { FrontendCompilationSession } from "./frontend-cache.ts";
import { prepareTestApplication } from "./testing/prepare.ts";

let retained: { identity: string; context: CommandContext } | undefined;

function compilationContext(
	context: CompilationTaskContext,
	request: CompilerRequestContext,
	installationIdentity?: string,
): CommandContext {
	const flag =
		request.cancellation === undefined ? undefined : new Int32Array(request.cancellation);
	const checkpoint = () => {
		context.throwIfCancelled();
		if (flag !== undefined && Atomics.load(flag, 0) !== 0)
			throw new DOMException("Compiler task cancelled", "AbortError");
	};
	checkpoint();
	const identity = JSON.stringify({
		installation: installationIdentity ?? request.installation,
		producerDigests: request.producerDigests,
	});
	if (retained?.identity !== identity) {
		installCompilerProducerDigests(request.producerDigests);
		retained = {
			identity,
			context: {
				installation: request.installation,
				stripTypes: stripCompactTypes,
				frontendSession: new FrontendCompilationSession(),
				developmentCache: {
					toolchains: new Map(),
					runners: new Map(),
					warnings: new Map(),
				},
			},
		};
	}
	const session = retained.context.frontendSession!;
	if (request.invalidateAll) session.invalidate();
	else for (const file of request.invalidatedPaths) session.invalidate(file);
	return {
		...retained.context,
		...(request.dependencyWorker === undefined
			? {}
			: { dependencyWorker: request.dependencyWorker }),
		checkpoint,
		onCompilationPhase:
			context.report ??
			((phase) => {
				try {
					request.progress?.postMessage(phase);
				} catch {
					// A cancelled observer may close its port before the compiler has drained.
				}
			}),
	};
}

export function prepare(
	context: CompilationTaskContext,
	request: CompilationRequest,
	installationIdentity?: string,
) {
	try {
		return {
			ok: true as const,
			value: publishCompilerResult(
				prepareCommand(
					request.command,
					compilationContext(context, request, installationIdentity),
					request.compact,
				),
				request.profileDirectory,
			),
		};
	} catch (error) {
		return { ok: false as const, failure: serializeRootFailure(error) };
	} finally {
		request.progress?.close();
	}
}

export function prepareTests(
	context: CompilationTaskContext,
	request: TestCompilationRequest,
	installationIdentity?: string,
) {
	try {
		return {
			ok: true as const,
			value: prepareTestApplication(
				request.input,
				compilationContext(context, request, installationIdentity),
			),
		};
	} catch (error) {
		return { ok: false as const, failure: serializeRootFailure(error) };
	} finally {
		request.progress?.close();
	}
}
