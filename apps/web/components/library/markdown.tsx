import { parseMarkdown, type MdInline } from '@tm/domain';
import { Fragment } from 'react';

/**
 * Renders Strategy Library prose (a small Markdown subset) as React elements;
 * user text is never set as HTML.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={className ?? 'space-y-2 text-sm leading-relaxed'}>
      {parseMarkdown(source).map((block, i) =>
        block.kind === 'paragraph' ? (
          <p key={i}>
            <Inlines inlines={block.inlines} />
          </p>
        ) : block.ordered ? (
          <ol key={i} className="list-decimal space-y-1 pl-5">
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines inlines={item} />
              </li>
            ))}
          </ol>
        ) : (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines inlines={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

function Inlines({ inlines }: { inlines: MdInline[] }) {
  return (
    <>
      {inlines.map((n, i) => {
        switch (n.kind) {
          case 'strong':
            return <strong key={i}>{n.text}</strong>;
          case 'em':
            return <em key={i}>{n.text}</em>;
          case 'code':
            return (
              <code key={i} className="rounded bg-surface-2 px-1 text-[0.9em]">
                {n.text}
              </code>
            );
          case 'link':
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
                {n.text}
              </a>
            );
          default:
            return <Fragment key={i}>{n.text}</Fragment>;
        }
      })}
    </>
  );
}
