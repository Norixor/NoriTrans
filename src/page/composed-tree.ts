/**
 * `Node.contains()` stops at a ShadowRoot boundary. Page translation works on
 * the composed tree, so ownership checks must walk through open-shadow hosts
 * and assigned slots as the user sees them.
 */
export function composedParentNode(node: Node): Node | null {
  if (node instanceof Element || node instanceof Text) {
    if (node.assignedSlot) return node.assignedSlot;
  }
  if (node instanceof ShadowRoot) return node.host;
  if (node.parentNode instanceof ShadowRoot) return node.parentNode.host;
  if (node.parentNode) return node.parentNode;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function composedContains(container: Node, node: Node): boolean {
  let current: Node | null = node;
  const visited = new Set<Node>();
  while (current && !visited.has(current)) {
    if (current === container) return true;
    visited.add(current);
    current = composedParentNode(current);
  }
  return false;
}
