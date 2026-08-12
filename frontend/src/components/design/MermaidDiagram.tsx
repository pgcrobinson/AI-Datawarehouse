"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

interface Props {
  code: string;
  canvasHeight?: string;
}

interface VB { x: number; y: number; w: number; h: number }

export function MermaidDiagram({ code, canvasHeight = "calc(100vh - 165px)" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const naturalVB = useRef<VB | null>(null);
  const currentVB = useRef<VB | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [error, setError] = useState<string | null>(null);

  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const vbAtDrag = useRef<VB | null>(null);

  function applyVB(vb: VB) {
    currentVB.current = vb;
    if (svgRef.current) {
      svgRef.current.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    }
    if (naturalVB.current) {
      setZoomPct(Math.round((naturalVB.current.w / vb.w) * 100));
    }
  }

  useEffect(() => {
    if (!code || !containerRef.current) return;
    let cancelled = false;
    svgRef.current = null;

    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          er: { useMaxWidth: false },
          flowchart: { useMaxWidth: false },
          sequence: { useMaxWidth: false },
        });

        const uid = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(uid, code);
        if (cancelled || !containerRef.current) return;

        // Parse the SVG string so we can manipulate attributes
        const parser = new DOMParser();
        const doc = parser.parseFromString(svg, "image/svg+xml");
        const svgEl = doc.querySelector("svg");
        if (!svgEl) throw new Error("No SVG element in mermaid output");

        // Determine natural viewBox
        let vb: VB;
        const vbAttr = svgEl.getAttribute("viewBox");
        if (vbAttr) {
          const [x, y, w, h] = vbAttr.trim().split(/[\s,]+/).map(Number);
          vb = { x, y, w, h };
        } else {
          const w = parseFloat(svgEl.getAttribute("width") || "800");
          const h = parseFloat(svgEl.getAttribute("height") || "600");
          vb = { x: 0, y: 0, w, h };
          svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
        }

        // Make SVG fill the container fully — viewBox controls zoom, not pixel dims
        svgEl.setAttribute("width", "100%");
        svgEl.setAttribute("height", "100%");
        svgEl.style.display = "block";

        containerRef.current.innerHTML = svgEl.outerHTML;
        svgRef.current = containerRef.current.querySelector("svg");

        naturalVB.current = vb;
        applyVB(vb);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

    return () => { cancelled = true; };
  }, [code]);

  function zoomAround(cx: number, cy: number, factor: number) {
    const vb = currentVB.current;
    const nat = naturalVB.current;
    if (!vb || !nat) return;

    const newW = Math.min(nat.w * 5, Math.max(nat.w * 0.05, vb.w / factor));
    const newH = Math.min(nat.h * 5, Math.max(nat.h * 0.05, vb.h / factor));
    const scale = newW / vb.w;

    applyVB({
      x: cx - (cx - vb.x) * scale,
      y: cy - (cy - vb.y) * scale,
      w: newW,
      h: newH,
    });
  }

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const vb = currentVB.current;
    if (!vb || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    // Mouse position in SVG coordinate space
    const cx = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
    const cy = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
    zoomAround(cx, cy, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    vbAtDrag.current = currentVB.current ? { ...currentVB.current } : null;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current || !vbAtDrag.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragStart.current.x) / rect.width) * vbAtDrag.current.w;
    const dy = ((e.clientY - dragStart.current.y) / rect.height) * vbAtDrag.current.h;
    applyVB({
      ...vbAtDrag.current,
      x: vbAtDrag.current.x - dx,
      y: vbAtDrag.current.y - dy,
    });
  }

  function onPointerUp() { dragging.current = false; }

  function reset() {
    if (naturalVB.current) applyVB(naturalVB.current);
  }

  if (error) {
    return (
      <div className="p-4 space-y-3">
        <p className="text-xs text-destructive font-medium">ERD render failed — showing raw source</p>
        <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap leading-relaxed">{code}</pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-muted/30 select-none">
        <Button variant="ghost" size="icon" className="h-6 w-6"
          onClick={() => { const vb = currentVB.current; if (vb) zoomAround(vb.x + vb.w / 2, vb.y + vb.h / 2, 1.3); }}
          title="Zoom in">
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6"
          onClick={() => { const vb = currentVB.current; if (vb) zoomAround(vb.x + vb.w / 2, vb.y + vb.h / 2, 1 / 1.3); }}
          title="Zoom out">
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-[10px] text-muted-foreground w-10 text-center tabular-nums">
          {zoomPct}%
        </span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={reset} title="Fit to screen">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
        <span className="text-[10px] text-muted-foreground/50 ml-2">
          Scroll to zoom · Drag to pan
        </span>
      </div>

      {/* SVG canvas — explicit viewport-relative height so SVG height:100% resolves correctly */}
      <div
        ref={containerRef}
        className="overflow-hidden cursor-grab active:cursor-grabbing bg-card [&>svg]:w-full [&>svg]:h-full"
        style={{ height: canvasHeight, minHeight: 400 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />
    </div>
  );
}
