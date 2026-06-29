import type { ToolDefinition } from "./types.js";

const realtimePatterns = [
  /\b(latest|today|current|now|recent|news|score|scores|price|weather|forecast|breaking)\b/i,
  /\bworld cup\b/i,
  /(世界杯|比分|得分|最新|今天|今日|现在|当前|新闻|价格|天气|股价|汇率)/
];

const searchToolPatterns = [
  /\b(web|search|fetch|browser|http|news|crawl|scrape)\b/i,
  /\b(搜索|联网|网页|浏览器|新闻)\b/i
];

export function requiresRealtimeExternalInfo(task: string): boolean {
  return realtimePatterns.some((pattern) => pattern.test(task));
}

export function hasMcpSearchTool(tools: ToolDefinition[]): boolean {
  return tools.some((tool) => {
    if (tool.source !== "mcp") {
      return false;
    }

    const haystack = `${tool.name}\n${tool.description}`;
    return searchToolPatterns.some((pattern) => pattern.test(haystack));
  });
}

export function missingSearchToolMessage(task: string): string {
  return [
    "这个问题需要查询实时或外部网络信息，但当前没有可用的 MCP 搜索/浏览工具。",
    "",
    `任务: ${task}`,
    "",
    "请先在 `.agent-mcp.json` 中接入 web search、browser、fetch 或类似 MCP server，然后重试。",
    "如果你只想让我基于本地项目文件回答，请明确说明不需要联网。"
  ].join("\n");
}
