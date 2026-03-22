import type { ScopeInformation } from "./program-info.ts";
import type { ModuleInformation, ScriptInformation } from "./program-info.ts";
import type { ProgramInformation } from "./program-info.ts";

export class Transform {
	private program: ProgramInformation;
	public chunks: Record<string, string> = {};
	public chunkInits = new Set<string>();
	public chunkEntrypoint = new Set<string>();

	static includes() {
		return `
#include <stdio.h>
#include "env.h"
#include "thread.h"
#include "value.h"
#include "value_ops.h"
`;
	}

	constructor(program: ProgramInformation) {
		this.program = program;
	}

	do() {
		for (const { scriptOrModule } of this.program.iterateProgramEntries()) {
			this.handleScriptOrModule(scriptOrModule);
		}

		return this;
	}

	handleScriptOrModule(scriptOrModule: ScriptInformation | ModuleInformation) {
		this.chunkEntrypoint.add(scriptOrModule.chunkEntrypointSymbol());
		this.chunkInits.add(scriptOrModule.chunkInitSymbol());

		this.chunks[scriptOrModule.id] = this.compileRootScope(
			scriptOrModule,
			scriptOrModule.rootScope,
		);
	}

	private compileRootScope(
		scriptOrModule: ScriptInformation | ModuleInformation,
		scope: ScopeInformation,
	) {
		const parts = [
			Transform.includes(),
			this.compileModuleInit(scriptOrModule, scope),
			this.compileModuleEntrypoint(scriptOrModule, scope),
		];

		return parts.join("\n");
	}

	/**
	 * Compile top-level statements.
	 */
	private compileModuleEntrypoint(
		scriptOrModule: ScriptInformation | ModuleInformation,
		scope: ScopeInformation,
	) {
		return `
    void ${scriptOrModule.chunkEntrypointSymbol()}(MalThread *thread, MalEnv *env) {
      
			MAL_RESULT_RETURN(MAL_NORMAL, mal_value_new_undefined());
    }
    `;
	}

	/**
	 * Compile hoisting of functions and variables.
	 */
	private compileModuleInit(
		scriptOrModule: ScriptInformation | ModuleInformation,
		scope: ScopeInformation,
	) {
		return `
    void ${scriptOrModule.chunkInitSymbol()}(MalThread *thread, MalEnv *env) {
        
			MAL_RESULT_RETURN(MAL_NORMAL, mal_value_new_undefined());
    }
    `;
	}
}
