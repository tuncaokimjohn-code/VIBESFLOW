// Explicitly fictional synthetic preview data. NOT a real scan result.
// No real repository is fetched, scanned, or verified by this frontend.

export type GraphNodeDatum = {
  id: string;
  path: string;
  role: string;
  countLabel: string;
  tone: "blue" | "violet" | "teal" | "slate";
  x: number;
  y: number;
};

export type GraphEdgeDatum = { id: string; source: string; target: string; label?: string };

export type FindingDatum = {
  id: string;
  title: string;
  severity: "security" | "quality";
  fileLine: string;
  nodeId: string;
  summary: string;
  code: string[];
};

export const PREVIEW_REPO = "github.com/example/sample-api";
export const PREVIEW_SNAPSHOT = "preview-snapshot-fictional-001";

export const GRAPH_NODES: GraphNodeDatum[] = [
  { id: "index", path: "src/index.ts", role: "Application entry", countLabel: "6 exports", tone: "blue", x: 250, y: 20 },
  { id: "api", path: "src/api", role: "API routes (Express)", countLabel: "8 files", tone: "violet", x: 120, y: 190 },
  { id: "services", path: "src/services", role: "Business logic", countLabel: "7 files", tone: "teal", x: 400, y: 190 },
  { id: "orders", path: "src/api/orders.ts", role: "Order endpoints", countLabel: "4 exports", tone: "slate", x: 20, y: 360 },
  { id: "users", path: "src/api/users.ts", role: "User endpoints", countLabel: "3 exports", tone: "slate", x: 210, y: 360 },
  { id: "db", path: "src/db.ts", role: "Database client", countLabel: "5 exports", tone: "slate", x: 400, y: 360 },
  { id: "utils", path: "src/utils", role: "Utilities", countLabel: "6 files", tone: "teal", x: 580, y: 360 },
];

export const GRAPH_EDGES: GraphEdgeDatum[] = [
  { id: "e1", source: "index", target: "api" },
  { id: "e2", source: "index", target: "services" },
  { id: "e3", source: "api", target: "orders" },
  { id: "e4", source: "api", target: "users" },
  { id: "e5", source: "services", target: "db" },
  { id: "e6", source: "services", target: "utils" },
  { id: "e7", source: "orders", target: "utils", label: "uses" },
];

export const FINDINGS: FindingDatum[] = [
  {
    id: "f1",
    title: "Potential SQL injection",
    severity: "security",
    fileLine: "src/api/orders.ts:42",
    nodeId: "orders",
    summary:
      "User input appears to be concatenated into a SQL query. Consider using parameterized queries.",
    code: [
      "// fictional illustration only — not source evidence",
      "const q = `SELECT * FROM orders WHERE id = '${req.query.id}'`;",
      "await db.query(q); // line 42",
    ],
  },
  {
    id: "f2",
    title: "Review authorization check",
    severity: "quality",
    fileLine: "src/api/users.ts:18",
    nodeId: "users",
    summary:
      "Route handler may be missing an authorization check for sensitive user data. Verify access controls.",
    code: [
      "// fictional illustration only — not source evidence",
      "router.get(\"/users/:id\", async (req, res) => { // line 18",
      "  res.json(await getUser(req.params.id));",
    ],
  },
];

export const UNSCANNED = ["node_modules/", "dist/", ".github/", "test/", "scripts/", "examples/"];
