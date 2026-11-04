/** Vitest-only substitute for Next's server-only poison import.
 * This does not verify the Next/client bundle boundary.
 */
if (!process.env.VITEST) throw new Error("Test-only server boundary stub");
export {};
