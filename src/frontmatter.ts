export type FrontmatterResult = {
  meta: Record<string, string>;
  body: string;
};

export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { meta: {}, body: content };
  }

  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    return { meta: {}, body: content };
  }

  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key) {
      meta[key] = value;
    }
  }

  return {
    meta,
    body: lines.slice(endIndex + 1).join("\n").trim()
  };
}
