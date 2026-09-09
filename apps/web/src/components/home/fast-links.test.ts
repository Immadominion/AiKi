import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fastToolAgentHref } from './fast-links'

test('Fast steps link actual external agents to their catalog, not an unindexed passport', () => {
  for (const tool of ['catalog_agent', 'catalog_capabilities', 'read_external_agent'])
    assert.equal(fastToolAgentHref(tool, '45650'), '/catalog/45650')
  assert.equal(fastToolAgentHref('agent_passport', '315943'), '/registry/315943')
  assert.equal(fastToolAgentHref('hire_agent', '315943'), '/registry/315943')
  assert.equal(fastToolAgentHref('catalog_agent', '../secret'), undefined)
  assert.equal(fastToolAgentHref('catalog_agent', undefined), undefined)
})
