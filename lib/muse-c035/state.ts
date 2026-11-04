/** Local OS account is the trust boundary. No browser can issue a grant. */
import "server-only";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { SavedResultSchema, type SavedResult } from "@/lib/muse-c035-contract";
import { sha256 } from "./protocol";
import { DiagnosticFailure, LocalIoFailure, OutcomeSchema, type Stage, type Outcome } from "./diagnostics";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const GrantSchema = z.strictObject({ version: z.literal("c035-grant-v1"), authorizationId: z.string().regex(/^[a-f0-9]{32}$/),
  qaManifestSha256: hash, requestSha256: hash, evidenceId: hash, expiresAt: z.iso.datetime(), issuedAt: z.iso.datetime(),
  maxAttempts: z.literal(1), financialAcknowledgement: z.literal("NO_PROVIDER_DOLLAR_CAP_VERIFIED") });
export type Grant = z.infer<typeof GrantSchema>;
const AttemptSchema = z.strictObject({ authorizationId: z.string().regex(/^[a-f0-9]{32}$/), requestSha256: hash,
  evidenceId: hash, candidateManifestSha256: hash });
export function privateDirectory(root: string) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === "/" || root === "/tmp" || root === "/home/deck") throw new Error("Private state unavailable");
  const candidateRoot = path.resolve(process.cwd());
  if (root === candidateRoot || root.startsWith(candidateRoot + "/") || root.includes("/VIBEFLOW_INSPECTOR_DEV/")) throw new Error("State must be outside candidates");
  // Trust the OS account's private home anchor, not numeric ownership of
  // idmapped system mount ancestors. Shared /tmp is never an approval root.
  const home = os.homedir(), anchor = fs.lstatSync(home);
  if (!root.startsWith(home + "/") || anchor.isSymbolicLink() || !anchor.isDirectory()
    || anchor.uid !== process.getuid?.() || (anchor.mode & 0o777) !== 0o700) throw new Error("Private home anchor required");
  let current = home;
  for (const part of path.relative(home, root).split(path.sep)) {
    current = path.join(current, part); const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("Unsafe state directory");
    if (st.uid !== 0 && st.uid !== process.getuid?.()) throw new Error("Untrusted state ancestor owner");
    if (st.mode & 0o022) throw new Error("Writable state ancestor");
  }
  const st = fs.lstatSync(root);
  if (st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error("Private state ownership required");
}
export function readPrivateJson(root: string, name: string, limit = 65_536): unknown {
  privateDirectory(root);
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid state name");
  const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > limit) throw new Error("Private state file required");
    const buffer = Buffer.alloc(limit + 1); const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (n > limit) throw new Error("State bound exceeded");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, n)));
  } finally { fs.closeSync(fd); }
}
export function writePrivateExclusive(root: string, name: string, value: unknown, stage: Stage = "RESULT_STORAGE") {
  let created = false;
  const io = <T>(operation: string, fn: () => T): T => {
    try { return fn(); } catch (error) { throw new LocalIoFailure(stage, operation, created, error); }
  };
  io("DIRECTORY_CHECK", () => privateDirectory(root));
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new LocalIoFailure(stage, "NAME_CHECK", false, null);
  const data = io("SERIALIZE", () => JSON.stringify(value));
  const fd = io("OPEN", () => fs.openSync(path.join(root, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));
  created = true;
  let first: unknown;
  try { io("WRITE", () => fs.writeFileSync(fd, data)); io("FILE_SYNC", () => fs.fsyncSync(fd)); }
  catch (error) { first = error; }
  try { io("FILE_CLOSE", () => fs.closeSync(fd)); } catch (error) { first ??= error; }
  if (first) throw first;
  const directory = io("DIRECTORY_OPEN", () => fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
  try { io("DIRECTORY_SYNC", () => fs.fsyncSync(directory)); } catch (error) { first = error; }
  try { io("DIRECTORY_CLOSE", () => fs.closeSync(directory)); } catch (error) { first ??= error; }
  if (first) throw first;
}
export function consumeGrant(root: string, grant: Grant, manifest: string) {
  writePrivateExclusive(root, "attempt.lock", { authorizationId: grant.authorizationId, requestSha256: grant.requestSha256,
    evidenceId: grant.evidenceId, candidateManifestSha256: manifest }, "RESERVATION");
}
export function writeOutcome(root: string, outcome: Outcome) {
  writePrivateExclusive(root, "outcome.json", OutcomeSchema.parse(outcome), "RESULT_STORAGE");
}
export function writeResult(root: string, result: SavedResult) {
  const parsed = SavedResultSchema.safeParse(result);
  if (!parsed.success) throw new DiagnosticFailure("RESULT_STORAGE", "RESULT_RECORD_SCHEMA_INVALID");
  writePrivateExclusive(root, `${parsed.data.binding.evidenceId}.json`, parsed.data);
}
export function readResult(root: string, evidenceId: string) {
  hash.parse(evidenceId);
  const result = SavedResultSchema.parse(readPrivateJson(root, `${evidenceId}.json`));
  const attempt = AttemptSchema.parse(readPrivateJson(root, "attempt.lock"));
  if (result.mode !== "provider-response" || attempt.authorizationId !== result.authorizationId
    || attempt.evidenceId !== evidenceId || attempt.requestSha256 !== result.requestSha256
    || attempt.candidateManifestSha256 !== result.candidateManifestSha256) throw new Error("No genuine authorized result");
  const outcome = OutcomeSchema.parse(readPrivateJson(root, "outcome.json", 8192));
  if (!outcome.ok || outcome.stage !== "COMPLETE" || outcome.mode !== "provider-response" || !outcome.bodyComplete
    || outcome.httpStatus !== 200 || !outcome.requestStarted || outcome.authorizationId !== result.authorizationId
    || outcome.evidenceId !== evidenceId || outcome.requestSha256 !== result.requestSha256
    || outcome.candidateManifestSha256 !== result.candidateManifestSha256
    || JSON.stringify(outcome.receipt) !== JSON.stringify(result.receipt)) throw new Error("No completed authorized outcome");
  return result;
}
/** Verify the QA-pinned manifest and its complete nongenerated inventory.
 * Neither credentials nor environment files are opened.
 */
export function verifyCandidate(root: string, expected: string) {
  hash.parse(expected); const manifestPath = path.join(root, "evidence/c035/manifest.sha256");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  if (sha256(manifest) !== expected) throw new Error("QA manifest mismatch");
  const verifyFile = (name: string, digest: string) => {
    hash.parse(digest);
    if (path.isAbsolute(name) || name.split("/").some(p => p === ".." || !p) || name.split("/").some(p => p.startsWith(".env"))) throw new Error("Unsafe manifest path");
    const full = path.join(root, name);
    if (fs.realpathSync(full) !== full || !fs.lstatSync(full).isFile() || sha256(fs.readFileSync(full)) !== digest) throw new Error("Candidate hash mismatch");
  };
  for (const row of manifest.trim().split("\n")) {
    const m = /^([a-f0-9]{64})  (.+)$/.exec(row); if (!m) throw new Error("Malformed manifest"); verifyFile(m[2], m[1]);
  }
  const inventory = JSON.parse(fs.readFileSync(path.join(root, "evidence/c035/full-content-inventory.json"), "utf8")) as { files: Record<string, string>; symlinks?: Record<string, string> };
  for (const [name, digest] of Object.entries(inventory.files)) verifyFile(name, digest);
  for (const [name, target] of Object.entries(inventory.symlinks ?? {})) {
    if (path.isAbsolute(name) || name.split("/").includes("..")) throw new Error("Unsafe symlink entry");
    const p = path.join(root, name);
    if (!fs.lstatSync(p).isSymbolicLink() || fs.readlinkSync(p) !== target) throw new Error("Changed dependency link");
  }
  const seen: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (["node_modules", ".next", ".vitest-cache", ".git", "__pycache__", "tsconfig.tsbuildinfo"].includes(name) || name.startsWith(".env") || name.startsWith(".c0")) continue;
      const full = path.join(dir, name), rel = path.relative(root, full), s = fs.lstatSync(full);
      if (s.isDirectory()) walk(full); else if (s.isFile()) seen.push(rel); else throw new Error("Unreviewed file kind");
    }
  };
  walk(root);
  const expectedNames = new Set([...Object.keys(inventory.files), "evidence/c035/full-content-inventory.json", "evidence/c035/manifest.sha256"]);
  if (seen.length !== expectedNames.size || seen.some(p => !expectedNames.has(p))) throw new Error("Unreviewed candidate file");
  return expected;
}
