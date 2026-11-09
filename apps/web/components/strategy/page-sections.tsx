import { cx } from '@tm/ui';
import type { ReactNode } from 'react';

/**
 * The strategy page's three parts (N171, ADR 0062): what the strategy is, how
 * it back tested, and running it on paper. Every card sits in exactly one.
 */
export const PAGE_SECTIONS = [
  { n: 1, id: 'strategy', title: 'Strategy' },
  { n: 2, id: 'back-test', title: 'Back test' },
  { n: 3, id: 'execution', title: 'Execution' },
] as const;

export type PageSectionId = (typeof PAGE_SECTIONS)[number]['id'];

const TONE: Record<1 | 2 | 3, { border: string; text: string; dot: string }> = {
  1: { border: 'border-t-sec-1', text: 'text-sec-1', dot: 'bg-sec-1' },
  2: { border: 'border-t-sec-2', text: 'text-sec-2', dot: 'bg-sec-2' },
  3: { border: 'border-t-sec-3', text: 'text-sec-3', dot: 'bg-sec-3' },
};

function SectionNumber({ n, small = false }: { n: 1 | 2 | 3; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-grid shrink-0 place-items-center rounded-full font-bold text-surface',
        small ? 'size-5 text-[0.7rem]' : 'size-7 text-sm',
        TONE[n].dot,
      )}
    >
      {n}
    </span>
  );
}

/** One numbered section: a large heading, one line on what it holds, then its cards. */
export function PageSection({
  id,
  description,
  badge,
  children,
}: {
  id: PageSectionId;
  description: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const section = PAGE_SECTIONS.find((s) => s.id === id) ?? PAGE_SECTIONS[0];
  const headingId = `${id}-section-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cx('scroll-mt-16 space-y-6 border-t-4 pt-3', TONE[section.n].border)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SectionNumber n={section.n} />
        <h2 id={headingId} className={cx('text-2xl font-semibold', TONE[section.n].text)}>
          {section.title}
        </h2>
        {badge}
        <p className="basis-full text-sm text-ink-muted sm:basis-auto">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** Jump links in the sticky save bar (N172): one per section, each with its state. */
export function SectionNav({ states }: { states: Record<PageSectionId, string> }) {
  return (
    <nav aria-label="Sections" className="flex flex-wrap gap-1.5">
      {PAGE_SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pr-2.5 pl-0.5 text-xs font-semibold text-ink no-underline hover:border-ink-muted"
        >
          <SectionNumber n={s.n} small />
          {s.title}
          <span className="font-normal text-ink-muted">· {states[s.id]}</span>
        </a>
      ))}
    </nav>
  );
}
