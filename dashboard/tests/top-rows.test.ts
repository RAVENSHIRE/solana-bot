import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TOP_ROWS, useTop } from '../src/Desk';

function List({ n }: { n: number }) {
  const [rows, more] = useTop(Array.from({ length: n }, (_, i) => `coin ${i + 1}`));
  return createElement(Fragment, null, createElement('ul', null, ...rows.map(r => createElement('li', { key: r }, r))), more);
}

test('lists: the top 3 rows and "+ Show all" for the rest; no button when there is nothing more', () => {
  assert.equal(TOP_ROWS, 3);
  const long = renderToStaticMarkup(createElement(List, { n: 7 }));
  assert.equal((long.match(/<li>/g) ?? []).length, 3);
  assert.match(long, /coin 1.*coin 2.*coin 3/); assert.doesNotMatch(long, /coin 4/);
  assert.match(long, /<button type="button" class="show-all" aria-expanded="false">\+ Show all 7<\/button>/);
  const short = renderToStaticMarkup(createElement(List, { n: 3 }));
  assert.equal((short.match(/<li>/g) ?? []).length, 3); assert.doesNotMatch(short, /show-all/);
});
