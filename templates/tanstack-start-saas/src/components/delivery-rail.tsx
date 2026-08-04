import * as React from 'react'
import { cn } from '~/lib/utils'

export type DeliveryStep = {
  id: string
  label: string
  description?: string
  status: 'completed' | 'current' | 'upcoming'
}

export interface DeliveryRailProps {
  steps?: DeliveryStep[]
  activeStepId?: string
  onStepSelect?: (stepId: string) => void
  className?: string
}

const DEFAULT_STEPS: DeliveryStep[] = [
  { id: 'brief', label: 'Brief received', description: 'Requirements & assets collected', status: 'completed' },
  { id: 'production', label: 'In production', description: 'Active design & build iteration', status: 'current' },
  { id: 'review', label: 'Client review', description: 'Feedback & proof approval', status: 'upcoming' },
  { id: 'send', label: 'Ready to send', description: 'Final handoff & delivery', status: 'upcoming' },
]

export function DeliveryRail({
  steps = DEFAULT_STEPS,
  activeStepId,
  onStepSelect,
  className,
}: DeliveryRailProps) {
  return (
    <div className={cn('flex flex-col space-y-4 p-4 rounded-[10px] bg-[#DCEBDD]/40 border border-[#17211B]/10', className)}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#17211B]/70">
          LIVE DELIVERY RAIL
        </span>
        <span className="inline-flex items-center rounded-full bg-[#315CF5]/10 px-2 py-0.5 text-xs font-medium text-[#315CF5]">
          Active
        </span>
      </div>

      <div className="relative pl-6 space-y-6 before:absolute before:left-[9px] before:top-2 before:bottom-2 before:w-[2px] before:bg-[#17211B]/20">
        {steps.map((step) => {
          const isSelected = activeStepId === step.id
          const isCompleted = step.status === 'completed'
          const isCurrent = step.status === 'current'

          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onStepSelect?.(step.id)}
              className={cn(
                'group relative flex flex-col text-left transition-all w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#315CF5] rounded-md p-1 -ml-1',
                isSelected && 'bg-[#DCEBDD] shadow-xs'
              )}
            >
              <span
                className={cn(
                  'absolute -left-[20px] top-1 h-3.5 w-3.5 rounded-full border-2 transition-colors',
                  isCompleted && 'border-[#17211B] bg-[#17211B]',
                  isCurrent && 'border-[#315CF5] bg-[#315CF5] ring-4 ring-[#315CF5]/20',
                  step.status === 'upcoming' && 'border-[#17211B]/40 bg-[#F6F3E9]'
                )}
              />
              <span
                className={cn(
                  'font-medium text-sm transition-colors',
                  isCurrent ? 'text-[#315CF5] font-semibold' : 'text-[#17211B]',
                  isSelected && 'text-[#17211B] font-bold'
                )}
              >
                {step.label}
              </span>
              {step.description && (
                <span className="text-xs text-[#17211B]/60 mt-0.5">
                  {step.description}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
