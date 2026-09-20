/**
 * The settings sections, shared by the route and the view.
 *
 * They live outside the client component because the route file needs the real
 * array to prerender one page per tab, and importing a value across the client
 * boundary hands back a reference to the module rather than the array itself.
 */
export const TAB_KEYS = ['wallet', 'points', 'notifications', 'mode', 'api', 'data'] as const
export type SettingsTab = (typeof TAB_KEYS)[number]
export const isSettingsTab = (v: string): v is SettingsTab =>
  (TAB_KEYS as readonly string[]).includes(v)
export const TAB_LABELS: Record<SettingsTab, string> = {
  wallet: 'Wallet',
  points: 'Points',
  notifications: 'Notifications',
  mode: 'Mode',
  api: 'Evidence API',
  data: 'What we keep',
}
