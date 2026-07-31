import { useRef } from 'react'

/**
 * A confirmation step in front of every expensive (full-generation) Claude
 * call this app makes — added 2026-07-30 after a $20 test-usage report and
 * explore mode's own "don't let two people on separate devices accidentally
 * fire this while just poking around" requirement. Deliberately a plain
 * inline panel, not a browser confirm()/native modal — consistent with how
 * every other confirmation-shaped interaction in this app already works
 * (change-request's lock checklist, corridor reconciliation's dry-run
 * preview) and testable the same way.
 */
export function ConfirmGenerateDialog({
  title,
  description,
  confirmLabel,
  submitting,
  onConfirm,
  onCancel,
}: {
  title: string
  description: string
  confirmLabel: string
  submitting: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  // Debounce guard: rapid clicks can fire faster than React re-renders the
  // `disabled` prop above, and faster than whatever async work onConfirm
  // kicks off flips `submitting` back to true — this is the one button in
  // the app that, if double-fired, pays for a second full generation. The
  // ref check + synchronous DOM disable happen in the same tick as the
  // click, before React has a chance to re-render at all.
  const submittingRef = useRef(false)

  function handleConfirm(event: React.MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget
    if (submittingRef.current || button.disabled) return
    submittingRef.current = true
    button.disabled = true
    onConfirm()
  }

  return (
    <div
      data-testid="confirm-generate-dialog"
      className="border-b border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"
    >
      <p className="font-semibold text-amber-900 dark:text-amber-100">{title}</p>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">{description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="confirm-generate-confirm"
          className="btn btn-primary"
          disabled={submitting}
          onClick={handleConfirm}
        >
          {submitting ? 'Starting…' : confirmLabel}
        </button>
        <button
          type="button"
          data-testid="confirm-generate-cancel"
          className="btn btn-secondary"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
