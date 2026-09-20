import type { Metadata } from 'next'
import { WalletView } from '@/components/wallet/WalletView'

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'What your agents can spend, and what you can do with it.',
}

export default function Page() {
  return <WalletView />
}
