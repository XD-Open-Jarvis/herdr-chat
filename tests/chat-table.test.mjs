import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitMarkdownTables } from '../mods/chat/table.js';

test('pipe tables become separate blocks without changing surrounding markdown', () => {
  const text = 'Before\n\n| Name | Value |\n| :--- | ---: |\n| one | 2 |\n\nAfter';
  const blocks = splitMarkdownTables(text);
  assert.deepEqual(blocks, [
    { md: 'Before\n' },
    { table: { rows: [['Name', 'Value'], ['one', '2']], align: ['left', 'right'] } },
    { md: '\nAfter' },
  ]);
});

test('escaped and inline-code pipes stay inside their cells', () => {
  const blocks = splitMarkdownTables('| A | B |\n| --- | --- |\n| `x|y` | a\\|b |');
  assert.deepEqual(blocks[0].table.rows[1], ['`x|y`', 'a\\|b']);
});

test('ordinary pipes without a separator row remain markdown', () => {
  assert.deepEqual(splitMarkdownTables('a | b\njust text'), [{ md: 'a | b\njust text' }]);
});
