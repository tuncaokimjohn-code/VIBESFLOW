/** The only source -> graph presentation boundary. No heuristic secret detection:
 * even ASCII identifiers can encode credentials. Whitelist structure, withhold
 * ALL source text, and never spread source objects into a presentation object.
 * Evidence/source graphs remain byte-for-byte untouched. Tokens are display
 * identities, not source citations or a claim that the source has been redacted.
 */
import type { AstGraph } from "@/lib/ast-graph";
import { moduleNodeId } from "@/lib/ast-graph";
import { sha256SyncHex } from "@/lib/sha256-sync";

export function graphToken(kind: "Module" | "Member" | "Source", identity: string): string {
  // JSON preserves lone surrogates before UTF-8 hashing, avoiding replacement
  // collisions. Domain separation prevents cross-kind identity confusion.
  return `${kind}-${sha256SyncHex(JSON.stringify([kind, identity]))}`;
}
export function graphLine(value: number | null): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : 1;
}
export function graphKind(value: string | undefined): string {
  return ["function", "class", "const", "let", "var", "component", "re-export",
    "imports", "references", "external", "unknown", "unresolvable"].includes(value ?? "") ? value! : "unknown";
}
export function presentGraph(source: AstGraph): { graph: AstGraph; nodeId: (raw: string) => string } {
  const module = (raw: string) => graphToken("Module", raw);
  const member = (mod: string, name: string) => graphToken("Member", JSON.stringify([mod, name]));
  const ids = new Map(source.nodes.map(n => [n.id, n.kind === "module"
    ? moduleNodeId(module(n.module)) : `${moduleNodeId(module(n.module))}#${member(n.module, n.label)}`]));
  const nodeId = (raw: string) => ids.get(raw) ?? graphToken("Source", raw);
  const edges = source.edges.map(e => ({ from: nodeId(e.from), to: nodeId(e.to),
    kind: graphKind(e.kind) as typeof e.kind, line: graphLine(e.line), specifier: "" }));
  const graph: AstGraph = {
    nodes: source.nodes.map(n => ({ id: nodeId(n.id), kind: n.kind === "module" ? "module" : "member",
      module: module(n.module), label: n.kind === "module" ? module(n.module) : member(n.module, n.label),
      line: n.line === null ? null : graphLine(n.line), declKind: graphKind(n.declKind),
      members: Object.fromEntries(Object.values(n.members).map(m => {
        const name = member(n.module, m.name);
        return [name, { name, kind: graphKind(m.kind), line: graphLine(m.line) }];
      })) })),
    edges, unresolved: edges.filter(e => e.kind !== "imports" && e.kind !== "references"),
    unsupportedModules: source.unsupportedModules.map(module), unsupportedForms: [],
    snapshotId: graphToken("Source", source.snapshotId), canonicalProvenance: graphToken("Source", source.canonicalProvenance),
    resolvedCommitIfGitHub: null,
  };
  return { graph, nodeId };
}
