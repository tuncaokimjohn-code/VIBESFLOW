// P4: controlled local TS/TSX fixtures for the AST architecture demo.
// These sources are OUR fixtures (never executed, parsed as text only).
// snapshotId is a display label for the offline demo; real SHA/manifest
// binding is proven in tests against snapshots built with the frozen
// source-snapshot helpers. Browser hashing stays out of the demo bundle.

export interface FixtureFile {
  path: string;
  language: "ts" | "tsx";
  content: string;
}

export const AST_FIXTURE_PROVENANCE = "offline-fixtures";
export const AST_FIXTURE_LABEL =
  "Offline fixture snapshot — real TypeScript AST from local fixture sources; SHA/evidence rules verified by offline tests (no network)";

export const FIXTURE_SOURCES: FixtureFile[] = [
  {
    path: "src/index.ts",
    language: "ts",
    content: `import { Router, createRouter } from "./router";
import { OrdersRoute } from "./api/orders";
import { UsersRoute } from "./api/users";
import { Session } from "./lib/session";

export function createApp() {
  const router = createRouter();
  router.use(OrdersRoute);
  router.use(UsersRoute);
  return router;
}

export type { Router, Session };
`,
  },
  {
    path: "src/router.ts",
    language: "ts",
    content: `export interface Router {
  use(handler: unknown): void;
  listen(port: number): void;
}

export function createRouter(): Router {
  const handlers: unknown[] = [];
  return {
    use(handler: unknown) {
      handlers.push(handler);
    },
    listen(port: number) {
      void port;
    },
  };
}

export class RouterError extends Error {}
`,
  },
  {
    path: "src/api/orders.ts",
    language: "ts",
    content: `import { Session } from "../lib/session";
import { Db } from "../lib/db";
import { ExternalClient } from "@acme/external-client";
import { format } from "date:util";

export interface Order {
  id: string;
  ownerId: string;
}

export async function listOrders(session: Session, db: Db): Promise<Order[]> {
  void session;
  void db;
  return [];
}

export const OrdersRoute = {
  path: "/orders",
  listOrders,
};

export function getOrder() {
  return null;
}
`,
  },
  {
    path: "src/api/users.ts",
    language: "ts",
    content: `import { Session } from "../lib/session";
import { Db } from "../lib/db";
import { computeTotal } from "../lib/math";
import { missing } from "./missing-module";
import { lazy } from "./lazy";

export interface User {
  id: string;
  email: string;
}

export async function getUser(session: Session, db: Db): Promise<User | null> {
  void session;
  void db;
  void computeTotal(0);
  void lazy;
  void missing;
  return null;
}

export const UsersRoute = {
  path: "/users",
  getUser,
};

export default function UsersPage() {
  return null;
}
`,
  },
  {
    path: "src/lib/session.ts",
    language: "ts",
    content: `export interface Session {
  userId: string;
  tenantId: string;
}

export function createSession(userId: string): Session {
  return { userId, tenantId: "tenant-1" };
}

export function requireSession(request: unknown): Session {
  void request;
  return createSession("u-1");
}
`,
  },
  {
    path: "src/lib/db.ts",
    language: "ts",
    content: `export interface Db {
  query(sql: string): Promise<unknown>;
}

export function createDb(): Db {
  return {
    async query(sql: string) {
      void sql;
      return [];
    },
  };
}
`,
  },
  {
    path: "src/lib/math.ts",
    language: "ts",
    content: `export function computeTotal(n: number): number {
  return n * n;
}

export const PI = 3.14159;
`,
  },
  {
    path: "src/components/OrdersTable.tsx",
    language: "tsx",
    content: `import type { Order } from "../api/orders";
import { useState } from "react";

export function OrdersTable(props: { orders: Order[] }) {
  const [q] = useState("");
  void q;
  return props.orders.length;
}

export default OrdersTable;
`,
  },
  {
    path: "src/lib/lazy.ts",
    language: "ts",
    content: `export const lazy = async () => {
  const mod = await import("./db");
  return mod;
};
`,
  },
];

export function fixtureFileEntries(): Array<{
  path: string;
  language: "ts" | "tsx";
  bytes: number;
  sha256: string;
  lineCount: number;
}> {
  return FIXTURE_SOURCES.map((f) => ({
    path: f.path,
    language: f.language,
    bytes: new TextEncoder().encode(f.content).length,
    sha256: "", // hashes verified in tests; browser demo never claims them
    lineCount: f.content.split("\n").length,
  }));
}

export function fixtureContents(): Map<string, string> {
  return new Map(FIXTURE_SOURCES.map((f) => [f.path, f.content] as const));
}
