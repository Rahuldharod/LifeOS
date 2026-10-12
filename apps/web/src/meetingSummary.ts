/** Accepted meeting summary, supporting the current fenced block and its legacy unfenced form. */
export function meetingSummary(body: string | undefined) {
  const marked = body?.match(/^<!-- lifeos:summary:start -->\s*\n##\s+Summary[^\n]*\n([\s\S]*?)^<!-- lifeos:summary:end -->/m);
  const match = marked ?? body?.match(/^##\s+Summary\s*\n([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/m);
  return match?.[1]?.trim() || undefined;
}
