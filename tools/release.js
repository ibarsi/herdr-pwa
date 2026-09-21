// Cuts a semver release from conventional commits on main.
// See docs/superpowers/specs/2026-09-21-release-lifecycle-design.md

/** The conventional commit types this project uses. */
export const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert']

// Anchored and restricted to TYPES on purpose. A permissive `\w+` would let
// "wip: ..." pass the PR-title check and then vanish from the changelog,
// which is the one failure mode a hand-rolled parser has to rule out.
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(?:\\(([^)]+)\\))?(!)?: (.+)$`)

export function parseSubject(subject) {
  const match = SUBJECT.exec(subject.trim())
  if (!match) return null
  const [, type, scope, bang, description] = match
  return { type, scope: scope ?? null, description, breaking: Boolean(bang) }
}

/**
 * Parses `git log --format=%s%x00%b%x1e` output.
 * Returns the commits it understood and the subjects it did not, so the caller
 * can report the rejects rather than dropping them silently.
 */
export function parseCommits(raw) {
  const commits = []
  const unparsed = []
  for (const record of raw.split('\x1e')) {
    if (record.trim() === '') continue
    const [subject, body = ''] = record.split('\x00')
    const parsed = parseSubject(subject)
    if (!parsed) {
      unparsed.push(subject.trim())
      continue
    }
    parsed.breaking ||= /^BREAKING[ -]CHANGE:/m.test(body)
    commits.push(parsed)
  }
  return { commits, unparsed }
}

/** The semver intent of a commit range, before the pre-1.0 rule is applied. */
export function bumpLevel(commits) {
  if (commits.some((c) => c.breaking)) return 'major'
  if (commits.some((c) => c.type === 'feat')) return 'minor'
  if (commits.some((c) => c.type === 'fix')) return 'patch'
  return null
}

export function nextVersion(current, level) {
  if (!level) return null
  const [major, minor, patch] = current.split('.').map(Number)
  if (![major, minor, patch].every(Number.isInteger)) throw new Error(`not a semver version: ${current}`)

  // 0.x makes no compatibility promise, so a breaking change bumps the minor.
  // Graduating to 1.0.0 stays a deliberate edit of package.json.
  if (major === 0) return level === 'patch' ? `0.${minor}.${patch + 1}` : `0.${minor + 1}.0`

  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}
