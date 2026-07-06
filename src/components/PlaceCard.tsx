interface PlaceCardProps {
  testId: string
  name: string
  category?: string
  rating?: number
  ratingCount?: number
  blurb: string
  photoUrl?: string
}

export function PlaceCard({
  testId,
  name,
  category,
  rating,
  ratingCount,
  blurb,
  photoUrl,
}: PlaceCardProps) {
  return (
    <div
      data-testid={testId}
      className="flex w-56 shrink-0 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white text-left shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      {photoUrl ? (
        <img src={photoUrl} alt={name} className="h-28 w-full object-cover" />
      ) : (
        <div className="h-28 w-full bg-neutral-100 dark:bg-neutral-800" />
      )}
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="text-sm font-semibold text-neutral-900 dark:text-white">
          {name}
        </p>
        {category && (
          <p className="text-xs uppercase text-neutral-500 dark:text-neutral-400">
            {category}
          </p>
        )}
        {rating != null && (
          <p className="text-xs text-neutral-600 dark:text-neutral-300">
            ★ {rating.toFixed(1)} {ratingCount != null && `(${ratingCount})`}
          </p>
        )}
        <p className="text-xs text-neutral-600 dark:text-neutral-300">{blurb}</p>
      </div>
    </div>
  )
}
