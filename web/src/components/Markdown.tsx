// Tiny, dependency-free Markdown renderer for the evidence ledger panel.
// Supports headings, bold, inline code, lists, tables, hr, and paragraphs.
// The ledger is produced server-side by _shared/ledger (sanitized against
// HTML/MD injection), so we render it into a scoped .md-body container.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s: string): string {
  let out = escapeHtml(s);
  // inline code
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // links [text](url) — render as text (url) to avoid unexpected navigation
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  return out;
}

function renderTableRows(rows: string[]): string {
  // rows[0] header, rows[1] separator, rest body
  const cells = (line: string) =>
    line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const thead = `<thead><tr>${header
    .map((c) => `<th>${inline(c)}</th>`)
    .join("")}</tr></thead>`;
  const tbody = `<tbody>${body
    .map(
      (r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`
    )
    .join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function toHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // table block
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[-: |]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const block: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      html.push(renderTableRows(block));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*])\s+/.test(line)) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      i++;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      closeList();
      html.push("<hr />");
      i++;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    closeList();
    html.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  return html.join("\n");
}

export function Markdown({ source }: { source: string }) {
  return (
    <div
      className="md-body"
      // Source is server-sanitized; renderer also escapes raw HTML above.
      dangerouslySetInnerHTML={{ __html: toHtml(source) }}
    />
  );
}
