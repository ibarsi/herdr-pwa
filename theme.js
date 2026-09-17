import { readFileSync } from 'node:fs'

const THEMES = JSON.parse(readFileSync(new URL('./themes.json', import.meta.url), 'utf8'))

const DEFAULT_THEME = 'catppuccin'

/**
 * Herdr's non-identity theme aliases, from canonical_theme_name in
 * src/config/theme.rs. Identity names are covered by the themes.json lookup.
 */
const ALIASES = {
  'catppuccin-mocha': 'catppuccin',
  latte: 'catppuccin-latte',
  light: 'catppuccin-latte',
  tokyonight: 'tokyo-night',
  'tokyo-day': 'tokyo-night-day',
  'tokyonight-day': 'tokyo-night-day',
  'gruvbox-dark': 'gruvbox',
  onedark: 'one-dark',
  onelight: 'one-light',
  'solarized-dark': 'solarized',
  lotus: 'kanagawa-lotus',
  rosepine: 'rose-pine',
  'rosepine-dawn': 'rose-pine-dawn',
  dawn: 'rose-pine-dawn',
}

/** Standard xterm values for the 16 ANSI colours Herdr's parse_color accepts. */
const ANSI = {
  black: '#000000',
  red: '#cd0000',
  green: '#00cd00',
  yellow: '#cdcd00',
  blue: '#0000ee',
  magenta: '#cd00cd',
  purple: '#cd00cd',
  cyan: '#00cdcd',
  white: '#ffffff',
  gray: '#e5e5e5',
  grey: '#e5e5e5',
  darkgray: '#7f7f7f',
  darkgrey: '#7f7f7f',
  lightred: '#ff0000',
  lightgreen: '#00ff00',
  lightyellow: '#ffff00',
  lightblue: '#5c5cff',
  lightmagenta: '#ff00ff',
  lightcyan: '#00ffff',
}

/**
 * Mirrors Herdr's parse_color (src/config/theme.rs:155): #rgb, #rrggbb,
 * rgb(r,g,b), reset aliases, and 16 ANSI names. Returns null for reset,
 * meaning "terminal default". Unknown values fall back to cyan, as Herdr does.
 */
export function parseColor(value) {
  const s = String(value).trim().toLowerCase()

  if (['reset', 'default', 'none', 'transparent'].includes(s)) return null

  const hex6 = s.match(/^#([0-9a-f]{6})$/)
  if (hex6) return `#${hex6[1]}`

  const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/)
  if (hex3) return `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`

  const rgb = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/)
  if (rgb && rgb.slice(1).every((n) => +n <= 255)) {
    return '#' + rgb.slice(1).map((n) => (+n).toString(16).padStart(2, '0')).join('')
  }

  return ANSI[s] ?? ANSI.cyan
}

/**
 * Pulls `key = value` pairs out of one TOML section header.
 *
 * Scoped to exactly what the theme needs — a section of flat scalar keys —
 * rather than a TOML parser, because the alternative is a dependency in a
 * project that deliberately has none. Reads until the next `[section]`.
 */
function section(configText, header) {
  const out = {}
  let inside = false
  for (const raw of configText.split('\n')) {
    // Strip unquoted `#` comments only — hex values like "#ff0000" must survive.
    const line = raw.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|#.*$/g, (m, q) => q || '').trim()
    if (line.startsWith('[')) {
      inside = line === header
      continue
    }
    if (!inside) continue
    const m = line.match(/^(\w+)\s*=\s*(.+)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** Resolves the Herdr config text to a palette the browser can use. */
export function resolveTheme(configText) {
  const requested = (section(configText, '[theme]').name ?? DEFAULT_THEME)
    .toLowerCase()
    .replace(/[ _]/g, '-')

  let name = ALIASES[requested] ?? requested
  // `terminal` is ANSI-only by design: it defers to the emulator's own palette,
  // which a browser does not have. Fall back to Herdr's default.
  if (!THEMES[name] || name === 'terminal') name = DEFAULT_THEME

  const colors = { ...THEMES[name] }
  for (const [token, value] of Object.entries(section(configText, '[theme.custom]'))) {
    if (token in colors) colors[token] = parseColor(value)
  }

  return { name, colors }
}

/** Reads Herdr's config. Any failure resolves to the default theme. */
export function loadTheme() {
  try {
    return resolveTheme(readFileSync(process.env.HERDR_CONFIG_PATH, 'utf8'))
  } catch {
    return resolveTheme('')
  }
}
