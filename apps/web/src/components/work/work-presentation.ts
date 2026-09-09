import type { TaskSummary } from '@/lib/api'

export type WorkFilter = 'all' | 'active' | 'review' | 'completed'
export type WorkPeriod = 'all' | '7' | '30'
export const WORK_STATUS: Record<TaskSummary['status'], string> = {
  OPEN: 'Open',
  CLAIMED: 'In progress',
  SUBMITTED: 'Ready to review',
  SETTLED: 'Paid',
  CANCELLED: 'Cancelled',
  DISPUTED: 'Disputed',
}
export function filterWork(
  tasks: TaskSummary[],
  filter: WorkFilter,
  period: WorkPeriod,
  now = Date.now(),
) {
  return tasks.filter((task) => {
    const statusMatches =
      filter === 'all' ||
      (filter === 'active' && ['OPEN', 'CLAIMED'].includes(task.status)) ||
      (filter === 'review' && task.status === 'SUBMITTED') ||
      (filter === 'completed' && task.status === 'SETTLED')
    return (
      statusMatches &&
      (period === 'all' || Date.parse(task.createdAt) >= now - Number(period) * 86_400_000)
    )
  })
}
export const isPoster = (task: TaskSummary, address: string | null) =>
  Boolean(address && task.poster.toLowerCase() === address.toLowerCase())
export const deadlinePassed = (at?: string, now = Date.now()) =>
  Boolean(at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now)
export function relativeDeadline(at?: string, now = Date.now()): string {
  if (!at || !Number.isFinite(Date.parse(at))) return 'No deadline'
  const remaining = Date.parse(at) - now
  if (remaining <= 0) return 'Deadline passed'
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 60) return `${minutes}m left`
  const hours = Math.ceil(minutes / 60)
  return hours < 48 ? `${hours}h left` : `${Math.ceil(hours / 24)}d left`
}
