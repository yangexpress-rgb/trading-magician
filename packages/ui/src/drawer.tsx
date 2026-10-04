'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A side panel on the native <dialog> element, for details next to a list:
 * modal, so focus moves into it, Escape closes it and the page behind is inert.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-full max-w-xl overflow-y-auto border-l border-line bg-surface p-5 text-ink shadow-xl backdrop:bg-black/30"
    >
      {open && (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && (
                <div id={descriptionId} className="mt-1 text-sm text-ink-muted">
                  {description}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-2 py-1 text-sm hover:bg-surface-2"
            >
              Close<span className="sr-only"> details</span>
            </button>
          </div>
          <div className="mt-4">{children}</div>
        </>
      )}
    </dialog>
  );
}
