import { z } from "zod";
import { SavedResultSchema as PreviousSavedResultSchema } from "./muse-c037-contract";
export * from "./muse-c037-contract";
export { C034_MODEL as C038_MODEL } from "./muse-c034-contract";
export const SavedResultSchema = PreviousSavedResultSchema.extend({ version: z.literal("c038-result-v1") });
export type SavedResult = z.infer<typeof SavedResultSchema>;
