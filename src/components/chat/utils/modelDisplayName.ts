/**
 * Claude desktop names models by family and version ("Opus 5.5"). Catalog
 * labels that are raw ids ("claude-opus-5-5") are shown that way; any other
 * label is kept as the provider wrote it.
 */
export function formatModelDisplayName(label: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(label.trim());
  if (!match) return label;
  const [, family, major, minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}
