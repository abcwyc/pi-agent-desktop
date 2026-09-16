export function nextPromptAnchorSpacerHeight(
  targetTop: number,
  scrollHeight: number,
  viewportHeight: number,
  currentHeight: number,
): number {
  const maxScrollTopWithoutAnchor = Math.max(0, scrollHeight - currentHeight - viewportHeight);
  const next = Math.max(0, Math.ceil(targetTop - maxScrollTopWithoutAnchor));
  return Math.abs(next - currentHeight) <= 2 ? currentHeight : next;
}
