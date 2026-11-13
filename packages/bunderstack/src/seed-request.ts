/** Only the literal `1` asks for a seed; anything else, and nothing, does not. */
export function seedRequested(
  source: Record<string, string | undefined>,
): boolean {
  return source.BUNDERSTACK_SEED === '1'
}
