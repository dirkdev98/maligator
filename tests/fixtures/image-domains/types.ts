import type { WorkerUrl } from "maligator:workers";
export interface GenerationResult {
	worker: string;
	leaf: string;
}
export interface DomainGlobals {
	savedPhase?: boolean;
	savePhase?: boolean;
	initialGeneration: "first" | "second";
	takeDomainUrl(): WorkerUrl;
	saveDomainUrl(url: WorkerUrl): void;
	switchImageDomain(): void;
	domainPassed(): void;
}
