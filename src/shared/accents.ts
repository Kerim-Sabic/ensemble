import type { AccentKey } from './types'

/** Each teammate has a colour. These are the two stops of its orb. */
export const ACCENT: Record<AccentKey, { from: string; to: string; label: string }> = {
  clay: { from: '#FFB892', to: '#DE5B36', label: 'Clay' },
  violet: { from: '#C9B8FF', to: '#6A4AE8', label: 'Violet' },
  teal: { from: '#86F2DF', to: '#0C988C', label: 'Teal' },
  blue: { from: '#9CCBFF', to: '#2B68F2', label: 'Blue' },
  amber: { from: '#FFE291', to: '#E58E09', label: 'Amber' },
  rose: { from: '#FFB8C6', to: '#DE2360', label: 'Rose' },
  green: { from: '#A3F2BF', to: '#15A04A', label: 'Green' },
  slate: { from: '#D8DFE9', to: '#62728A', label: 'Slate' },
}
