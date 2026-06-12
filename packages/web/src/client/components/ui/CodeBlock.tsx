// ---------------------------------------------------------------------------
// CodeBlock — monospace preview with truncation
// ---------------------------------------------------------------------------

interface CodeBlockProps {
  content: string;
  truncated?: boolean;
  maxHeight?: number;
}

export function CodeBlock({
  content,
  truncated = false,
  maxHeight = 240,
}: CodeBlockProps) {
  return (
    <div className="preview-block">
      <pre
        style={{
          maxHeight: truncated ? `${maxHeight}px` : undefined,
          overflow: truncated ? 'auto' : undefined,
        }}
      >
        {content}
      </pre>
      {truncated && content.length > 500 ? (
        <span style={{ fontSize: '11px', color: 'var(--text-t)' }}>
          Content truncated — {content.length} characters total
        </span>
      ) : null}
    </div>
  );
}
