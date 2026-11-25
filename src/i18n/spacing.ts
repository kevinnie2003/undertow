/**
 * Puts a space between Chinese characters and Latin letters or digits, the way
 * Chinese typesetting sets player names like "Bram" inside a sentence.
 */
export function spaceMixed(s: string): string {
  return s.replace(/([一-鿿])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9])([一-鿿])/g, '$1 $2');
}
