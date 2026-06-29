export function summarizeText(text: string, maxChars = 1200): string {
  if (text.length <= maxChars) {
    return text;
  }

  const head = text.slice(0, Math.floor(maxChars * 0.65)).trimEnd();
  const tail = text.slice(-Math.floor(maxChars * 0.25)).trimStart();
  return `${head}\n...\n[summary: ${text.length} chars compressed]\n...\n${tail}`;
}

export function summarizeObservation(observation: string): string {
  return summarizeText(observation, 1600);
}
