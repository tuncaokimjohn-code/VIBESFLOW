import "server-only";
import { createRequire } from "node:module";
import type * as Neon from "@neondatabase/serverless";

export interface SqlResult { command: string; rowCount: number | null; rows: Record<string, unknown>[] }
export interface SqlClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  end(): Promise<void>;
  on(event: "error", listener: () => void): unknown;
}
export type SqlClientFactory = () => SqlClient;
type NeonModule = Pick<typeof Neon, "Client">;
/** Concrete Neon WebSocket Client API, loaded lazily in Node >=22. No HTTP
 * transaction emulation, in-memory fallback, transport retry or credential logs.
 * Missing package ALWAYS closes the gate. createRequire keeps loading lazy and
 * off the client bundle; types are checked against the installed pinned driver.
 * Next's explicit file tracing includes the runtime module and its metadata. */
export function loadNeonClientFactory(connectionString: string): SqlClientFactory {
  const requireDriver = createRequire(`${process.cwd()}/package.json`);
  const moduleName = "@neondatabase/serverless";
  const driver = requireDriver(moduleName) as NeonModule;
  if (typeof driver.Client !== "function" || typeof globalThis.WebSocket !== "function") throw new Error("META_DRIVER_UNAVAILABLE");
  return () => {
    const client = new driver.Client({ connectionString, connectionTimeoutMillis: 4000,
      query_timeout: 1500, application_name: "vibeflow-meta-direct-002" });
    // Documented production transport: TLS-authenticated WSS, not experimental
    // pure-JS Postgres TLS. No global driver options or shared pools are mutated.
    client.neonConfig.useSecureWebSocket = true;
    client.neonConfig.forceDisablePgSSL = true;
    return client;
  };
}
