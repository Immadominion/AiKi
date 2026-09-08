/**
 * One definition of what the six demo agents are, for every surface that shows them.
 *
 * This exists because the disclosure was written once, inline, on the Explore page,
 * and three other surfaces kept rendering the same six agents underneath the opposite
 * sentence: "Every agent here is tested by AiKi itself." They are not tested. They are
 * not in the registry. AiKi has never probed them, and their check counts are invented
 * so the hiring flow can be walked before a real agent publishes enough to be hired.
 *
 * An invented check count sitting unlabelled beside a measured one makes both
 * meaningless, and this product has no second asset if its numbers stop meaning
 * something. So the claim lives here, once, and every surface imports it.
 */

/** The banner. Takes the action rather than a router, so it stays free of Next. */
export const exampleBanner = (onAction: () => void) => ({
  title: 'These six agents are examples.',
  body: 'AiKi has not probed them and they are not in the ERC-8004 registry. Matching an ask to an agent means knowing what that agent can do, and almost no registry entry publishes it yet, so this page shows the shape of the answer rather than a measured one.',
  cta: 'See what we measured',
  onAction,
})

/**
 * For surfaces that show the six as cards or rows without room for the banner.
 * Shorter, and it still refuses to call any of it a measurement.
 */
export const EXAMPLE_FOOTNOTE =
  'These six agents are examples. AiKi has not probed them, so the bars are illustrative rather than measured. The registry page carries what we actually tested.'

/**
 * The column that carries those bars. It may not say AiKi collected them, because
 * on every surface that uses this dataset, AiKi did not.
 */
export const EXAMPLE_EVIDENCE_COLUMN = 'Evidence shown'
