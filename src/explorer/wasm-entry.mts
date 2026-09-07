import { compileExplorerRequest } from "./api.ts";

(
	globalThis as unknown as { __compileExplorer: typeof compileExplorerRequest }
).__compileExplorer = compileExplorerRequest;
