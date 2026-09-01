import { AppShell } from '@/components/shell/AppShell'
import { ToastProvider } from '@/components/ui/Toast'
import { DevPanel } from '@/mock/DevPanel'
import { MockProvider } from '@/mock/store'

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <MockProvider>
      <ToastProvider>
        <AppShell>{children}</AppShell>
      </ToastProvider>
      <DevPanel />
    </MockProvider>
  )
}
