import { createHash } from 'node:crypto'

// U+2500, U+2501, U+254C, U+2504, U+2550, and ASCII hyphen.
const RULE_LINE = /^[─━╌┄═-]{20,}$/

/**
 * Cleans terminal text for display on a phone.
 *
 * Exactly one drop rule, verified agent-agnostic against live Claude Code and
 * grok panes. The TUI footer is deliberately kept: stripping it needs per-agent
 * parsing that breaks on the next agent installed, and on a phone the footer is
 * genuinely useful — it carries model, branch, context burn, and a spinner that
 * doubles as a liveness indicator.
 */
export function cleanFeed(text) {
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (RULE_LINE.test(trimmed)) continue
    // Collapse runs of more than one blank line to a single blank line.
    if (trimmed === '' && out.length > 0 && out[out.length - 1] === '') continue
    out.push(trimmed === '' ? '' : line.replace(/\s+$/, ''))
  }
  while (out.length && out[0] === '') out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/**
 * Content hash for conditional fetch.
 *
 * PaneReadResult.revision cannot be used for this: measured against Herdr
 * 0.9.0 it is always 0 for both `visible` and `recent` while the text changes
 * underneath. Hashing after cleaning means cosmetic churn the cleaner removes
 * does not trigger a re-render on the phone.
 */
export function hashFeed(text) {
  return createHash('sha1').update(text).digest('base64url').slice(0, 16)
}
