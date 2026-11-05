const ORIGIN = 'https://aiki-web.vercel.app'

export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/foreguild' && !url.pathname.startsWith('/foreguild/')) {
      return new Response('Not found', { status: 404 })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      })
    }
    const upstream = new URL(url.pathname + url.search, ORIGIN)
    const headers = new Headers()
    for (const name of ['accept', 'range', 'if-none-match', 'if-modified-since']) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      redirect: 'manual',
    })
    const outgoing = new Response(response.body, response)
    outgoing.headers.delete('set-cookie')
    outgoing.headers.set('X-Content-Type-Options', 'nosniff')
    return outgoing
  },
}
