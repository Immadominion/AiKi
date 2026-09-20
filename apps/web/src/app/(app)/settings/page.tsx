import { redirect } from 'next/navigation'
import { route } from '@/lib/routes'

/** Settings has no front page of its own; the wallet is what people come for. */
export default function Page() {
  redirect(route('/settings/wallet'))
}
