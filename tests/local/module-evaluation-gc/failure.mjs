import { probe } from "./probe.mjs";
probe("reject-before");
await 0;
probe("reject-after");
throw globalThis.moduleGcFailure;
