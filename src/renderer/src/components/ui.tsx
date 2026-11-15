import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Dialog, DropdownMenu, Switch, Tooltip } from 'radix-ui'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/util'

// ───────────── buttons ─────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'
type Size = 'sm' | 'md' | 'lg'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-inverse hover:opacity-88 active:opacity-80 shadow-[0_1px_2px_rgba(0,0,0,0.18)]',
  secondary: 'bg-surface text-ink shadow-card hover:bg-surface-2 active:bg-surface-3',
  soft: 'bg-hover text-ink hover:bg-active',
  ghost: 'text-ink-2 hover:bg-hover hover:text-ink active:bg-active',
  danger: 'text-bad hover:bg-bad-soft',
}
const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12.5px] rounded-[8px] gap-1.5',
  md: 'h-8 px-3 text-[13px] rounded-[9px] gap-2',
  lg: 'h-10 px-4 text-[14px] rounded-[11px] gap-2',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      {...rest}
      className={cn(
        'no-drag inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[background,opacity,color,transform] duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-40',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    >
      {children}
    </button>
  )
}

export function IconButton({
  label,
  kbd,
  className,
  children,
  side,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; kbd?: string; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tip label={label} kbd={kbd} side={side}>
      <button
        {...rest}
        aria-label={label}
        className={cn(
          'no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink active:bg-active disabled:pointer-events-none disabled:opacity-40',
          className,
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

// ───────────── small pieces ─────────────

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn('rounded-[5px] border border-line bg-surface-2 px-1.5 py-px font-sans text-[10.5px] font-medium text-ink-3', className)}>
      {children}
    </kbd>
  )
}

export function Tip({ label, kbd, side = 'bottom', children }: { label: ReactNode; kbd?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          className="z-[80] flex max-w-[280px] animate-fade-in items-center gap-2 rounded-[7px] bg-ink px-2 py-1 text-[11.5px] font-medium text-inverse shadow-[0_4px_14px_rgba(0,0,0,0.22)]"
        >
          {label}
          {kbd && <span className="opacity-55">{kbd}</span>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="no-drag relative h-[20px] w-[34px] shrink-0 rounded-full bg-line-2 transition-colors duration-200 data-[state=checked]:bg-ok"
    >
      <Switch.Thumb className="block size-[16px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-200 ease-out data-[state=checked]:translate-x-[16px]" />
    </Switch.Root>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange(v: T): void
  options: { value: T; label: ReactNode; badge?: number }[]
  className?: string
}) {
  return (
    <div className={cn('no-drag inline-flex h-7 items-center gap-0.5 rounded-[9px] bg-hover p-0.5', className)} role="tablist">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative inline-flex h-6 items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-medium transition-all duration-150',
              on ? 'bg-surface text-ink shadow-[0_0_0_0.5px_var(--line-2),0_1px_2px_rgba(0,0,0,0.08)]' : 'text-ink-2 hover:text-ink',
            )}
          >
            {o.label}
            {!!o.badge && <span className="tabular rounded-full bg-active px-1.5 text-[10.5px] leading-[15px] text-ink-2">{o.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-3.5 animate-spin text-ink-3', className)} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// ───────────── menus ─────────────

export function Menu({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  width,
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  width?: number
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={10}
          style={{ minWidth: width || 200 }}
          className="no-drag z-[70] max-h-[70vh] animate-pop overflow-y-auto rounded-[12px] bg-raised p-1 shadow-pop outline-none"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function MenuItem({
  icon,
  children,
  hint,
  checked,
  danger,
  onSelect,
  disabled,
}: {
  icon?: ReactNode
  children: ReactNode
  hint?: ReactNode
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onSelect?(): void
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={() => onSelect?.()}
      className={cn(
        'flex min-h-8 items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-[13px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover',
        danger ? 'text-bad' : 'text-ink',
      )}
    >
      {icon && <span className={cn('flex size-4 items-center justify-center', danger ? 'text-bad' : 'text-ink-3')}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint && <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-3">{hint}</span>}
      </span>
      {checked && <Check className="size-3.5 text-ink-2" strokeWidth={2.4} />}
    </DropdownMenu.Item>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-ink-3">{children}</DropdownMenu.Label>
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
}

// ───────────── dialog ─────────────

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = 520,
  bare,
}: {
  open: boolean
  onClose(): void
  title: string
  description?: string
  children: ReactNode
  width?: number
  /** No header: the content draws its own. */
  bare?: boolean
}) {
  // Window drag regions swallow clicks even under an overlay, so they are
  // switched off while a dialog is up.
  useEffect(() => {
    if (!open) return
    document.documentElement.dataset.modal = 'true'
    return () => {
      delete document.documentElement.dataset.modal
    }
  }, [open])

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/22 backdrop-blur-[3px] dark:bg-black/50" />
        <Dialog.Content
          style={{ width }}
          // Opening should not light up whichever control happens to come first.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).focus()
          }}
          tabIndex={-1}
          className="no-drag fixed top-1/2 left-1/2 z-[60] flex max-h-[86vh] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 animate-pop flex-col overflow-hidden rounded-[18px] bg-raised shadow-pop outline-none"
        >
          {bare ? (
            <>
              <Dialog.Title className="sr-only">{title}</Dialog.Title>
              <Dialog.Description className="sr-only">{description || title}</Dialog.Description>
            </>
          ) : (
            <div className="flex items-start gap-3 px-6 pt-5 pb-1">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-[16px] font-semibold tracking-[-0.01em]">{title}</Dialog.Title>
                <Dialog.Description className={cn('mt-1 text-[13px] leading-relaxed text-ink-2', !description && 'sr-only')}>{description || title}</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button aria-label="Close" className="-mr-2 flex size-7 items-center justify-center rounded-[8px] text-ink-3 hover:bg-hover hover:text-ink">
                  <X className="size-4" />
                </button>
              </Dialog.Close>
            </div>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export const inputClass =
  'no-drag h-9 w-full rounded-[10px] bg-surface-2 px-3 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-shadow placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--line-2),0_0_0_3px_color-mix(in_oklab,var(--link)_18%,transparent)] selectable'
