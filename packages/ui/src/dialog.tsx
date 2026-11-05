'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Modal dialog on the native <dialog> element: focus moves into it, Escape
 * closes it, and the rest of the page is inert while it is open.
 */
export function Dialog({
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
      className="m-auto w-full max-w-md rounded-lg border border-line bg-surface p-5 text-ink shadow-xl backdrop:bg-black/40"
    >
      {open && (
        <>
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="mt-1 text-sm text-ink-muted">
              {description}
            </p>
          )}
          <div className="mt-4">{children}</div>
        </>
      )}
    </dialog>
  );
}
