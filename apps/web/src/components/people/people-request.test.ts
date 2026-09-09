import assert from 'node:assert/strict'
import { test } from 'node:test'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { PersonRequestAction } from './People'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

test('People signs in before opening a brief that account restoration would otherwise erase', async () => {
  let renderer: ReactTestRenderer | undefined
  let signedIn = 0
  let opened = 0
  const props = {
    ownListing: false,
    authenticated: false,
    connecting: false,
    onSignIn: () => signedIn++,
    onRequest: () => opened++,
  }
  try {
    await act(async () => {
      renderer = create(createElement(PersonRequestAction, props))
    })
    const button = () => renderer?.root.findByType('button')
    assert.deepEqual(button()?.children, ['Sign in to request work'])
    await act(async () => button()?.props.onClick())
    assert.equal(signedIn, 1)
    assert.equal(opened, 0)

    await act(async () =>
      renderer?.update(createElement(PersonRequestAction, { ...props, connecting: true })),
    )
    assert.equal(button()?.props.disabled, true)
    assert.deepEqual(button()?.children, ['Signing in…'])

    await act(async () =>
      renderer?.update(createElement(PersonRequestAction, { ...props, authenticated: true })),
    )
    await act(async () => button()?.props.onClick())
    assert.equal(signedIn, 1)
    assert.equal(opened, 1)

    await act(async () =>
      renderer?.update(
        createElement(PersonRequestAction, { ...props, authenticated: true, ownListing: true }),
      ),
    )
    assert.equal(button()?.props.disabled, true)
    assert.deepEqual(button()?.children, ['Your listing'])
  } finally {
    await act(async () => renderer?.unmount())
  }
})
