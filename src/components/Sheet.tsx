import { useEffect, type ReactNode } from 'react'
import { IconClose } from './Icons'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  flush?: boolean
  /** Rendered to the left of the title, e.g. a back button inside a flow. */
  lead?: ReactNode
}

/**
 * Bottom sheet. Everything that writes data happens in one of these rather
 * than on its own route: it keeps the underlying screen in place, so saving an
 * entry never costs a page load.
 */
export function Sheet({ title, onClose, children, footer, flush, lead }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)

    // Stop the page behind the sheet scrolling under a drag.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="sheet">
        <div className="sheet-head">
          {lead}
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className={flush ? 'sheet-body flush' : 'sheet-body'}>{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  )
}
