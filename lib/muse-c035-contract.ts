/** Pure C035 storage version; claim/citation/UI contracts remain unchanged. */
import { z } from "zod";
import { SavedResultSchema as PreviousSavedResultSchema } from "./muse-c034-contract";
export * from "./muse-c034-contract";
export { C034_MODEL as C035_MODEL, C034_CLAIMS as C035_CLAIMS, C034_LIMITATION as C035_LIMITATION } from "./muse-c034-contract";
export const SavedResultSchema = PreviousSavedResultSchema.extend({ version: z.literal("c035-result-v1") });
export type SavedResult = z.infer<typeof SavedResultSchema>;
