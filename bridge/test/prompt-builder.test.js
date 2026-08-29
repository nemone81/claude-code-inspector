const { test } = require('node:test');
const assert = require('node:assert');
const { buildMessage, describeElement } = require('../../extension/lib/prompt-builder');

const element = {
  tag: 'button',
  id: 'cta',
  classes: ['btn', 'btn-primary'],
  selector: '#cta',
  html: '<button id="cta" class="btn btn-primary">Buy</button>',
  dimensions: { width: 120, height: 40 },
  styles: { fontSize: '14px', color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(204, 120, 92)' },
  pageUrl: 'http://localhost:5173/',
};

test('plain prompt without elements is passed through', () => {
  assert.equal(buildMessage('Fix the header', []), 'Fix the header');
});

test('single element: all sections present', () => {
  const msg = buildMessage('Make it bigger', [element]);
  assert.match(msg, /^Make it bigger/);
  assert.match(msg, /SELECTED ELEMENT:/);
  assert.match(msg, /Tag: <button>/);
  assert.match(msg, /CSS selector: #cta/);
  assert.match(msg, /Classes: btn, btn-primary/);
  assert.match(msg, /Page: http:\/\/localhost:5173\//);
  assert.doesNotMatch(msg, /ELEMENT 1 of/, 'single element has no numbering');
});

test('multiple elements are numbered', () => {
  const msg = buildMessage('Align these', [element, { ...element, id: null, selector: '.btn2' }]);
  assert.match(msg, /SELECTED ELEMENT 1 of 2:/);
  assert.match(msg, /SELECTED ELEMENT 2 of 2:/);
});

test('source info from dev builds is included', () => {
  const withSource = {
    ...element,
    source: { framework: 'React', fileName: 'src/components/Cta.jsx', lineNumber: 42, componentName: 'Cta' },
  };
  const msg = describeElement(withSource, 0, 1);
  assert.match(msg, /Source file \(from React dev build\): src\/components\/Cta\.jsx:42/);
  assert.match(msg, /Component: Cta/);
});

test('explain mode appends the read-only instruction', () => {
  const msg = buildMessage('What is this?', [element], { mode: 'explain' });
  assert.match(msg, /read-only request: explain, do not modify any file/);
});

test('screenshot note only when screenshots are attached', () => {
  assert.match(buildMessage('x', [element], { hasScreenshots: true }), /screenshot of the selected element is attached/);
  assert.doesNotMatch(buildMessage('x', [element], {}), /screenshot/);
});

test('long HTML is truncated to 800 chars', () => {
  const long = { ...element, html: '<div>' + 'a'.repeat(2000) + '</div>' };
  const msg = describeElement(long, 0, 1);
  const htmlPart = msg.split('HTML:\n')[1];
  assert.ok(htmlPart.length <= 800);
});
