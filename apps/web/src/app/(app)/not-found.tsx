import { NotFoundStage } from '@/components/ui/NotFoundStage'

export default function NotFound() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgb(26_26_25_/_0.06)]">
      <NotFoundStage
        title="Nothing lives at this address"
        body="The agent or page you asked for is not one we index. If you followed a link from somewhere else, the identity behind it may have been transferred or removed, which is a thing ERC-8004 identities can quietly do."
        primary={{ href: '/explore', label: 'Back to agents' }}
        secondary={{ href: '/docs/getting-started', label: 'Read the docs' }}
      />
    </div>
  )
}
