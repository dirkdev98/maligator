import type { ExplorerResponse } from "./api.ts";
import type { ExplorerConfig, ExplorerLanguage } from "./config.ts";
import type { Sample } from "./samples.ts";

export interface ExplorerSiteData {
	schema: number;
	identity: string;
	version: string;
	wasmUrl: string;
	wasmBytes: number;
	compressedBytes: number;
	workerUrl: string;
	samples: ReadonlyArray<Sample>;
}

export type ExplorerWorkerRequest =
	| {
			type: "init";
			identity: string;
			wasmUrl: string;
			module?: WebAssembly.Module;
	  }
	| {
			type: "compile";
			id: number;
			identity: string;
			source: string;
			config: ExplorerConfig;
			language: ExplorerLanguage;
	  };

export type ExplorerWorkerResponse =
	| {
			type: "ready";
			identity: string;
			module: WebAssembly.Module;
			milliseconds: number;
			memoryBytes: number;
	  }
	| {
			type: "result";
			id: number;
			identity: string;
			response: ExplorerResponse;
			milliseconds: number;
			memoryBytes: number;
	  }
	| { type: "fatal"; message: string };
