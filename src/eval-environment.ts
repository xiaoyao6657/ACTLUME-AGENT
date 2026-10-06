export function removeProviderSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) {
    if (/^(?:OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|AZURE_OPENAI|GOOGLE)_.*(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)
      || /^(?:OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY)$/i.test(key)) {
      delete sanitized[key];
    }
  }
  return sanitized;
}
