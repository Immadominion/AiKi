/**
 * The one thing the tool modules need from the server.
 *
 * Narrowed to a single method on purpose: a tool module that could reach the
 * whole server could also reach the transport, and these are meant to be
 * testable by handing them a recorder.
 */
export interface Registrar {
  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: Record<string, unknown> },
    handler: (args: never) => Promise<{ content: { type: 'text'; text: string }[] }>,
  ): unknown
}
