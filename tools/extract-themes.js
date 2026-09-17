// Extracts Herdr's built-in palettes from its Rust source into themes.json.
//
//   git clone --depth 1 https://github.com/herdrdev/herdr /tmp/herdr-src
//   node tools/extract-themes.js /tmp/herdr-src > themes.json
//
// Palettes are `pub fn <name>() -> Self` blocks in src/app/state.rs with 19
// colour tokens each. Function names use underscores; theme names use hyphens.
import { readFileSync } from 'node:fs'

const TOKENS = 19
const src = readFileSync(`${process.argv[2]}/src/app/state.rs`, 'utf8')
const themes = {}

for (const [, fn, body] of src.matchAll(/pub fn (\w+)\(\) -> Self \{\s*Self \{([\s\S]*?)\n\s*\}/g)) {
  const colors = {}
  for (const [, token, variant, r, g, b] of body.matchAll(
    /^\s*(\w+): Color::(\w+)(?:\((\d+), (\d+), (\d+)\))?,/gm
  )) {
    colors[token] =
      variant === 'Rgb'
        ? '#' + [r, g, b].map((n) => (+n).toString(16).padStart(2, '0')).join('')
        : variant === 'Reset'
          ? null
          : variant // an ANSI name; only the `terminal` theme has these
  }
  // Skips helper constructors and test fixtures that aren't palettes.
  if (Object.keys(colors).length === TOKENS) themes[fn.replaceAll('_', '-')] = colors
}

process.stdout.write(JSON.stringify(themes, null, 2) + '\n')
