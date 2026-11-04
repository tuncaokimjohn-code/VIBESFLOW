"use client";
import { cloneElement, useEffect, useRef, useState, type ReactElement } from "react";
import { useNodesInitialized, useReactFlow, type ReactFlowProps } from "@xyflow/react";

type Size = { width: number; height: number };

/** Same initial and resize policy. A small focused graph fits the desktop split
 * column; phones and dense overviews retain the readable anchor policy. */
export function measuredFitOptions(width: number, nodes: readonly { id: string; selected?: boolean }[], focused = false) {
  const anchor = nodes.find(node => node.selected) ?? nodes[0];
  return width < (focused ? 480 : 700) && anchor
    ? { nodes: [{ id: anchor.id }], padding: .12, minZoom: .8, maxZoom: 1 }
    : { padding: .12, maxZoom: 1 };
}

/** A closed dialog has no usable canvas. Never initialize Flow against it. */
export function MeasuredGraphCanvas({ children, overview, focused = false }: {
  children: ReactElement<ReactFlowProps>; overview: boolean; focused?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0 || !(element.checkVisibility?.() ?? true)) return;
      setSize(previous => previous?.width === width && previous.height === height ? previous : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  return <div ref={container} className="vf-measured-graph">
    {size ? cloneElement(children, {
      width: size.width, height: size.height,
      // The provider can consume its initial fit before the child effect runs.
      // Never seed it with an all-node phone fit that competes with readable fit.
      fitViewOptions: measuredFitOptions(size.width, children.props.nodes ?? [], focused),
      children: <>{children.props.children}<FitMeasuredViewport {...size} overview={overview} focused={focused} /></>,
    }) : <p role="status">Preparing graph viewport…</p>}
  </div>;
}

/** Refit only on mount or actual canvas resize, never on selection or dragging. */
export function FitMeasuredViewport({ width, height, overview, focused = false }: Size & { overview: boolean; focused?: boolean }) {
  const initialized = useNodesInitialized();
  const { fitView, getNodes } = useReactFlow();
  useEffect(() => {
    if (!initialized) return;
    // Allow Flow's own resize observer to commit the new canvas dimensions.
    const frame = requestAnimationFrame(() => {
      void fitView(measuredFitOptions(width, getNodes(), focused));
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, width, height, overview, focused, fitView, getNodes]);
  return null;
}
