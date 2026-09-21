// Cuts a semver release from conventional commits on main.
// See docs/superpowers/specs/2026-09-21-release-lifecycle-design.md

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

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

// Ordered most to least interesting to someone reading a release note.
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['build', 'Build'],
  ['ci', 'CI'],
  ['test', 'Tests'],
  ['chore', 'Chores'],
  ['revert', 'Reverts'],
]

export function renderChangelog(version, date, commits) {
  const line = (c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.description}`
  const out = [`## ${version} (${date})`, '']

  const breaking = commits.filter((c) => c.breaking)
  if (breaking.length > 0) out.push('### Breaking changes', '', ...breaking.map(line), '')

  for (const [type, heading] of SECTIONS) {
    const group = commits.filter((c) => c.type === type)
    if (group.length > 0) out.push(`### ${heading}`, '', ...group.map(line), '')
  }
  return out.join('\n')
}

/** Pulls one version's body out of CHANGELOG.md, for the GitHub Release. */
export function readNotes(changelog, version) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

// stderr is captured so a caught failure (no tags yet) stays quiet. The thrown
// Error still carries git's message when a command fails for real.
const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

/**
 * Refuses to release from a state that would produce a tag nobody can
 * reproduce. Checked before anything is written, so a refusal leaves no mess.
 */
function assertReleasable() {
  if (git('status', '--porcelain') !== '') fail('working tree is not clean')
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('not on main')
  try {
    git('fetch', '--tags', 'origin', 'main')
  } catch {
    fail('cannot reach origin')
  }
  const behind = git('rev-list', '--count', 'HEAD..origin/main')
  if (behind !== '0') fail(`local main is ${behind} commit(s) behind origin/main`)
}

const lastTag = () => {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*')
  } catch {
    return null // no releases yet; the range becomes the whole history
  }
}

// Merge commits are never conventional, and their content is already counted
// in the commits they merge.
const logSince = (tag) => git('log', tag ? `${tag}..HEAD` : 'HEAD', '--no-merges', '--format=%s%x00%b%x1e')

function main(args) {
  const pkgPath = join(ROOT, 'package.json')
  const changelogPath = join(ROOT, 'CHANGELOG.md')

  if (args[0] === '--check-title') {
    // Shares one grammar with the changelog parser, so CI cannot accept a
    // title that the changelog would later drop.
    if (parseSubject(args[1] ?? '')) return console.log('ok')
    console.error(`Not a conventional commit subject: ${JSON.stringify(args[1] ?? '')}`)
    console.error(`Expected "<type>: <description>" or "<type>(<scope>)!: <description>".`)
    console.error(`Types: ${TYPES.join(', ')}`)
    process.exit(1)
  }

  if (args[0] === '--notes') {
    const notes = readNotes(readFileSync(changelogPath, 'utf8'), args[1])
    if (notes === null) fail(`no changelog section for ${args[1]}`)
    return console.log(notes)
  }

  const dryRun = args.includes('--dry-run')
  if (!dryRun) assertReleasable()

  const tag = lastTag()
  const { commits, unparsed } = parseCommits(logSince(tag))

  if (unparsed.length > 0) {
    console.warn(`\nNot conventional commits — these will NOT appear in the changelog:`)
    for (const subject of unparsed) console.warn(`  ${subject}`)
    console.warn('')
  }

  const level = bumpLevel(commits)
  if (!level) return console.log(`Nothing to release since ${tag ?? 'the first commit'}.`)

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const version = nextVersion(pkg.version, level)
  const section = renderChangelog(version, new Date().toISOString().slice(0, 10), commits)

  if (dryRun) {
    console.log(`${pkg.version} -> ${version}  (${level})\n`)
    return console.log(section)
  }

  pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  const previous = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# Changelog\n'
  const body = previous.slice(previous.indexOf('\n') + 1).trim()
  writeFileSync(changelogPath, `# Changelog\n\n${section}${body === '' ? '' : `\n${body}\n`}`)

  git('add', 'package.json', 'CHANGELOG.md')
  git('commit', '-m', `chore(release): ${version}`)
  git('tag', `v${version}`)
  git('push', '--follow-tags', 'origin', 'main')
  console.log(`\nReleased v${version}. Follow the build with: gh run watch`)
}

if (import.meta.main) main(process.argv.slice(2))
