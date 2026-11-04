import "server-only";

/** JSON.parse plus duplicate-key/depth rejection. Input must already be bounded.
 * No provider/auth error text is exposed by callers. */
export function strictJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      if (stack.length > 24) throw new Error("JSON_REJECTED");
    } else if (token === "}" || token === "]") stack.pop();
    else if (/^\s*:/.test(text.slice(match.index! + token.length))) {
      const keys = stack.at(-1), key: string = JSON.parse(token);
      if (!keys || keys.has(key)) throw new Error("JSON_REJECTED");
      keys.add(key);
    }
  }
  return value;
}
