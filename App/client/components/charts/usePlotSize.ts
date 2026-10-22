import React from "react";

/** Axis text size in px, shared by every inline SVG chart. */
export const AXIS_FONT_SIZE = 11;

/**
 * The pixel size of a chart's box, kept current as it resizes, and the font
 * its axis text is set in. Charts draw at this size instead of stretching a
 * fixed viewBox, so text and dots keep their shape in a box of any shape.
 */
export function usePlotSize(ref: React.RefObject<HTMLElement>): {
  width: number;
  height: number;
  font: string;
} {
  const [size, setSize] = React.useState({ width: 0, height: 0, font: "" });
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const font = `${AXIS_FONT_SIZE}px ${getComputedStyle(element).fontFamily}`;
    const update = () => {
      const width = Math.floor(element.clientWidth);
      const height = Math.floor(element.clientHeight);
      setSize((prev) =>
        prev.width === width && prev.height === height && prev.font === font
          ? prev
          : { width, height, font },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

let measuringContext: CanvasRenderingContext2D | null = null;
const measuredWidths = new Map<string, number>();

/** Rendered width of a label, so an axis makes room for what it says. */
export function textWidth(text: string, font: string): number {
  measuringContext ??= document.createElement("canvas").getContext("2d");
  if (!measuringContext || !font) return text.length * 6.5;
  const key = `${font}|${text}`;
  let measured = measuredWidths.get(key);
  if (measured === undefined) {
    measuringContext.font = font;
    // Tabular figures run a little wider than the proportional ones measured.
    measured = measuringContext.measureText(text).width + 2;
    // Charts of a few thousand rows measure many labels; start over rather
    // than grow without end.
    if (measuredWidths.size >= 5000) measuredWidths.clear();
    measuredWidths.set(key, measured);
  }
  return measured;
}
