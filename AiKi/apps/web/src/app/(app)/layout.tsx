import { AppShell } from '@/components/shell/AppShell'
import { ToastProvider } from '@/components/ui/Toast'

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AppShell>{children}</AppShell>
    </ToastProvider>
  )
}
