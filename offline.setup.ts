// All authorized tests are offline. Providers must inject deterministic transport.
globalThis.fetch = () => { throw new Error("External fetch disabled in Candidate 002 offline tests"); };
export {};
