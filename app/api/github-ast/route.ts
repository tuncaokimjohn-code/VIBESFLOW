/** POST /api/github-ast — public-only, optionally authenticated server intake. */
import { PublicGitHubRestProvider } from "@/lib/github-public-server";
import { createGitHubAstPost } from "@/lib/github-ast-server";

export const runtime = "nodejs";
export const POST = createGitHubAstPost(() => new PublicGitHubRestProvider());
