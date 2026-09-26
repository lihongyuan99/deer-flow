export type CitationOccurrence = {
  index: number;
  title: string;
};

export type CitationSource = {
  id: string;
  title: string;
  url: string;
  domain: string;
  count: number;
  occurrences: CitationOccurrence[];
};

// Uses a non-consuming lookbehind (?<!!) to skip image links (![citation:…])
// without eating the boundary char, so back-to-back citations both match. The
// URL sub-pattern consumes either non-paren chars or a balanced (…) group, so
// disambiguation URLs like .../Foo_(a)_(b) survive rather than truncating at
// the first inner paren.
const CITATION_LINK_RE =
  /(?<!!)\[citation:\s*([^\]]+?)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/gi;

const GENERIC_CITATION_TITLES = new Set(["source", "来源"]);

export function extractCitationSources(markdown: string): CitationSource[] {
  if (!markdown) {
    return [];
  }

  const searchable = maskCitationCode(markdown);
  const sourcesByUrl = new Map<string, CitationSource>();

  for (const match of searchable.matchAll(CITATION_LINK_RE)) {
    const rawTitle = (match[1] ?? "").trim();
    const rawUrl = match[2] ?? "";
    const url = normalizeUrl(rawUrl);
    if (!url) {
      continue;
    }

    const domain = extractDomain(url);
    const title = normalizeTitle(rawTitle, domain);
    const index = match.index ?? 0;
    const existing = sourcesByUrl.get(url);

    if (existing) {
      existing.count += 1;
      existing.occurrences.push({ index, title });
      continue;
    }

    sourcesByUrl.set(url, {
      id: url,
      title,
      url,
      domain,
      count: 1,
      occurrences: [{ index, title }],
    });
  }

  return Array.from(sourcesByUrl.values());
}

export function formatCitationMarkdownReference(
  source: CitationSource,
): string {
  return `[${source.title}](${source.url})`;
}

function normalizeTitle(title: string, domain: string): string {
  const compact = title.replace(/\s+/g, " ").trim();
  if (!compact || GENERIC_CITATION_TITLES.has(compact.toLowerCase())) {
    return domain;
  }
  return compact;
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

// Blanks out code regions so example citations inside code aren't scraped as
// real sources, while preserving string length (and newlines) so occurrence
// indices stay aligned with the original markdown.
export function maskCitationCode(markdown: string): string {
  return maskInlineCode(maskFencedCodeBlocks(markdown));
}

// A fence can be nested in a list item or a blockquote, so its marker may sit
// behind container prefixes and any indentation there. Only the column-0 shape
// was recognised before, and indented fences were blanked by accident because
// whole-document backtick pairing happened to close them.
const FENCE_LINE_RE = /(?:(?:[ \t]*>)|[-+*]|\d{1,9}[.)]|[ \t])*(`{3,}|~{3,})/;

// Inline spans end at a block boundary, not just at a blank line: see
// `inlineSpanStarts` for the shapes and the matching scanner in
// core/messages/utils.ts.
const BLANK_LINE_RE = /^(?:[ \t]*>)*[ \t]*$/;
const ATX_HEADING_RE = /^(?:[ \t]*>)*[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_BREAK_RE =
  /^(?:[ \t]*>)*[ \t]{0,3}(?:(?:=+|-+)[ \t]*|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const INTERRUPTING_LIST_RE = /^(?:[ \t]*>)*[ \t]{0,3}(?:[-+*]|1[.)])[ \t]+\S/;

const INLINE_CODE_SPAN_RE = /(`+)[\s\S]*?\1/g;

function maskFencedCodeBlocks(markdown: string): string {
  // Blank a fenced block from its opener to its matching closer — or, while the
  // message is still streaming, to end of input when the fence is unclosed.
  // Marker-aware like the shared FENCE_MARKER_RE: a closer must repeat the
  // opener character and be at least as long, so a shorter run inside the block
  // does not close it early.
  const lines = markdown.split("\n");
  let openMarker: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const marker = FENCE_LINE_RE.exec(line)?.[1] ?? null;
    if (openMarker === null) {
      if (marker) {
        openMarker = marker;
        lines[i] = maskKeepingNewlines(line);
      }
      continue;
    }
    lines[i] = maskKeepingNewlines(line);
    if (
      marker &&
      marker.startsWith(openMarker.charAt(0)) &&
      marker.length >= openMarker.length
    ) {
      openMarker = null;
    }
  }
  return lines.join("\n");
}

function maskInlineCode(markdown: string): string {
  // Only mask closed spans: an unclosed backtick run renders as literal text,
  // so a citation after it is a real, rendered link and must not be masked.
  // Pairing stays inside one inline span, because a span cannot reach past the
  // block boundary that ends its line; without that limit a stray backtick in
  // an earlier block steals the opener of a later span and mis-pairs both
  // directions. Chunk offsets tile the input, so occurrence indices stay aligned.
  const starts = inlineSpanStarts(markdown);
  if (starts.length === 1) {
    return markdown.replace(INLINE_CODE_SPAN_RE, maskKeepingNewlines);
  }
  return starts
    .map((start, i) =>
      markdown
        .slice(start, starts[i + 1] ?? markdown.length)
        .replace(INLINE_CODE_SPAN_RE, maskKeepingNewlines),
    )
    .join("");
}

// Offsets where a new inline span context starts, mirroring the delimiters the
// reasoning scanner in core/messages/utils.ts applies: blank lines (including a
// blockquote's empty continuation line), ATX headings, thematic breaks / setext
// underlines and interrupting list items. A heading or break ends a span on
// both sides of its own line; a list item only starts a new context, since its
// own wrapped lines continue the span. An ordered item interrupts only when it
// numbers 1, matching CommonMark.
function inlineSpanStarts(markdown: string): number[] {
  const lines = markdown.split("\n");
  const starts: number[] = [0];
  let offset = 0;
  let closesPrevious = false;
  for (const line of lines) {
    const compact = line.endsWith("\r") ? line.slice(0, -1) : line;
    const closes =
      ATX_HEADING_RE.test(compact) || THEMATIC_BREAK_RE.test(compact);
    if (
      closesPrevious ||
      closes ||
      BLANK_LINE_RE.test(compact) ||
      INTERRUPTING_LIST_RE.test(compact)
    ) {
      if (offset > 0 && offset !== starts[starts.length - 1]) {
        starts.push(offset);
      }
    }
    closesPrevious = closes;
    offset += line.length + 1;
  }
  return starts;
}

function maskKeepingNewlines(block: string): string {
  return block.replace(/[^\n]/g, " ");
}
