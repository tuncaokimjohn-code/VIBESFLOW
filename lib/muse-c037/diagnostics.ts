import "server-only";
import { z } from "zod";
import { OutcomeSchema as PreviousOutcomeSchema } from "../muse-c036/diagnostics";
export * from "../muse-c036/diagnostics";
export const OutcomeSchema = PreviousOutcomeSchema.extend({ version: z.literal("c037-outcome-v1") });
export type Outcome = z.infer<typeof OutcomeSchema>;
