export function validateWorkspaceAccount(account: unknown): asserts account is string {
  if (typeof account !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(account) || ['constructor', 'prototype', '__proto__'].includes(account)) {
    throw new Error('Choose an account name using lowercase letters, numbers, hyphens or underscores (for example work).')
  }
}
