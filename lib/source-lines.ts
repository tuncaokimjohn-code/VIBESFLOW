/** Exact source text: BOM is retained; all ECMAScript line terminators count. */
export function sourceLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\u2028\u2029]/);
}

export function sourceGeometry(text: string) {
  const encoder = new TextEncoder();
  const lineStartOffsets = [0];
  const terminators = /\r\n|[\n\r\u2028\u2029]/g;
  let previous = 0;
  let bytes = 0;
  let match: RegExpExecArray | null;
  while ((match = terminators.exec(text)) !== null) {
    const end = match.index + match[0].length;
    bytes += encoder.encode(text.slice(previous, end)).length;
    lineStartOffsets.push(bytes);
    previous = end;
  }
  return { lineCount: lineStartOffsets.length, lineStartOffsets };
}
