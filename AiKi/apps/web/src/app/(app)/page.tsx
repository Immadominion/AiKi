import { AskPanel } from '@/components/home/AskPanel'

/**
 * Fast mode is the home.
 *
 * It renders inside the app shell rather than owning the route, because full
 * screen is now a state of this surface rather than a separate page. The title
 * comes from the root layout's default, which is already the right one here.
 */
export default function Page() {
  return <AskPanel />
}
