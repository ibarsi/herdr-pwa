/**
 * Classifies one line of agent output into a style class, or '' for plain.
 *
 * Herdr's read API returns the terminal cell grid as plain text with all SGR
 * attributes dropped — verified against agent.read and pane.read, both sources,
 * with strip_ansi false. There is no colour to replay, so the only colour
 * available is the colour inferred here from the glyphs the agents themselves
 * print.
 *
 * Unrecognised lines return '' and render exactly as they do today. That benign
 * fallback is what makes per-agent glyphs acceptable here when cleanFeed
 * deliberately refuses them: a missed classification loses a colour, whereas a
 * missed drop rule would lose content.
 */

// Anchored at line start so prose merely discussing an error stays plain; a
// feed tinted red everywhere carries no signal at all.
const BAD = /^[\s│┃⎿>-]*(?:[✗✘×]|(?:error|errors|fatal|panic|failed|failure|fail)\b)/i

const ELISION = /^\s*[….]{1,3}\s*\+\d+\s+lines?\b/

/** Leading glyph → class. Sources: claude (● ⎿ ❯ ✻) and grok (◆ ┃). */
const GLYPHS = {
  '❯': 'you', // your own turn, the anchor you scan for on a phone
  '>': 'you',
  '●': 'head',
  '◆': 'head',
  '⏺': 'head',
  '⎿': 'aux',
  '┃': 'dim', // grok reasoning
  '✻': 'dim', // status and spinner lines
  '*': 'dim',
  $: 'cmd',
}

const BOX = '│├└┌┐┘┴┬┼─━╌┄═╭╰╮╯'

export function classifyLine(line) {
  if (line.trim() === '') return ''

  const glyph = line.trim()[0]

  // Your own turns keep their colour even when you are asking about a failure.
  if (GLYPHS[glyph] === 'you') return 'you'

  if (BAD.test(line)) return 'bad'
  if (ELISION.test(line)) return 'dim'
  if (BOX.includes(glyph)) return 'aux'

  return GLYPHS[glyph] ?? ''
}

/**
 * How to turn the painted lines `prev` into `next` without repainting them all:
 * drop `drop` lines off the top, keep the `keep` after them, discard the rest,
 * then append `append`.
 *
 * The result always rebuilds `next` exactly. The alignment only decides how
 * much stays in place, and so whether a reader scrolled up keeps their spot
 * when the 1000-line window slides or the footer is redrawn.
 *
 * ponytail: O(n²) worst case over candidate starts; fine for 1000 lines every
 * 500ms, revisit if the window grows.
 */
export function diffLines(prev, next) {
  let best = { drop: prev.length, keep: 0 }
  for (let d = 0; d < prev.length; d++) {
    if (prev[d] !== next[0]) continue
    let k = 0
    while (d + k < prev.length && k < next.length && prev[d + k] === next[k]) k++
    if (k > best.keep) best = { drop: d, keep: k }
    // Everything after d survived; no later start can keep more.
    if (d + k === prev.length) break
  }
  return { ...best, append: next.slice(best.keep) }
}
