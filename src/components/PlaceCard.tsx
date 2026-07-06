interface PlaceCardProps {
  testId: string
  name: string
  category?: string
  rating?: number
  ratingCount?: number
  blurb: string
  photoUrl?: string
  googleMapsUrl?: string
  selected?: boolean
  onTap?: () => void
}

export function PlaceCard({
  testId,
  name,
  category,
  rating,
  ratingCount,
  blurb,
  photoUrl,
  googleMapsUrl,
  selected,
  onTap,
}: PlaceCardProps) {
  return (
    <div
      role={onTap ? 'button' : undefined}
      tabIndex={onTap ? 0 : undefined}
      data-testid={testId}
      aria-pressed={onTap ? selected ?? false : undefined}
      onClick={onTap}
      onKeyDown={(event) => {
        if (onTap && (event.key === 'Enter' || event.key === ' ')) onTap()
      }}
      className={`flex w-56 shrink-0 flex-col overflow-hidden rounded-lg border bg-white text-left shadow-sm dark:bg-neutral-900 ${
        selected
          ? 'border-emerald-600 ring-2 ring-emerald-600'
          : 'border-neutral-200 dark:border-neutral-800'
      }`}
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
        {googleMapsUrl && (
          <a
            data-testid={`${testId}-navigate`}
            href={googleMapsUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="mt-1 text-xs font-medium text-emerald-700 underline dark:text-emerald-400"
          >
            Navigate
          </a>
        )}
      </div>
    </div>
  )
}
