'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
globalThis.acorn = require('acorn');
require('../source/js/js-analysis');
const { analyze, scan, csv } = globalThis.AppInsightLiteJS;
const { loadConfigScreen } = require('./helpers/load-config');
test('JS: comments and regular expressions do not become field references; escaped literals are decoded', () => {
  const r = analyze('// rec.price\n/* "price" */\nconst re=/price/;\nrec.price.value; rec["\\u0070rice"].value;', ['price']);
  assert.equal(r.hits.length, 2); assert.deepEqual(r.hits.map(h => h.line), [4,4]);
  assert.ok(r.hits.every(h => h.certainty === '参照候補'));
});
test('JS: object identity is not assumed from record or alias names', () => {
  const r=analyze('const record={price:1}; const alias=record; alias.price; "price";', ['price']);
  assert.equal(r.hits.length,3); assert.equal(r.hits[2].certainty,'文字列候補');
  assert.ok(!JSON.stringify(r).includes('使用確定'));
});
test('JS: tables, Japanese codes, destructuring, optional chain, modules and templates', () => {
  const r=analyze('export const x = event.record.明細.value[0].value.金額?.value; const {金額} = x; const s=`金額`;', ['明細','金額']);
  assert.deepEqual(r.hits.map(h=>h.code),['明細','金額','金額','金額']);
  assert.ok(r.issues.length > 0);
});
test('JS: syntax errors and excessive input are not reported as undetected', () => {
  assert.throws(()=>analyze('const = ;',['price']));
  assert.throws(()=>analyze(' '.repeat(2*1024*1024+1),[]),/上限/);
  assert.ok(analyze('r[name]; eval(code);',[]).issues.length===2);
});
test('JS: scans only supplied current-app FILEs, shares downloads and preserves partial failures', async () => {
  const files=[{type:'FILE',file:{name:'a.js',fileKey:'a',size:'30'}},{type:'URL',url:'https://example.com/a.js'},{type:'FILE',file:{name:'bad.js',fileKey:'bad'}}];
  const calls=[];
  const result=await scan({scope:'ADMIN',desktop:{js:files},mobile:{js:[files[0]]}},['price'],async key=>{calls.push(key); if(key==='bad') throw new Error('403'); return 'record.price;';});
  assert.deepEqual(calls,['a','bad']); assert.equal(result.files.length,4);
  assert.equal(result.files[0].hits.length,1); assert.equal(result.files[3].hits.length,1);
  assert.match(result.files[1].error,/URL/); assert.match(result.files[2].error,/403/);
});
test('CSV: BOM, quote/newline escaping, formula neutralization',()=>{
  assert.equal(csv([['=SUM(A1)', 'a"b', 'x\ny', '\t+1', '日本語']]),'\uFEFF"\'=SUM(A1)","a""b","x\ny","\'\t+1","日本語"');
});
test('UI: type and table filters retain unsaved notes',async()=>{
  const s=await loadConfigScreen(); s.setMemo('unused1','保存前のメモ');
  const select=s.document.getElementById('fuc-placement'); select.value='subtable-child'; select.dispatchEvent(new s.window.Event('change'));
  assert.ok(s.visibleRows().length>0); assert.ok(s.visibleRows().every(r=>r.dataset.placement==='subtable-child'));
  await s.save(); assert.equal(JSON.parse(s.saved.notes).unused1,'保存前のメモ');
  assert.match(s.document.getElementById('fuc-overview').textContent,/JS 0登録/);
});
test('UI: denied current-app JS metadata remains visible as missing coverage',async()=>{
  const s=await loadConfigScreen({fail:{'/app/customize':new Error('403')}});
  assert.equal(s.tableShown(),true); assert.match(s.warning(),/JS設定/);
  const calls=s.calls.filter(c=>c.url.includes('customize'));
  assert.equal(calls.length,1); assert.ok(calls[0].params.app);
});

test('UI: uploaded JS is fetched, safely rendered with line evidence, partial failures remain visible',async()=>{
  const fx=require('./helpers/fixtures'); const settings=fx.settings();
  settings.customize={scope:'NONE',desktop:{js:[{type:'FILE',file:{name:'<img onerror=alert(1)>.js',fileKey:'ok'}},{type:'FILE',file:{name:'bad.js',fileKey:'bad'}}]},mobile:{js:[]}};
  const s=await loadConfigScreen({settings,scripts:{ok:'// unused1\nevent.record.unused1.value;\nconst label="unused1";'}});
  assert.equal(s.tableShown(),true);
  assert.match(s.rowOf('unused1').textContent,/参照候補/);
  assert.match(s.rowOf('unused1').textContent,/文字列候補/);
  assert.match(s.rowOf('unused1').textContent,/:2:/);
  assert.equal(s.document.querySelectorAll('img[onerror]').length,0);
  assert.match(s.warning(),/bad.js/);
  assert.match(s.document.getElementById('fuc-overview').textContent,/解析 1.*解析できず 1.*NONE/);
  await s.filter('unused'); assert.ok(!s.visibleRows().includes(s.rowOf('unused1')));
});
test('JS: excessive candidate output is capped with an explicit coverage issue',()=>{
  const r=analyze('r.price;'.repeat(1005),['price']);
  assert.equal(r.hits.length,1000); assert.ok(r.issues.some(i=>i.reason.includes('候補上限')));
});
