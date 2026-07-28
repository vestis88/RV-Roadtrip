import type { ReactNode } from 'react'

interface CardRowProps {
  title: string
  testId: string
  children: ReactNode
  /** Rendered below the horizontal scroller, e.g. a "show skipped" toggle. */
  footer?: ReactNode
}

export function CardRow({ title, testId, children, footer }: CardRowProps) {
  return (
    <div
      className="surface mt-4 border-y border-neutral-200 py-3 dark:border-neutral-800"
      data-testid={testId}
    >
      <h3 className="mb-2 px-4 text-sm font-semibold tracking-tight text-neutral-800 dark:text-neutral-200">
        {title}
      </h3>
      <div className="flex gap-3 overflow-x-auto px-4 pb-1">{children}</div>
      {footer && <div className="mt-1 px-4">{footer}</div>}
    </div>
  )
}
