// Shell command classification — extracted from agent.ts for reuse and testability.

export function isShellFileEditCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const fileWritePatterns = [
    /(?:^|[^0-9])>>?\s*(?!&)[^|\s]+/,
    /\b(set-content|add-content|out-file|new-item)\b/,
    /\bpython(?:3)?\b.*\bopen\s*\([^)]*["'](?:w|a|x|wb|ab|w\+|a\+)["']/,
    /\bpython(?:3)?\b.*\b(write_text|write_bytes|writelines)\s*\(/,
    /\bnode\b.*\b(writefilesync|appendfilesync|writefile|appendfile)\s*\(/,
    /\bperl\b.*\b-i\b/,
    /\bsed\b.*\b-i\b/
  ];
  return fileWritePatterns.some((pattern) => pattern.test(normalized));
}

export function isShellFileReadCommand(command: string): boolean {
  if (isShellFileEditCommand(command)) {
    return false;
  }

  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const fileReadPatterns = [
    /\b(get-content|gc|type|cat|more|select-string|findstr|grep|rg)\b/,
    /\bgit\s+(status|diff|show|log|grep|ls-files|rev-parse|branch)\b/,
    /\bpython(?:3)?\b.*\bopen\s*\([^)]*\)\s*\.\s*(read|readline|readlines)\s*\(/,
    /\bpython(?:3)?\b.*\b(readlines|read_text)\s*\(/,
    /\bnode\b.*\b(readfilesync|readfile)\s*\(/,
    /\bhead\b/,
    /\btail\b/
  ];
  return fileReadPatterns.some((pattern) => pattern.test(normalized));
}

export function isShellEnvironmentSetupCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const setupPatterns = [
    /(?:^|[\s&])(?:[^\s&|]*\\)?python(?:3)?(?:\.exe)?\s+-m\s+pip\s+install\b/,
    /\bpip(?:3)?\s+install\b/,
    /\buv\s+(?:pip\s+install|sync|add)\b/,
    /\bpoetry\s+install\b/,
    /\bpdm\s+install\b/,
    /\bconda\s+install\b/
  ];
  return setupPatterns.some((pattern) => pattern.test(normalized));
}

export function isShellVerificationCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const verificationPatterns = [
    /(?:^|[\s&])(?:[^\s&|]*\\)?python(?:3)?(?:\.exe)?\s+-m\s+pytest\b/,
    /(?:^|[\s&])(?:[^\s&|]*\\)?python(?:3)?(?:\.exe)?\s+-m\s+twisted\.trial\b/,
    /\btwisted\.trial\b/,
    /\bpytest\b/,
    /(?:^|[\s&])(?:[^\s&|]*\\)?python(?:3)?(?:\.exe)?\s+-m\s+(unittest|compileall|mypy|ruff)\b/,
    /\b(ast\.parse|compile\s*\(|py_compile)\b/,
    /\b(npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|check)\b/,
    /\b(tsc|eslint|vitest|jest)\b/,
    /\bnode\b.*\s--check\b/
  ];
  return verificationPatterns.some((pattern) => pattern.test(normalized));
}
