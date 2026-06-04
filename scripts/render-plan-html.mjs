import fs from "node:fs";
import path from "node:path";

const [sourcePath, outputPath] = process.argv.slice(2);

if (!sourcePath || !outputPath) {
  console.error("Usage: node scripts/render-plan-html.mjs <source.md> <output.html>");
  process.exit(1);
}

const source = fs.readFileSync(sourcePath, "utf8");
const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Donkey Plan";
const sourceRelative = path.relative(process.cwd(), sourcePath);

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInline(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    return `<a href="${escapeHtml(href)}">${label}</a>`;
  });
  return text;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(lines, startIndex) {
  const header = parseTableRow(lines[startIndex]);
  let index = startIndex + 2;
  const rows = [];

  while (index < lines.length && /^\s*\|/.test(lines[index]) && lines[index].trim() !== "") {
    rows.push(parseTableRow(lines[index]));
    index += 1;
  }

  const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("\n");

  return {
    html: `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`,
    nextIndex: index,
  };
}

function closeList(state, html) {
  if (state.listType) {
    html.push(`</${state.listType}>`);
    state.listType = null;
  }
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  const state = { listType: null };
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === "") {
      closeList(state, html);
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (fence) {
      closeList(state, html);
      const lang = fence[1] ?? "";
      const block = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        block.push(lines[index]);
        index += 1;
      }
      index += 1;

      if (lang === "mermaid") {
        html.push(`<div class="diagram"><div class="mermaid">\n${escapeHtml(block.join("\n"))}\n</div></div>`);
      } else {
        html.push(`<pre><code>${escapeHtml(block.join("\n"))}</code></pre>`);
      }
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      closeList(state, html);
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*\|/.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      closeList(state, html);
      const rendered = renderTable(lines, index);
      html.push(rendered.html);
      index = rendered.nextIndex;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList(state, html);
      const level = heading[1].length;
      const content = renderInline(heading[2]);
      const id = heading[2]
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-|-$/g, "");
      html.push(`<h${level} id="${id}">${content}</h${level}>`);
      index += 1;
      continue;
    }

    const unordered = trimmed.match(/^-\s+(.+)$/);
    if (unordered) {
      if (state.listType !== "ul") {
        closeList(state, html);
        state.listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${renderInline(unordered[1])}</li>`);
      index += 1;
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (state.listType !== "ol") {
        closeList(state, html);
        state.listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`);
      index += 1;
      continue;
    }

    closeList(state, html);
    html.push(`<p>${renderInline(trimmed)}</p>`);
    index += 1;
  }

  closeList(state, html);
  return html.join("\n");
}

const body = renderMarkdown(source);
const renderedAt = new Date().toISOString().slice(0, 10);
const hasMermaid = body.includes('class="mermaid"');
const mermaidScript = hasMermaid
  ? `  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, securityLevel: "strict", theme: "default" });
  </script>
`
  : "";

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --text: #172033;
      --muted: #586174;
      --line: #dfe5f2;
      --panel: #f7f9fd;
      --accent: #2457e6;
      --accent-soft: #eef4ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #ffffff;
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      line-height: 1.68;
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 44px 28px 72px;
    }
    .doc-meta {
      margin: 0 0 28px;
      padding: 14px 16px;
      border: 1px solid #cfddff;
      border-radius: 8px;
      background: var(--accent-soft);
      color: #23365f;
      font-size: 14px;
    }
    h1, h2, h3, h4 {
      line-height: 1.28;
      letter-spacing: 0;
    }
    h1 {
      margin: 0 0 18px;
      padding-bottom: 16px;
      border-bottom: 2px solid var(--line);
      font-size: 32px;
    }
    h2 {
      margin: 38px 0 14px;
      padding-left: 12px;
      border-left: 4px solid var(--accent);
      font-size: 24px;
    }
    h3 { margin: 28px 0 10px; font-size: 19px; }
    h4 { margin: 22px 0 8px; font-size: 16px; }
    p { margin: 10px 0; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      padding: 1px 5px;
      border-radius: 4px;
      background: #eef2f8;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
    }
    pre {
      overflow: auto;
      padding: 16px;
      border-radius: 8px;
      background: #101827;
      color: #edf3ff;
    }
    pre code { background: transparent; color: inherit; padding: 0; }
    ul, ol { padding-left: 26px; }
    li { margin: 5px 0; }
    table {
      width: 100%;
      margin: 16px 0 22px;
      border-collapse: collapse;
      table-layout: auto;
      font-size: 14px;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 9px 10px;
      vertical-align: top;
    }
    th {
      background: var(--panel);
      text-align: left;
      font-weight: 650;
    }
    tr:nth-child(even) td { background: #fbfcff; }
    hr {
      margin: 30px 0;
      border: 0;
      border-top: 1px solid var(--line);
    }
    .diagram {
      margin: 18px 0 24px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      overflow: auto;
    }
    .mermaid { min-width: 720px; }
    @media (max-width: 760px) {
      main { padding: 28px 18px 52px; }
      h1 { font-size: 26px; }
      h2 { font-size: 21px; }
      table { display: block; overflow-x: auto; white-space: nowrap; }
      .mermaid { min-width: 620px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="doc-meta">本 HTML 由 <code>${escapeHtml(sourceRelative)}</code> 生成，用于人类审阅；源稿仍以 Markdown 文件为准。生成日期：${renderedAt}。</div>
${body}
  </main>
${mermaidScript}
</body>
</html>
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html);
