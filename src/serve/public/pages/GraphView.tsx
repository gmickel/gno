/**
 * GraphView - Full-screen knowledge graph visualization.
 *
 * Aesthetic: "Scholarly Observatory" - A constellation map of knowledge
 * where documents are celestial bodies connected by gossamer threads.
 * The dark canvas evokes a planetarium, with nodes glowing like stars
 * and edges as faint stellar connections.
 */

import {
  AlertTriangleIcon,
  FilterIcon,
  HomeIcon,
  SparklesIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";

// Lazy load the heavy graph library
const ForceGraph2D = lazy(() => import("react-force-graph-2d"));

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  uri: string;
  title: string | null;
  collection: string;
  relPath: string;
  degree: number;
}

interface GraphLink {
  source: string;
  target: string;
  type: "wiki" | "markdown" | "similar";
  weight: number;
}

interface GraphMeta {
  collection: string | null;
  nodeLimit: number;
  edgeLimit: number;
  totalNodes: number;
  totalEdges: number;
  totalEdgesUnresolved: number;
  returnedNodes: number;
  returnedEdges: number;
  truncated: boolean;
  linkedOnly: boolean;
  includedSimilar: boolean;
  similarAvailable: boolean;
  similarTopK: number;
  similarTruncatedByComputeBudget: boolean;
  warnings: string[];
}

interface GraphResponse {
  nodes: GraphNode[];
  links: GraphLink[];
  meta: GraphMeta;
}

interface CollectionInfo {
  name: string;
}

interface StatusResponse {
  collections: CollectionInfo[];
}

interface PageProps {
  navigate: (to: string | number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme colors (Scholarly Dusk palette)
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  // Node colors by collection - celestial palette
  nodeDefault: "#4db8a8", // Primary teal - main constellation
  nodeSimilar: "#d4a053", // Gold - similarity connections
  nodeHover: "#5ee3ce", // Bright teal - active star
  nodeSelected: "#f5d78e", // Warm gold - selected

  // Edge colors
  edgeWiki: "rgba(77, 184, 168, 0.4)", // Teal threads
  edgeMarkdown: "rgba(77, 184, 168, 0.25)", // Fainter teal
  edgeSimilar: "rgba(212, 160, 83, 0.3)", // Gold similarity

  // Background
  canvas: "#050505", // Deep black - observatory darkness
};

// Generate consistent colors for collections
function getCollectionColor(collection: string): string {
  // Simple hash to pick from a curated palette
  const palette = [
    "#4db8a8", // Teal
    "#d4a053", // Gold
    "#7c9eb2", // Slate blue
    "#a8c686", // Sage green
    "#c9a7c7", // Dusty lavender
    "#e2a76f", // Copper
    "#6ba3d6", // Sky blue
    "#b8a090", // Taupe
  ];
  let hash = 0;
  for (let i = 0; i < collection.length; i++) {
    hash = ((hash << 5) - hash + collection.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading & Empty States
// ─────────────────────────────────────────────────────────────────────────────

function GraphLoading() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6">
      {/* Orbital animation */}
      <div className="relative size-24">
        <div className="absolute inset-0 animate-spin rounded-full border border-[#4db8a8]/20 border-t-[#4db8a8]/60 [animation-duration:3s]" />
        <div className="absolute inset-3 animate-spin rounded-full border border-[#d4a053]/20 border-t-[#d4a053]/60 [animation-direction:reverse] [animation-duration:2s]" />
        <div className="absolute inset-6 flex items-center justify-center">
          <div className="size-3 animate-pulse rounded-full bg-[#4db8a8]/60" />
        </div>
      </div>
      <div className="text-center">
        <p className="font-mono text-[#4db8a8] text-sm">
          Mapping knowledge constellation...
        </p>
        <p className="mt-1 text-muted-foreground text-xs">
          Loading document connections
        </p>
      </div>
    </div>
  );
}

function GraphEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <div className="flex size-16 items-center justify-center rounded-full border border-[#d4a053]/30 bg-[#050505]/50">
        <SparklesIcon className="size-8 text-[#d4a053]/40" />
      </div>
      <div className="text-center">
        <p className="font-serif text-lg text-[#4db8a8]/80">
          No connections found
        </p>
        <p className="mt-1 text-muted-foreground text-sm">
          Documents haven&apos;t been linked yet. Add wiki links [[like this]]
          <br />
          or markdown links [like this](path.md) to see the graph.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Truncation Warning Banner
// ─────────────────────────────────────────────────────────────────────────────

function TruncationBanner({
  meta,
  onDismiss,
}: {
  meta: GraphMeta;
  onDismiss: () => void;
}) {
  if (!meta.truncated) return null;

  return (
    <div className="absolute top-16 right-4 left-4 z-20 md:left-auto md:max-w-md">
      <div className="flex items-start gap-3 rounded-lg border border-[#d4a053]/30 bg-[#0f1115]/95 p-3 shadow-lg backdrop-blur-sm">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-[#d4a053]" />
        <div className="flex-1 min-w-0">
          <p className="font-mono text-xs text-[#d4a053]">Graph truncated</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            Showing {meta.returnedNodes.toLocaleString()} of{" "}
            {meta.totalNodes.toLocaleString()} nodes and{" "}
            {meta.returnedEdges.toLocaleString()} of{" "}
            {meta.totalEdges.toLocaleString()} edges.
            {meta.totalEdgesUnresolved > 0 && (
              <> ({meta.totalEdgesUnresolved} unresolved links)</>
            )}
          </p>
        </div>
        <button
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-[#d4a053]/10 hover:text-[#d4a053]"
          onClick={onDismiss}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function GraphView({ navigate }: PageProps) {
  // Graph data state
  const [graphData, setGraphData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Collections for filter
  const [collections, setCollections] = useState<string[]>([]);

  // Filter state
  const [selectedCollection, setSelectedCollection] = useState<string>("_all");
  const [includeSimilar, setIncludeSimilar] = useState(false);

  // UI state
  const [showTruncationBanner, setShowTruncationBanner] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  // Graph ref for zoom controls - using any for dynamic import compatibility
  // biome-ignore lint: dynamic import typing
  const graphRef = useRef<any>(null);
  const pointerScaleRef = useRef(1);
  const zoomTimeoutRef = useRef<number | null>(null);
  const pointerTimeoutRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const clearZoomTimeouts = useCallback(() => {
    if (zoomTimeoutRef.current !== null) {
      clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = null;
    }
    if (pointerTimeoutRef.current !== null) {
      clearTimeout(pointerTimeoutRef.current);
      pointerTimeoutRef.current = null;
    }
  }, []);

  // Fetch collections on mount
  useEffect(() => {
    const fetchCollections = async () => {
      const { data } = await apiFetch<StatusResponse>("/api/status");
      if (data?.collections) {
        setCollections(data.collections.map((c) => c.name));
      }
    };
    void fetchCollections();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch graph data
  const fetchGraph = useCallback(async () => {
    const fetchSeq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    setShowTruncationBanner(true);
    clearZoomTimeouts();

    const params = new URLSearchParams();
    if (selectedCollection !== "_all") {
      params.set("collection", selectedCollection);
    }
    if (includeSimilar) {
      params.set("includeSimilar", "true");
    }
    params.set("limit", "2000");
    params.set("edgeLimit", "10000");

    const url = `/api/graph?${params.toString()}`;
    const { data, error: fetchError } = await apiFetch<GraphResponse>(url);

    if (!mountedRef.current || fetchSeq !== fetchSeqRef.current) return;

    if (fetchError || !data) {
      setError(fetchError ?? "Failed to load graph");
      setLoading(false);
      return;
    }

    setGraphData(data);
    setLoading(false);

    // Fit to view after data loads
    zoomTimeoutRef.current = window.setTimeout(() => {
      if (fetchSeq !== fetchSeqRef.current) return;
      const fg = graphRef.current;
      if (!fg) return;
      fg.zoomToFit(400);
      pointerTimeoutRef.current = window.setTimeout(() => {
        if (fetchSeq !== fetchSeqRef.current) return;
        const zoom = fg.zoom?.();
        if (typeof zoom === "number") {
          pointerScaleRef.current = zoom;
        }
      }, 450);
    }, 100);
  }, [clearZoomTimeouts, selectedCollection, includeSimilar]);

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  useEffect(() => () => clearZoomTimeouts(), [clearZoomTimeouts]);

  // Handle node click - navigate to document
  // biome-ignore lint: dynamic import typing
  const handleNodeClick = useCallback(
    (node: any) => {
      if (node?.uri) {
        navigate(`/doc?uri=${encodeURIComponent(node.uri)}`);
      }
    },
    [navigate]
  );

  // Zoom controls
  const handleZoomIn = () => {
    const fg = graphRef.current;
    if (fg) {
      const currentZoom = fg.zoom();
      fg.zoom(currentZoom * 1.3, 200);
    }
  };

  const handleZoomOut = () => {
    const fg = graphRef.current;
    if (fg) {
      const currentZoom = fg.zoom();
      fg.zoom(currentZoom / 1.3, 200);
    }
  };

  // Memoized graph data for force-graph (needs objects with x/y)
  const forceGraphData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };

    return {
      nodes: graphData.nodes.map((n) => ({
        ...n,
        // Add computed properties for rendering
        color: getCollectionColor(n.collection),
        size: Math.max(4, Math.min(20, 4 + Math.sqrt(n.degree) * 2)),
      })),
      links: graphData.links.map((l) => ({
        ...l,
        color:
          l.type === "similar"
            ? COLORS.edgeSimilar
            : l.type === "wiki"
              ? COLORS.edgeWiki
              : COLORS.edgeMarkdown,
      })),
    };
  }, [graphData]);

  // Node canvas rendering for custom aesthetics
  // biome-ignore lint: dynamic import typing
  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (node.x === undefined || node.y === undefined) return;

      const isHovered = hoveredNode?.id === node.id;
      const size = node.size / globalScale;
      const glowSize = size * 1.5;

      // Outer glow - subtle aurora effect
      if (isHovered) {
        ctx.beginPath();
        const gradient = ctx.createRadialGradient(
          node.x,
          node.y,
          size * 0.5,
          node.x,
          node.y,
          glowSize * 2
        );
        gradient.addColorStop(0, "rgba(94, 227, 206, 0.4)");
        gradient.addColorStop(1, "rgba(94, 227, 206, 0)");
        ctx.fillStyle = gradient;
        ctx.arc(node.x, node.y, glowSize * 2, 0, 2 * Math.PI);
        ctx.fill();
      }

      // Main node - celestial body
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = isHovered ? COLORS.nodeHover : node.color;
      ctx.fill();

      // Inner highlight - gives depth like a planet
      ctx.beginPath();
      ctx.arc(
        node.x - size * 0.25,
        node.y - size * 0.25,
        size * 0.3,
        0,
        2 * Math.PI
      );
      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.fill();

      // Label on hover
      if (isHovered && node.title) {
        const label =
          node.title.length > 30 ? node.title.slice(0, 30) + "…" : node.title;
        const fontSize = 12 / globalScale;
        ctx.font = `${fontSize}px Georgia, serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        // Label background
        const labelWidth = ctx.measureText(label).width + 8 / globalScale;
        const labelHeight = fontSize * 1.5;
        ctx.fillStyle = "rgba(15, 17, 21, 0.9)";
        ctx.fillRect(
          node.x - labelWidth / 2,
          node.y + size + 4 / globalScale,
          labelWidth,
          labelHeight
        );

        // Label text
        ctx.fillStyle = "#ededed";
        ctx.fillText(label, node.x, node.y + size + 6 / globalScale);
      }
    },
    [hoveredNode]
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#050505]">
      {/* Subtle star field background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage: `
            radial-gradient(1px 1px at 20px 30px, rgba(77, 184, 168, 0.4), transparent),
            radial-gradient(1px 1px at 40px 70px, rgba(212, 160, 83, 0.3), transparent),
            radial-gradient(1px 1px at 50px 160px, rgba(77, 184, 168, 0.3), transparent),
            radial-gradient(1px 1px at 90px 40px, rgba(255, 255, 255, 0.2), transparent),
            radial-gradient(1px 1px at 130px 80px, rgba(212, 160, 83, 0.2), transparent),
            radial-gradient(1px 1px at 160px 120px, rgba(77, 184, 168, 0.2), transparent)
          `,
          backgroundSize: "200px 200px",
        }}
      />

      {/* Header toolbar - glass panel */}
      <header className="absolute top-0 right-0 left-0 z-30 flex items-center justify-between gap-4 border-border/30 border-b bg-[#0f1115]/80 px-4 py-2 backdrop-blur-md">
        {/* Left: Navigation */}
        <div className="flex items-center gap-3">
          <Button
            className="gap-2"
            onClick={() => navigate("/")}
            size="sm"
            variant="ghost"
          >
            <HomeIcon className="size-4" />
            <span className="hidden sm:inline">Dashboard</span>
          </Button>

          <div className="h-4 w-px bg-border/50" />

          <h1 className="font-serif text-lg text-[#4db8a8]">Knowledge Graph</h1>
        </div>

        {/* Center: Filters */}
        <div className="flex items-center gap-3">
          {/* Collection filter */}
          <div className="flex items-center gap-2">
            <FilterIcon className="size-3.5 text-muted-foreground" />
            <Select
              onValueChange={setSelectedCollection}
              value={selectedCollection}
            >
              <SelectTrigger className="h-8 w-[160px] border-border/50 bg-background/50 text-xs">
                <SelectValue placeholder="All collections" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All collections</SelectItem>
                {collections.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Similarity toggle - only show if available */}
          {graphData?.meta.similarAvailable && (
            <Button
              className={cn(
                "gap-2 text-xs",
                includeSimilar &&
                  "border-[#d4a053]/50 bg-[#d4a053]/10 text-[#d4a053]"
              )}
              onClick={() => setIncludeSimilar(!includeSimilar)}
              size="sm"
              variant="outline"
            >
              <SparklesIcon className="size-3.5" />
              Similar
            </Button>
          )}
        </div>

        {/* Right: Stats & zoom */}
        <div className="flex items-center gap-3">
          {/* Stats badge */}
          {graphData && !loading && (
            <div className="flex items-center gap-2 rounded border border-border/30 bg-background/30 px-2 py-1 font-mono text-[10px] text-muted-foreground">
              <span className="text-[#4db8a8]">
                {graphData.nodes.length.toLocaleString()}
              </span>{" "}
              nodes
              <span className="text-border">•</span>
              <span className="text-[#d4a053]">
                {graphData.links.length.toLocaleString()}
              </span>{" "}
              edges
            </div>
          )}

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <Button
              className="size-7"
              onClick={handleZoomIn}
              size="icon"
              variant="ghost"
            >
              <ZoomInIcon className="size-4" />
            </Button>
            <Button
              className="size-7"
              onClick={handleZoomOut}
              size="icon"
              variant="ghost"
            >
              <ZoomOutIcon className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Truncation warning */}
      {graphData?.meta && showTruncationBanner && (
        <TruncationBanner
          meta={graphData.meta}
          onDismiss={() => setShowTruncationBanner(false)}
        />
      )}

      {/* Graph canvas */}
      <div className="h-full pt-12">
        {loading ? (
          <GraphLoading />
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="font-mono text-destructive text-sm">{error}</p>
            <Button
              onClick={() => void fetchGraph()}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : graphData && graphData.nodes.length === 0 ? (
          <GraphEmpty />
        ) : (
          <Suspense fallback={<GraphLoading />}>
            <ForceGraph2D
              backgroundColor={COLORS.canvas}
              cooldownTicks={100}
              graphData={forceGraphData}
              linkColor={(link: any) => link.color}
              linkCurvature={0.1}
              linkDirectionalParticleColor={() => COLORS.nodeDefault}
              linkDirectionalParticles={
                // Disable particles on large graphs for performance
                forceGraphData.links.length > 500 ? 0 : 1
              }
              linkDirectionalParticleWidth={1.5}
              linkWidth={(link: any) =>
                Math.max(0.5, Math.min(3, Math.sqrt(link.weight)))
              }
              nodeCanvasObject={paintNode}
              nodeLabel=""
              nodePointerAreaPaint={(
                node: any,
                color: string,
                ctx: CanvasRenderingContext2D
              ) => {
                if (node.x === undefined || node.y === undefined) return;
                const scale = pointerScaleRef.current || 1;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(
                  node.x,
                  node.y,
                  (node.size / scale) * 1.5,
                  0,
                  2 * Math.PI
                );
                ctx.fill();
              }}
              onNodeClick={handleNodeClick}
              onNodeHover={(node: any) => setHoveredNode(node)}
              onZoom={(transform: { k: number }) => {
                pointerScaleRef.current = transform.k;
              }}
              ref={graphRef}
            />
          </Suspense>
        )}
      </div>

      {/* Hovered node info panel */}
      {hoveredNode && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-20 rounded-lg border border-[#4db8a8]/30 bg-[#0f1115]/95 p-3 shadow-lg backdrop-blur-sm">
          <p className="font-serif text-sm text-[#4db8a8]">
            {hoveredNode.title || hoveredNode.relPath}
          </p>
          <p className="mt-0.5 font-mono text-muted-foreground text-xs">
            {hoveredNode.collection}/{hoveredNode.relPath}
          </p>
          <p className="mt-1 font-mono text-[10px] text-[#d4a053]">
            {hoveredNode.degree} connection{hoveredNode.degree !== 1 && "s"}
          </p>
        </div>
      )}

      {/* Legend */}
      <div className="absolute right-4 bottom-4 z-20 rounded-lg border border-border/30 bg-[#0f1115]/80 p-2 backdrop-blur-sm">
        <div className="flex flex-col gap-1.5 font-mono text-[10px]">
          <div className="flex items-center gap-2">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: COLORS.edgeWiki }}
            />
            <span className="text-muted-foreground">Wiki links</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: COLORS.edgeMarkdown }}
            />
            <span className="text-muted-foreground">Markdown links</span>
          </div>
          {includeSimilar && (
            <div className="flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: COLORS.edgeSimilar }}
              />
              <span className="text-muted-foreground">Similarity</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
