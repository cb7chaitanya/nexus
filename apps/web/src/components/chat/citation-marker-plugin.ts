// Hand-rolled remark plugin — no unist-util-visit dependency (not a
// declared package in this app), just a plain recursive walk of the mdast
// tree's `children` arrays, which is all a text-node transform needs.

const CITE_RE = /\[\[cite:([^[\]]+)]]/g;

interface MdastTextNode {
  type: "text";
  value: string;
}

interface CitationMarkerNode {
  type: "citationMarker";
  data: { hName: "citation-marker"; hProperties: { refid: string } };
}

interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
}

function splitTextNode(node: MdastTextNode): (MdastTextNode | CitationMarkerNode)[] {
  const { value } = node;
  CITE_RE.lastIndex = 0;
  if (!CITE_RE.test(value)) return [node];
  CITE_RE.lastIndex = 0;

  const result: (MdastTextNode | CitationMarkerNode)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITE_RE.exec(value)) !== null) {
    if (match.index > lastIndex) {
      result.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    result.push({ type: "citationMarker", data: { hName: "citation-marker", hProperties: { refid: match[1]! } } });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) {
    result.push({ type: "text", value: value.slice(lastIndex) });
  }
  return result;
}

function walk(node: MdastNode): void {
  if (!node.children) return;
  const newChildren: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      newChildren.push(...splitTextNode(child as MdastTextNode));
    } else {
      walk(child);
      newChildren.push(child);
    }
  }
  node.children = newChildren;
}

/** Turns `[[cite:refId]]` text produced by the backend's citation marker
 * rewrite (packages/core/src/citations/marker-filter.ts) into inline
 * `citation-marker` nodes, rendered by the `components["citation-marker"]`
 * override in markdown-content.tsx. */
export function remarkCitationMarkers() {
  return (tree: MdastNode) => {
    walk(tree);
  };
}
