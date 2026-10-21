// Public documentation servers do not expose an OAuth grant.
export function isPublicMcp(url?: string): boolean {
  try { return new URL(url!).hostname === 'docs.mcp.cloudflare.com' } catch { return false }
}
