import { redirect } from 'next/navigation'
import { route } from '@/lib/routes'

// Docs always open on something readable rather than on a table of contents.
export default function Page() {
  redirect(route('/docs/getting-started'))
}
