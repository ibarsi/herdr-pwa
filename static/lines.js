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
