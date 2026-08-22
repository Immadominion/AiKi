import { AskStage } from '@/components/home/AskStage'
import { ToastProvider } from '@/components/ui/Toast'

export default function Page() {
  return (
    <ToastProvider bottom={56}>
      <AskStage />
    </ToastProvider>
  )
}
