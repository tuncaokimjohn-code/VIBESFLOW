/** POST /api/explain — P6 explanation boundary (QA-04 bounded ingestion).
 *  The body is read incrementally under a hard byte cap and deadline
 *  BEFORE any handler/provider logic, so protection operates even when
 *  no provider is configured. C024 permanently disables real inference:
 *  client consent is not caller authorization to spend server credits. */
import { NextResponse } from "next/server";
import { retrieveOperatorExplanation } from "@/lib/muse-c038/browser-server";
import { MAX_REQUEST_BODY_BYTES, readRequestBody } from "@/lib/intake-api";
import { bodyErrorResponse } from "@/lib/intake-server";

const BODY_DEADLINE_MS = 30_000;

export async function POST(req: Request): Promise<Response> {
  let bounded;
  try {
    bounded = await readRequestBody(req, MAX_REQUEST_BODY_BYTES, BODY_DEADLINE_MS);
  } catch (err) {
    return bodyErrorResponse(err);
  }
  if (!bounded.ok) {
    const status = bounded.code === "LIMIT_EXCEEDED" ? 413 : 400;
    return NextResponse.json({ ok: false, code: bounded.code, message: "Could not read request body." }, { status });
  }
  let body: unknown;
  try { body = JSON.parse(bounded.text); } catch {
    return NextResponse.json({ ok: false, code: "VALIDATION", message: "Request body must be JSON." }, { status: 400 });
  }
  // Deny all inference, including when inherited live-approval flags are set.
  // No authentication/credit authority has been established for this route.
  // Read-only retrieval: no live provider/key/authorization issuer in this graph.
  const result = await retrieveOperatorExplanation(body, req.signal);
  const status = result.ok ? 200 : result.code === "CONSENT_REQUIRED" || result.code === "VALIDATION" ? 400
    : result.code === "PROVIDER_NOT_CONFIGURED" ? 503 : 502;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
