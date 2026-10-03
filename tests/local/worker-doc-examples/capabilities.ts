import { capabilities } from "maligator:workers";

const host = capabilities();
console.log(host.threads, host.sharedMemory);
console.log(host.parallelism >= 1, host.maxWorkers >= 1);
