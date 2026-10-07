/**
 * Fenced-code block (R1).
 *
 * Renders the configured highlighter's output (lazy) over a plain-text first
 * paint: the source is shown immediately, then swapped for highlighted HTML
 * once shiki resolves. Unknown languages, a failed load, or a grammar error all
 * keep the plain-text path — the block never throws and never goes blank.
 *
 * A hover/focus-revealed pill carries the language label and a copy button,
 * matching the preview blocks' chrome. `pre > code` is preserved inside the
 * highlighted and plain paths, so existing DOM selectors keep finding code.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "./clipboard";
import { useHighlightedHtml } from "../../lib/markdown/useShiki";

const PLAIN_PRE =
  "m-0 max-w-full overflow-x-auto p-3 font-mono text-xs leading-relaxed whitespace-pre text-[var(--text-base)]";

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const html = useHighlightedHtml(code, lang);
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div
      data-oc-code-block
      className="group relative my-2 max-w-full overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)]"
    >
      {html ? (
        <div
          className="[&_pre]:m-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:bg-transparent [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={PLAIN_PRE}>
          <code className="bg-transparent p-0 break-normal text-inherit">{code}</code>
        </pre>
      )}
      <div className="pointer-events-none absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5 rounded-full border border-[var(--border-weak-base)] bg-[color:var(--surface-float-base)] px-1.5 py-0.5 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        {lang && <span className="px-1 font-mono text-[10px] text-[var(--text-weaker)]">{lang}</span>}
        <button
          type="button"
          onClick={onCopy}
          title="Copy code"
          className="inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-[var(--text-weaker)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>
    </div>
  );
}
