const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
parentPort.postMessage({ doubled: workerData.value * 2 });
