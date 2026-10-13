import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixedDocument } from './fixtures.mjs';
import { validateDocument, validateState } from './protocol.mjs';

test('four fixed learning topics share a bounded component protocol', () => {
  for (const topic of ['kmp', 'quicksort', 'attention', 'bellman']) {
    const document = createFixedDocument(topic);
    assert.equal(validateDocument(document), document, topic);
    assert.ok(validateState(document, document.initialState), topic);
    assert.ok(document.nodes.some(node => ['DiscreteSlider', 'DragHandle'].includes(node.type)), topic);
    assert.ok(document.nodes.some(node => node.type === 'ChoiceFeedback'), topic);
  }
});

test('component protocol rejects executable content, unknown nodes, bad state and oversized data', () => {
  const document = createFixedDocument('kmp');
  assert.equal(validateState(document, { offset: 2 }), true);
  assert.equal(validateState(document, { offset: 3 }), false);
  assert.equal(validateState(document, { offset: 1, script: 1 }), false);
  assert.throws(() => validateDocument({ ...document, nodes: [...document.nodes, { id: 'evil', type: 'Script', props: { code: 'alert(1)' } }] }), /未知组件/);
  assert.throws(() => validateDocument({ ...document, nodes: [{ ...document.nodes[0], props: { ...document.nodes[0].props, html: '<script></script>' } }, ...document.nodes.slice(1)] }), /字符轨道/);
  assert.throws(() => validateDocument({ ...document, title: 'x'.repeat(40000) }), /标题|大小/);
});

test('fixed numeric examples preserve their teaching claims', () => {
  const kmp = createFixedDocument('kmp');
  const known = kmp.nodes.find(node => node.type === 'StringTracks').props.knownByState;
  assert.deepEqual(known, { 0: 4, 1: 0, 2: 2 });
  const attention = createFixedDocument('attention');
  const bars = attention.nodes.find(node => node.type === 'Plot').props.valuesByState;
  assert.ok(bars[1][1].value > bars[3][1].value);
  for (const setting of [1, 2, 3]) assert.ok(Math.abs(bars[setting].reduce((sum, item) => sum + item.value, 0) - 1) < 0.002);
  const bellman = createFixedDocument('bellman');
  const targets = bellman.nodes.find(node => node.type === 'Plot').props.valuesByState;
  for (let n = 0; n <= 10; n++) assert.ok(Math.abs(targets[n][2].value - (1 + n / 10 * 4)) < 1e-9);
  const quicksort = createFixedDocument('quicksort');
  const values = quicksort.nodes.find(node => node.type === 'ArrayTrack').props.values;
  assert.deepEqual([...values].sort((a, b) => a - b), [2, 3, 5, 7, 9]);
  assert.ok(values.slice(0, 2).every(value => value < 5) && values.slice(2, 4).every(value => value > 5));
});
