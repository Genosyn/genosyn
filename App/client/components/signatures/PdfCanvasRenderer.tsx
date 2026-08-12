import React from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { AlertCircle, FileText } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import {
  SIGNATURE_FIELD_LABELS,
  resizeSignatureFieldGeometry,
  signatureFieldResizeHandlePosition,
  type SignatureField,
  type SignatureFieldGeometry,
} from "@/lib/signing";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type FieldPosition = Pick<SignatureField, "x" | "y">;

export type PdfCanvasRendererProps = {
  sourceUrl: string;
  fields?: SignatureField[];
  selectedFieldId?: string | null;
  onFieldSelect?: (fieldId: string) => void;
  onPageClick?: (pageNumber: number, x: number, y: number) => void;
  onFieldMove?: (fieldId: string, position: FieldPosition) => void;
  onFieldResize?: (fieldId: string, geometry: SignatureFieldGeometry) => void;
  renderField?: (field: SignatureField) => React.ReactNode;
  fieldLabel?: (field: SignatureField) => string;
  fieldClassName?: (field: SignatureField, selected: boolean) => string;
  fieldStyle?: (field: SignatureField) => React.CSSProperties;
  readOnly?: boolean;
  className?: string;
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The PDF could not be opened.";
}

export function PdfCanvasRenderer({
  sourceUrl,
  fields = [],
  selectedFieldId,
  onFieldSelect,
  onPageClick,
  onFieldMove,
  onFieldResize,
  renderField,
  fieldLabel,
  fieldClassName,
  fieldStyle,
  readOnly = false,
  className = "",
}: PdfCanvasRendererProps) {
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    const controller = new AbortController();
    setDocument(null);
    setError(null);

    void fetch(sourceUrl, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load this PDF (${response.status}).`);
        const task = getDocument({ data: await response.arrayBuffer() });
        loaded = await task.promise;
        if (!cancelled) setDocument(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(messageFor(cause));
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
      loaded?.cleanup();
    };
  }, [sourceUrl]);

  if (error) {
    return (
      <div className={`flex min-h-72 items-center justify-center p-6 ${className}`}>
        <div className="max-w-sm text-center text-sm text-slate-500 dark:text-slate-400">
          <AlertCircle className="mx-auto mb-3 text-rose-500" size={24} />
          <p className="font-medium text-slate-800 dark:text-slate-200">PDF preview unavailable</p>
          <p className="mt-1">{error}</p>
        </div>
      </div>
    );
  }

  if (!document) {
    return (
      <div
        className={`flex min-h-72 items-center justify-center gap-3 text-sm text-slate-500 ${className}`}
      >
        <Spinner size={20} /> Rendering document…
      </div>
    );
  }

  return (
    <div className={`space-y-5 p-4 sm:p-6 ${className}`}>
      {Array.from({ length: document.numPages }, (_, index) => {
        const pageNumber = index + 1;
        return (
          <PdfPage
            key={pageNumber}
            document={document}
            pageNumber={pageNumber}
            fields={fields.filter((field) => field.pageNumber === pageNumber)}
            selectedFieldId={selectedFieldId}
            onFieldSelect={onFieldSelect}
            onPageClick={onPageClick}
            onFieldMove={onFieldMove}
            onFieldResize={onFieldResize}
            renderField={renderField}
            fieldLabel={fieldLabel}
            fieldClassName={fieldClassName}
            fieldStyle={fieldStyle}
            readOnly={readOnly}
          />
        );
      })}
    </div>
  );
}

function PdfPage({
  document,
  pageNumber,
  fields,
  selectedFieldId,
  onFieldSelect,
  onPageClick,
  onFieldMove,
  onFieldResize,
  renderField,
  fieldLabel,
  fieldClassName,
  fieldStyle,
  readOnly,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  fields: SignatureField[];
  selectedFieldId?: string | null;
  onFieldSelect?: (fieldId: string) => void;
  onPageClick?: (pageNumber: number, x: number, y: number) => void;
  onFieldMove?: (fieldId: string, position: FieldPosition) => void;
  onFieldResize?: (fieldId: string, geometry: SignatureFieldGeometry) => void;
  renderField?: (field: SignatureField) => React.ReactNode;
  fieldLabel?: (field: SignatureField) => string;
  fieldClassName?: (field: SignatureField, selected: boolean) => string;
  fieldStyle?: (field: SignatureField) => React.CSSProperties;
  readOnly: boolean;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [page, setPage] = React.useState<PDFPageProxy | null>(null);
  const [ratio, setRatio] = React.useState(1.294);
  const [shouldLoad, setShouldLoad] = React.useState(false);
  const [shouldRender, setShouldRender] = React.useState(false);
  const [wrapperSize, setWrapperSize] = React.useState({ width: 850, height: 1100 });
  const dragMoved = React.useRef(false);

  React.useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      setShouldRender(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setShouldRender(entry.isIntersecting);
        if (entry.isIntersecting) setShouldLoad(true);
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    setPage(null);
    if (!shouldLoad) return;
    let cancelled = false;
    let loadedPage: PDFPageProxy | null = null;
    void document.getPage(pageNumber).then((next) => {
      loadedPage = next;
      if (!cancelled) {
        const viewport = next.getViewport({ scale: 1 });
        setRatio(viewport.height / viewport.width);
        setPage(next);
      }
    });
    return () => {
      cancelled = true;
      loadedPage?.cleanup();
    };
  }, [document, pageNumber, shouldLoad]);

  React.useEffect(() => {
    if (!shouldRender || !page || !canvasRef.current || !wrapperRef.current) return;
    let task: ReturnType<PDFPageProxy["render"]> | null = null;
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;

    const render = () => {
      const width = Math.max(1, wrapper.clientWidth);
      const height = Math.max(1, wrapper.clientHeight);
      setWrapperSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(280, width) / base.width;
      const viewport = page.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      task?.cancel();
      task = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      void task.promise.catch((cause: unknown) => {
        if (!(cause instanceof Error) || cause.name !== "RenderingCancelledException") {
          // Rendering errors are surfaced by the empty canvas without taking down the editor.
        }
      });
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      task?.cancel();
    };
  }, [page, shouldRender]);

  function positionFromPointer(event: { clientX: number; clientY: number }): {
    x: number;
    y: number;
  } {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  return (
    <div className="mx-auto max-w-[850px]">
      <div
        ref={wrapperRef}
        role={!readOnly && onPageClick ? "button" : undefined}
        tabIndex={!readOnly && onPageClick ? 0 : undefined}
        aria-label={
          !readOnly && onPageClick
            ? `Page ${pageNumber}. Press Enter or Space to place the selected field in the center.`
            : undefined
        }
        className={`relative overflow-hidden bg-white shadow-sm ring-1 ring-slate-200 dark:ring-slate-700 ${
          !readOnly && onPageClick ? "cursor-crosshair" : ""
        }`}
        style={{ aspectRatio: `1 / ${ratio}` }}
        onClick={(event) => {
          if (!onPageClick || readOnly || dragMoved.current) {
            dragMoved.current = false;
            return;
          }
          const position = positionFromPointer(event);
          onPageClick(pageNumber, position.x, position.y);
        }}
        onKeyDown={(event) => {
          if (!onPageClick || readOnly || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          // Keyboard placement walks down the page so several fields remain
          // independently reachable instead of stacking at the same point.
          onPageClick(pageNumber, 0.5, 0.2 + (fields.length % 7) * 0.1);
        }}
      >
        {(!page || !shouldRender) && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-300">
            <FileText size={28} />
          </div>
        )}
        {page && shouldRender ? (
          <canvas ref={canvasRef} aria-hidden="true" className="block max-w-full" />
        ) : null}
        {fields.map((field) => {
          const selected = field.id === selectedFieldId;
          const label = fieldLabel?.(field) || field.label || SIGNATURE_FIELD_LABELS[field.type];
          const resizeHandle = signatureFieldResizeHandlePosition(field, wrapperSize);
          return (
            <React.Fragment key={field.id}>
              <div
                role={readOnly ? undefined : "button"}
                tabIndex={readOnly ? undefined : 0}
                aria-label={
                  readOnly
                    ? undefined
                    : `${label} field. Use arrow keys to move it${onFieldResize ? "; select it to reveal the resize handle" : ""}.`
                }
                aria-pressed={!readOnly ? selected : undefined}
                data-signature-field-id={field.id}
                className={`absolute overflow-hidden rounded border text-[10px] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  selected
                    ? "z-20 border-indigo-600 bg-indigo-100/90 ring-2 ring-indigo-400/30 dark:bg-indigo-950/90"
                    : "z-10 border-indigo-300 bg-indigo-50/90 dark:border-indigo-600 dark:bg-indigo-950/80"
                } ${!readOnly && onFieldMove ? "cursor-move touch-none" : ""} ${fieldClassName?.(field, selected) ?? ""}`}
                style={{
                  ...fieldStyle?.(field),
                  left: `${field.x * 100}%`,
                  top: `${field.y * 100}%`,
                  width: `${field.width * 100}%`,
                  height: `${field.height * 100}%`,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onFieldSelect?.(field.id);
                }}
                onKeyDown={(event) => {
                  if (readOnly) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onFieldSelect?.(field.id);
                    return;
                  }
                  if (
                    !onFieldMove ||
                    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  const step = event.shiftKey ? 0.05 : 0.01;
                  const dx =
                    event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
                  const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
                  onFieldMove(field.id, {
                    x: Math.max(0, Math.min(1 - field.width, field.x + dx)),
                    y: Math.max(0, Math.min(1 - field.height, field.y + dy)),
                  });
                }}
                onPointerDown={(event) => {
                  if (readOnly || !onFieldMove) return;
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragMoved.current = false;
                  const origin = { x: field.x, y: field.y };
                  const target = event.currentTarget;
                  const move = (moveEvent: PointerEvent) => {
                    dragMoved.current = true;
                    const rect = wrapperRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    const x = origin.x + (moveEvent.clientX - event.clientX) / rect.width;
                    const y = origin.y + (moveEvent.clientY - event.clientY) / rect.height;
                    onFieldMove(field.id, {
                      x: Math.max(0, Math.min(1 - field.width, x)),
                      y: Math.max(0, Math.min(1 - field.height, y)),
                    });
                  };
                  const up = () => {
                    target.removeEventListener("pointermove", move);
                    target.removeEventListener("pointerup", up);
                    target.removeEventListener("pointercancel", up);
                    window.setTimeout(() => {
                      dragMoved.current = false;
                    });
                  };
                  target.addEventListener("pointermove", move);
                  target.addEventListener("pointerup", up);
                  target.addEventListener("pointercancel", up);
                }}
              >
                {renderField ? (
                  renderField(field)
                ) : (
                  <div className="flex h-full items-center px-2 font-medium">
                    <span className="truncate">
                      {label}
                      {field.required ? " *" : ""}
                    </span>
                  </div>
                )}
              </div>
              {!readOnly && onFieldResize && selected && (
                <button
                  type="button"
                  data-signature-field-resize={field.id}
                  aria-label={`Resize ${label} field, currently ${Math.round(field.width * 100)} percent wide by ${Math.round(field.height * 100)} percent high. Use arrow keys to resize; hold Shift for larger steps.`}
                  title="Drag to resize"
                  className="absolute z-30 h-11 w-11 cursor-nwse-resize touch-none rounded-sm text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-200"
                  style={{
                    left: `${resizeHandle.left}px`,
                    top: `${resizeHandle.top}px`,
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFieldSelect?.(field.id);
                  }}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const step = event.shiftKey ? 0.05 : 0.01;
                    const dx =
                      event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
                    const dy =
                      event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
                    onFieldResize(
                      field.id,
                      resizeSignatureFieldGeometry(field, "south-east", {
                        x: field.x + field.width + dx,
                        y: field.y + field.height + dy,
                      }),
                    );
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    onFieldSelect?.(field.id);
                    dragMoved.current = false;
                    const target = event.currentTarget;
                    const move = (moveEvent: PointerEvent) => {
                      dragMoved.current = true;
                      const rect = wrapperRef.current?.getBoundingClientRect();
                      if (!rect) return;
                      onFieldResize(
                        field.id,
                        resizeSignatureFieldGeometry(field, "south-east", {
                          x:
                            field.x +
                            field.width +
                            (moveEvent.clientX - event.clientX) / rect.width,
                          y:
                            field.y +
                            field.height +
                            (moveEvent.clientY - event.clientY) / rect.height,
                        }),
                      );
                    };
                    const up = () => {
                      target.removeEventListener("pointermove", move);
                      target.removeEventListener("pointerup", up);
                      target.removeEventListener("pointercancel", up);
                      window.setTimeout(() => {
                        dragMoved.current = false;
                      });
                    };
                    target.addEventListener("pointermove", move);
                    target.addEventListener("pointerup", up);
                    target.addEventListener("pointercancel", up);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute left-[5px] top-[5px] h-3 w-3 rounded-br-sm border-b-2 border-r-2 border-current"
                  />
                </button>
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="mt-2 text-center text-[11px] text-slate-400">Page {pageNumber}</div>
    </div>
  );
}
