/**
 * Talking to AiKi from someone else's LLM.
 *
 * A plain fetch client with one unusual job: it keeps the session cookie that
 * the API issues, because the whole point of this server is that a language
 * model can do the things a person can do on the website, and on the website
 * those things are done as somebody.
 *
 * Errors are turned into their sentences. The API answers a refusal with a
 * reason written for a human — "This mandate has not been signed, so nothing on
 * chain would limit an agent acting on its own" — and that sentence is far more
 * use to a model deciding what to do next than a status code is.
 */

export class AikiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export class AikiClient {
  private cookie: string | null = null

  constructor(readonly baseUrl: string) {}

  get signedIn() {
    return this.cookie !== null
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...init.headers,
      },
    })

    // Keep whatever session the API just handed us. Sign-in is the only route
    // that sets one, but reading it here means the flow does not have to know
    // that.
    const set = res.headers.get('set-cookie')
    if (set?.includes('aiki_session=')) {
      const value = set.split(';')[0]
      if (value) this.cookie = value
    }

    const text = await res.text()
    const body = text ? (JSON.parse(text) as unknown) : null

    if (!res.ok) {
      const shaped = body as { error?: { message?: string; code?: string } } | null
      throw new AikiError(
        shaped?.error?.message ?? `AiKi answered ${res.status}.`,
        shaped?.error?.code ?? 'UNKNOWN',
        res.status,
      )
    }
    return body as T
  }

  get<T>(path: string) {
    return this.request<T>(path)
  }

  post<T>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(headers ? { headers } : {}),
    })
  }

  /** Drops the session without telling the API, for tests. */
  forget() {
    this.cookie = null
  }
}
