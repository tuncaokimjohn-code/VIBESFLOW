import type { Node } from '@xyflow/react';
import type { Offsets } from './graph-interaction';

/** Disposable, per-canvas memo only. Coordinates never depend on cache history.
 * Weak keys release old views; each base node retains only its latest projection.
 * No scheduling, rounding, interpolation, topology changes or source mutation.
 */
export function createPositionProjector() {
  const cache = new WeakMap<Node, { x: number; y: number; node: Node }>();
  let previous: Node[] = [];
  return (base: Node[], offsets: Offsets): Node[] => {
    const next = base.map(node => {
      const x = offsets[node.id]?.x ?? 0, y = offsets[node.id]?.y ?? 0;
      if (x === 0 && y === 0) return node;
      const hit = cache.get(node);
      if (hit && hit.x === x && hit.y === y) return hit.node;
      const projected = { ...node, position: { x: node.position.x + x, y: node.position.y + y } };
      cache.set(node, { x, y, node: projected });
      return projected;
    });
    if (next.length === previous.length && next.every((node, i) => node === previous[i])) return previous;
    previous = next;
    return next;
  };
}
