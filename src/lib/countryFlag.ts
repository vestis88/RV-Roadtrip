export function isoCountryFlag(code: string): string {
  if (code.length !== 2) return ''
  const A = 0x1f1e6
  const chars = code
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(A + (c.charCodeAt(0) - 65)))
  return chars.join('')
}
