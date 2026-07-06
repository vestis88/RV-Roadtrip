import type { ReactNode } from 'react'

interface CardRowProps {
  title: string
  testId: string
  children: ReactNode
}

export function CardRow({ title, testId, children }: CardRowProps) {
  return (
    <div className="mt-4" data-testid={testId}>
      <h3 className="mb-2 px-4 text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {title}
      </h3>
      <div className="flex gap-3 overflow-x-auto px-4 pb-2">{children}</div>
    </div>
  )
}
