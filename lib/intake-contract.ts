/** Pure wire contracts. No transport, intake implementation or Node imports. */
import { z } from "zod";
import { canonicalSyntheticProvenance, E1_LIMITS, rejectUnsafePathForApi, type SourceSnapshot, type createSourceSnapshotSchema } from "@/lib/source-snapshot-contract";
import { isCanonicalRef, isValidName } from "@/lib/github-url";

export const MAX_REQUEST_BODY_BYTES = E1_LIMITS.maxRequestBodyBytes;

export const IntakeRequestSchema = z
  .object({
    url: z.string().min(1).max(512),
  })
  .strict();

export function createIntakeApiResponseSchema(snapshotSchema: ReturnType<typeof createSourceSnapshotSchema>) {
  const StrictSourceSnapshotSchema = snapshotSchema.strict();

  const IntakeFailureSchema = z
    .object({
      ok: z.literal(false),
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(512),
    })
    .strict();

  const IntakeSuccessSchema = z
    .object({
      ok: z.literal(true),
      snapshot: StrictSourceSnapshotSchema,
      requested: z
        .object({
          owner: z.string(),
          repo: z.string(),
          ref: z.string().nullable(),
        })
        .strict(),
      synthetic: z.literal(true),
      note: z.string(),
    })
    .strict()
    .superRefine((v, ctx) => {
      // synthetic:true must describe an actual synthetic snapshot — never a
      // github snapshot relabeled at the wire.
      if (v.snapshot.sourceKind !== "synthetic" || v.snapshot.resolvedCommitIfGitHub !== null) {
        ctx.addIssue({ code: "custom", message: "synthetic receipt must carry a synthetic snapshot" });
      }
      // Requested locator must match snapshot provenance under the SAME
      // canonicalization the parser and builder use: owner, repo, and the
      // exact normalized ref (null = default-resolution intent). Ambiguous
      // concatenations are impossible — `a-b/c` and `a/b-c` produce
      // different provenance strings, and `ref/default` never collides
      // with the `default` null-ref marker.
      if (!isValidName(v.requested.owner) || !isValidName(v.requested.repo)) {
        ctx.addIssue({ code: "custom", message: "requested owner/repo must be canonical GitHub names" });
      }
      if (!isCanonicalRef(v.requested.ref)) {
        ctx.addIssue({ code: "custom", message: "requested ref must be a canonical ref string" });
      }
      const expectedProvenance = canonicalSyntheticProvenance(
        v.requested.owner,
        v.requested.repo,
        v.requested.ref
      );
      if (v.snapshot.canonicalProvenance !== expectedProvenance) {
        ctx.addIssue({ code: "custom", message: "requested owner/repo/ref must match snapshot provenance" });
      }
      // Snapshot paths on the wire must be intake-safe (defense in depth
      // against forged payloads carrying traversal/control paths).
      for (const f of v.snapshot.files) {
        if (rejectUnsafePathForApi(f.path) !== null) {
          ctx.addIssue({ code: "custom", message: `unsafe path in response snapshot: ${f.path.slice(0, 64)}` });
          break;
        }
      }
    });

  return z.union([IntakeSuccessSchema, IntakeFailureSchema]);
}

export type IntakeApiResponse = z.infer<ReturnType<typeof createIntakeApiResponseSchema>>;
export type { SourceSnapshot };

/**
 * Receipt/locator binding (Finding D): a displayed success must name the
 * same owner, repo, and exact normalized ref that was submitted. A receipt
 * for another locator — including the same repo under a different ref or a
 * null ref presented as a named one — is an error, never a success.
 */
export function receiptMatchesRequest(
  requested: { owner: string; repo: string; ref: string | null },
  owner: string,
  repo: string,
  ref: string | null
): boolean {
  return requested.owner === owner && requested.repo === repo && requested.ref === ref;
}


export function malformedIntakeResponse() {
  return { ok: false, code: "MALFORMED", message: "Intake service returned an unrecognized response." } as const;
}
