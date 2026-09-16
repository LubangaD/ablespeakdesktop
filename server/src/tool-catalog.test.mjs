/**
 * Tests for the Tools page catalogue. Run with:  node --test src/tool-catalog.test.mjs
 * No external deps — uses node:test + node:assert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from './tool-registry.js';
import { TOOL_CATEGORIES, OTHER_CATEGORY, buildToolCatalog } from './tool-catalog.js';

const registered = new ToolRegistry().listTools();
const catalog = buildToolCatalog(registered);
const find = name => catalog.categories.flatMap(c => c.tools).find(t => t.name === name);

test('every registered tool has a category', () => {
  const other = catalog.categories.find(c => c.name === OTHER_CATEGORY);
  assert.equal(other, undefined,
    `uncategorised: ${other?.tools.map(t => t.name).join(', ')} — add them to TOOL_CATEGORIES`);
});

test('the catalogue lists each registered tool exactly once', () => {
  const names = catalog.categories.flatMap(c => c.tools.map(t => t.name));
  assert.equal(catalog.total, registered.length);
  assert.deepEqual([...names].sort(), registered.map(t => t.name).sort());
});

test('TOOL_CATEGORIES names only tools that exist', () => {
  const known = new Set(registered.map(t => t.name));
  const stale = TOOL_CATEGORIES.flatMap(c => c.tools).filter(name => !known.has(name));
  assert.deepEqual(stale, [], 'a renamed or removed tool is still listed in TOOL_CATEGORIES');
});

test('no tool is listed in two categories', () => {
  const listed = TOOL_CATEGORIES.flatMap(c => c.tools);
  const repeated = listed.filter((name, i) => listed.indexOf(name) !== i);
  assert.deepEqual(repeated, []);
});

test('each entry carries what the Tools page renders', () => {
  const tab = find('create_tab');
  assert.equal(tab.needsExtension, true);
  assert.equal(tab.jsonSchema.name, 'create_tab');
  assert.ok(tab.jsonSchema.description.length > 0);
  assert.deepEqual(tab.jsonSchema.parameters.required, ['url']);

  const app = find('open_application');
  assert.equal(app.needsExtension, false, 'desktop tools work without the Chrome extension');
});

test('a tool missing from TOOL_CATEGORIES still appears, under Other', () => {
  const result = buildToolCatalog([
    { name: 'brand_new_tool', description: 'New', parameters: { type: 'object', properties: {} }, selector: {} },
  ]);
  assert.deepEqual(result.categories.map(c => c.name), [OTHER_CATEGORY]);
  assert.equal(result.categories[0].tools[0].name, 'brand_new_tool');
});

test('a tool with no parameters still gets a schema the page can show', () => {
  const result = buildToolCatalog([{ name: 'answer_question', selector: {} }]);
  const entry = result.categories[0].tools[0];
  assert.deepEqual(entry.jsonSchema.parameters, { type: 'object', properties: {} });
  assert.equal(entry.description, '');
});
