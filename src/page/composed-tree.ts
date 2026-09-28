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

// Composed trees cannot form cycles; the bound only guards against a
// pathological page instead of allocating a visited set on this hot path.
const MAX_COMPOSED_DEPTH = 4_096;

export function composedContains(container: Node, node: Node): boolean {
  // A light-tree ancestor is always a composed ancestor too: slot assignment
  // only reroutes a host's direct children, whose light parent is the host.
  if (container.contains(node)) return true;
  // Leaving the node's tree through an assigned slot always re-enters it at a
  // host that is also a light-tree ancestor of the node, so within one tree
  // `contains()` is already conclusive.
  if (container.getRootNode() === node.getRootNode()) return false;
  let current: Node | null = node;
  for (let depth = 0; current && depth < MAX_COMPOSED_DEPTH; depth += 1) {
    if (current === container) return true;
    current = composedParentNode(current);
  }
  return false;
}
