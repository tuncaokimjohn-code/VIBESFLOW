import { z } from "zod";
import { SavedResultSchema as PreviousSavedResultSchema } from "./muse-c036-contract";
export * from "./muse-c036-contract";
export { C034_MODEL as C037_MODEL } from "./muse-c034-contract";
export const SavedResultSchema = PreviousSavedResultSchema.extend({ version: z.literal("c037-result-v1") });
export type SavedResult = z.infer<typeof SavedResultSchema>;
