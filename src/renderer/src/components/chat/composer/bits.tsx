import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'
import { ChevronDown, Eye, Flame, GitPullRequest, ListChecks, Repeat, Rocket, ShieldCheck, Sparkle, Target, Telescope, Users, Zap, type LucideProps } from 'lucide-react'
import type { WorkMode } from '@shared/types'
import { cn } from '@/lib/util'

export const MODE_ICON: Record<WorkMode, ComponentType<LucideProps>> = {
  chat: Sparkle,
  quick: Zap,
  plan: ListChecks,
  thorough: ShieldCheck,
  council: Users,
  research: Telescope,
  ultra: Rocket,
  gocrazy: Flame,
}

/** The icon for each of the app's own slash commands. */
export const COMMAND_ICON: Record<string, ComponentType<LucideProps>> = {
  goal: Target,
  loop: Repeat,
  plan: ListChecks,
  quick: Zap,
  team: Sparkle,
  verified: ShieldCheck,
  thorough: ShieldCheck,
  council: Users,
  research: Telescope,
  ultra: Rocket,
  gocrazy: Flame,
  github: GitPullRequest,
  watch: Eye,
}

/** A small menu button in the composer, the same size and voice as the model pill. */
export function Pill({
  icon,
  children,
  on,
  chevron = true,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; on?: boolean; chevron?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-[8px] px-1.5 text-[12.5px] whitespace-nowrap transition-colors outline-none focus-visible:shadow-[0_0_0_2px_var(--a2)]',
        on ? 'bg-accent-soft font-medium text-accent hover:bg-[color-mix(in_oklab,var(--a2)_18%,transparent)]' : 'text-ink-3 hover:bg-hover hover:text-ink',
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
      {chevron && <ChevronDown className={cn('size-3 shrink-0', on ? 'opacity-70' : 'text-ink-4')} />}
    </button>
  )
}

/** A one-line text field that sits in a row of pills: a quiet label, then the field. */
export function InlineField({
  label,
  value,
  onChange,
  placeholder,
  onEnter,
  onEscape,
  className,
}: {
  label: string
  value: string
  onChange(v: string): void
  placeholder?: string
  onEnter?(): void
  onEscape?(): void
  className?: string
}) {
  return (
    <label
      className={cn(
        'flex h-7 min-w-0 cursor-text items-center gap-1.5 rounded-[8px] bg-surface-2 px-2.5 text-[12.5px] shadow-[inset_0_0_0_1px_var(--line)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--line-2),0_0_0_3px_color-mix(in_oklab,var(--a2)_16%,transparent)]',
        className,
      )}
    >
      <span className="shrink-0 text-ink-3">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onEnter?.()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onEscape?.()
          }
        }}
        className="selectable min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-4"
      />
    </label>
  )
}
