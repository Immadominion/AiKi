import { describe, expect, it } from 'vitest'
import { isForbiddenAddress } from './guard.js'

describe('isForbiddenAddress', () => {
  it('rejects loopback, link-local, and private v4', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata, the one that matters most
      '0.0.0.0',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ])
      expect(isForbiddenAddress(ip), ip).toBe(true)
  })

  it('allows ordinary public v4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '172.15.0.1', '172.32.0.1', '9.9.9.9'])
      expect(isForbiddenAddress(ip), ip).toBe(false)
  })

  it('rejects loopback, ULA, link-local, and multicast v6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1'])
      expect(isForbiddenAddress(ip), ip).toBe(true)
  })

  it('unwraps v4-mapped and NAT64 addresses before judging them', () => {
    expect(isForbiddenAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isForbiddenAddress('::ffff:169.254.169.254')).toBe(true)
    expect(isForbiddenAddress('::ffff:1.1.1.1')).toBe(false)
    expect(isForbiddenAddress('64:ff9b::7f00:1')).toBe(true) // 127.0.0.1 behind NAT64
    expect(isForbiddenAddress('64:ff9b::101:101')).toBe(false) // 1.1.1.1 behind NAT64
  })

  it('allows ordinary public v6', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888'])
      expect(isForbiddenAddress(ip), ip).toBe(false)
  })

  it('treats garbage as forbidden', () => {
    for (const ip of ['not-an-ip', '1.2.3', '1:2:3:4:5:6:7:8:9', ''])
      expect(isForbiddenAddress(ip), ip).toBe(true)
  })
})
