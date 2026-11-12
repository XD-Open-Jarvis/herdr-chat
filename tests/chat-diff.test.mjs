import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const {diffLines,diffGroups}=await import('data:text/javascript;base64,'+Buffer.from(readFileSync(new URL('../mods/chat/diff.js',import.meta.url),'utf8')).toString('base64'));
test('recorded patch becomes a unified diff with distinctly classified headers and changes',()=>{
 const lines=diffLines({path:'src/main.js',operation:'update',diff:'@@ -4,2 +4,2 @@\n context\n-old\n+new'});
 assert.deepEqual(lines.slice(0,3).map(line=>line.text),['diff --git a/src/main.js b/src/main.js','--- a/src/main.js','+++ b/src/main.js']);
 assert.deepEqual(lines.map(line=>line.kind),['header','header','header','hunk','context','removed','added']);
});
test('missing historical line numbers are not fabricated for replacement fragments',()=>{
 const lines=diffLines({path:'a.js',operation:'update',diff:'-old\n+new'});
 assert.equal(lines[3].text,'@@');assert.equal(lines.filter(line=>line.kind==='hunk').length,1);
});
test('new and deleted files use dev null without inventing unrecorded deleted contents',()=>{
 const added=diffLines({path:'new.js',operation:'add',diff:'+one\n+two'});
 assert.equal(added[1].text,'--- /dev/null');assert.equal(added[3].text,'@@ -0,0 +1,2 @@');
 const removed=diffLines({path:'old.js',operation:'delete',diff:''});
 assert.equal(removed[2].text,'+++ /dev/null');assert(removed.at(-1).text.includes('not recorded'));
 assert(!removed.some(line=>line.kind==='removed'));
});
test('an existing git diff is preserved and adjacent equally colored lines form blocks',()=>{
 const raw='diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-old\n+new\n+more\n';
 const lines=diffLines({path:'a.js',diff:raw});assert.equal(lines.map(line=>line.text).join('\n'),raw.trimEnd());
 const groups=diffGroups(lines);assert.equal(groups.at(-1).text,'+new\n+more');assert.equal(groups.at(-1).kind,'added');
});
test('renamed files retain old and new paths',()=>{
 const lines=diffLines({path:'src/new.js',oldPath:'src/old.js',operation:'update',diff:'@@\n-a\n+b'});
 assert.equal(lines[0].text,'diff --git a/src/old.js b/src/new.js');
 assert(lines.some(line=>line.text==='--- a/src/old.js'));assert(lines.some(line=>line.text==='+++ b/src/new.js'));
});
