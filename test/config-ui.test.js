'use strict';

/** 設定画面の描画・エラー処理・検索・フィルター・件数・メモ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfigScreen } = require('./helpers/load-config');
const fx = require('./helpers/fixtures');

const err403 = Object.assign(new Error('権限がありません'), { code: 'GAIA_IL23', status: 403 });

test('S-1 正常系: スピナーが消え、表・ツールバー・注意書きが表示される', async () => {
  const screen = await loadConfigScreen();
  assert.equal(screen.loadingShown(), false);
  assert.equal(screen.tableShown(), true);
  assert.equal(screen.message(), '');
  assert.ok(screen.rows().length > 30);
  assert.match(screen.notice(), /「未検出」でも削除の安全は保証されません/);
  assert.match(screen.notice(), /他アプリからの参照は対象外です/);
  assert.match(screen.notice(), /AppInsight for kintone/);
});

test('S-2 「未使用」「削除可」「安全に削除できます」の表現がなく、見つからない場合は「未検出」', async () => {
  const screen = await loadConfigScreen();
  const text = screen.text();
  ['未使用', '削除可', '安全に削除できます', '―'].forEach((w) => assert.ok(!text.includes(w), `画面に「${w}」が無い`));
  assert.deepEqual(screen.usageOf('unused1'), ['未検出']);
  const src = fs.readFileSync(path.resolve(__dirname, '../source/js/config.js'), 'utf8')
    + fs.readFileSync(path.resolve(__dirname, '../source/config.html'), 'utf8');
  ['未使用', '削除可', '安全に削除できます'].forEach((w) => assert.ok(!src.includes(w), `ソースに「${w}」が無い`));
});

test('S-3 使用箇所は種類と対象名のバッジで表示される', async () => {
  const screen = await loadConfigScreen();
  assert.deepEqual(screen.usageOf('only_notify'), ['通知: 契約期限通知']);
  assert.deepEqual(screen.usageOf('only_report'), ['グラフ: 月別売上']);
  assert.deepEqual(screen.usageOf('only_process'), ['プロセス管理: アクション「申請」']);
  assert.deepEqual(screen.usageOf('customer_name').sort(), ['一覧: 顧客一覧', 'ルックアップ: customer_codeラベル'].sort());
  assert.deepEqual(screen.usageOf('secret'), ['アクセス権: フィールドのアクセス権']);
  const badge = screen.rowOf('only_notify').querySelector('.fuc-badge');
  assert.ok(badge.classList.contains('fuc-badge-notify'));
});

test('S-4 設定 API が 403 でもスピナーが消え、本体の表は出て、取得できなかった設定が警告に出る', async () => {
  const screen = await loadConfigScreen({ fail: { '/app/views': err403, '/record/acl': err403 } });
  assert.equal(screen.loadingShown(), false);
  assert.equal(screen.tableShown(), true);
  assert.match(screen.warning(), /取得できなかったため、判定に含まれていません/);
  assert.match(screen.warning(), /一覧（GAIA_IL23 権限がありません）/);
  assert.match(screen.warning(), /アクセス権（レコード）/);
  assert.deepEqual(screen.usageOf('only_view_cond'), ['未検出'], '一覧が取れないので未検出になる（警告で補足）');
  assert.deepEqual(screen.usageOf('only_notify'), ['通知: 契約期限通知'], '他の設定は判定される');
});

test('S-5 getFormFields が失敗しても固まらない（メッセージ表示・スピナー消える・キャンセル可能）', async () => {
  const screen = await loadConfigScreen();
  const failing = await (async () => {
    const s = await loadConfigScreenWithFieldsError(err403);
    return s;
  })();
  assert.equal(failing.loadingShown(), false);
  assert.match(failing.message(), /フィールド情報の取得に失敗しました/);
  assert.match(failing.message(), /GAIA_IL23/);
  assert.equal(failing.tableShown(), false);
  assert.equal(failing.document.getElementById('fuc-cancel-btn').disabled, false);
  assert.equal(screen.tableShown(), true);
});

async function loadConfigScreenWithFieldsError(error) {
  const { JSDOM } = require('jsdom');
  void JSDOM;
  /* getFormFields を失敗させるため、properties の代わりに例外を投げるモックに差し替える */
  const screen = await loadConfigScreen({ properties: new Proxy({}, { ownKeys() { throw error; }, getOwnPropertyDescriptor() { throw error; } }) });
  return screen;
}

test('S-6 関連アプリの閲覧不可（form/fields が 403）: 本体行は表示、子行だけ取得失敗', async () => {
  const screen = await loadConfigScreen({ fail: { 'app=30': err403 } });
  assert.equal(screen.loadingShown(), false);
  assert.ok(screen.rowOf('related'), '関連レコード一覧の本体行');
  const failed = screen.rows().find((tr) => tr.classList.contains('fuc-row-reference-failed'));
  assert.ok(failed, '取得失敗の子行');
  assert.match(failed.textContent, /取得できませんでした/);
  assert.equal(failed.querySelector('textarea'), null, '取得失敗行にメモ欄は出さない');
  assert.ok(screen.rowOf('unused1'), '他の本体行も表示');
  assert.equal(screen.message(), '', '全体エラーにはしない');
});

test('S-7 referenceTable が null でも描画される', async () => {
  const props = fx.formProperties();
  props.related.referenceTable = null;
  const screen = await loadConfigScreen({ properties: props });
  assert.equal(screen.loadingShown(), false);
  assert.ok(screen.rowOf('related'));
  const failed = screen.rows().find((tr) => tr.classList.contains('fuc-row-reference-failed'));
  assert.match(failed.textContent, /関連先アプリの情報を取得できません/);
  assert.deepEqual(screen.usageOf('ref_key'), ['未検出']);
});

test('S-8 notes の JSON が壊れていても描画され、警告が出る', async () => {
  const screen = await loadConfigScreen({ config: { notes: '{broken', showFieldCode: 'true' } });
  assert.equal(screen.loadingShown(), false);
  assert.equal(screen.tableShown(), true);
  assert.match(screen.warning(), /メモを読み込めませんでした/);
  assert.equal(screen.memoOf('unused1'), '');
  assert.equal(screen.document.getElementById('fuc-show-field-code').checked, true);
});

test('S-9 レイアウト取得失敗時はフィールド定義の順で表示し、警告に出す', async () => {
  const screen = await loadConfigScreen({ layout: Object.assign(new Error('layout error'), { code: 'X' }) });
  assert.equal(screen.tableShown(), true);
  assert.match(screen.warning(), /フォームのレイアウト/);
  assert.ok(screen.rows().length > 30);
});

test('S-10 検索: フィールドコード・名称の部分一致（大文字小文字を区別しない）', async () => {
  const screen = await loadConfigScreen();
  await screen.search('only_');
  const codes = screen.visibleRows().map((tr) => tr.dataset.code);
  assert.ok(codes.every((c) => c.startsWith('only_')), codes.join(','));
  assert.equal(codes.length, 6, 'only_notify / only_process / only_report / only_action / only_view_cond / only_view_sort');
  await screen.search('UNUSED');
  assert.deepEqual(screen.visibleRows().map((tr) => tr.dataset.code), ['unused1', 'unused2']);
  await screen.search('関連先の日付');
  assert.deepEqual(screen.visibleRows().map((tr) => tr.dataset.key), ['REF:related:date'], '名称でも絞り込める');
  await screen.search('zzz');
  assert.equal(screen.visibleRows().length, 0);
  assert.equal(screen.document.getElementById('fuc-empty').hidden, false);
  await screen.search('');
  assert.equal(screen.visibleRows().length, screen.rows().length);
});

test('S-11 フィルター: すべて / 使用箇所あり / 未検出（判定対象外の関連先子行は「すべて」のときだけ）', async () => {
  const screen = await loadConfigScreen();
  await screen.filter('unused');
  const unused = screen.visibleRows();
  assert.ok(unused.length > 0);
  assert.ok(unused.every((tr) => tr.dataset.judged === 'true' && tr.dataset.used === 'false'));
  assert.ok(unused.some((tr) => tr.dataset.code === 'unused1'));
  await screen.filter('used');
  const used = screen.visibleRows();
  assert.ok(used.every((tr) => tr.dataset.judged === 'true' && tr.dataset.used === 'true'));
  assert.ok(used.some((tr) => tr.dataset.code === 'only_notify'));
  assert.ok(!used.some((tr) => tr.dataset.key.startsWith('REF:')));
  await screen.filter('all');
  assert.ok(screen.visibleRows().some((tr) => tr.dataset.key.startsWith('REF:')));
});

test('S-12 件数表示: 判定対象・使用箇所あり・未検出・表示中', async () => {
  const screen = await loadConfigScreen();
  const judged = screen.rows().filter((tr) => tr.dataset.judged === 'true');
  const used = judged.filter((tr) => tr.dataset.used === 'true');
  assert.equal(screen.count(), `判定対象 ${judged.length} フィールド（使用箇所あり ${used.length}・未検出 ${judged.length - used.length}）／表示中 ${screen.rows().length} 件`);
  await screen.filter('unused');
  assert.match(screen.count(), new RegExp(`表示中 ${judged.length - used.length} 件$`));
});

test('S-13 関連レコード子行は複合キー（REF:親:関連先コード）でメモが衝突しない。使用箇所は判定対象外表示', async () => {
  const screen = await loadConfigScreen({ config: { notes: JSON.stringify({ date: '自アプリの日付メモ', 'REF:related:date': '関連先の日付メモ', 'REF:related:amount': '金額メモ' }) } });
  assert.equal(screen.memoOf('date'), '自アプリの日付メモ');
  assert.equal(screen.memoOf('REF:related:date'), '関連先の日付メモ');
  assert.equal(screen.memoOf('REF:related:amount'), '金額メモ');
  assert.deepEqual(screen.usageOf('REF:related:date'), ['関連先アプリのフィールド（判定対象外）']);
  assert.equal(screen.rowOf('REF:related:date').dataset.code, 'date');

  screen.setMemo('date', '自アプリ更新');
  screen.setMemo('REF:related:date', '関連先更新');
  screen.setMemo('unused1', '  空白は削る  ');
  screen.setShowFieldCode(true);
  await screen.save();
  const notes = JSON.parse(screen.saved.notes);
  assert.equal(notes.date, '自アプリ更新');
  assert.equal(notes['REF:related:date'], '関連先更新');
  assert.equal(notes['REF:related:amount'], '金額メモ');
  assert.equal(notes.unused1, '空白は削る');
  assert.equal(screen.saved.showFieldCode, 'true');
});

test('S-14 旧版のメモ（関連先コードをそのままキー）は、自アプリに同じコードが無い場合だけ子行に引き継ぐ', async () => {
  const screen = await loadConfigScreen({ config: { notes: JSON.stringify({ amount: '旧: 金額メモ', date: '旧: 日付メモ' }) } });
  assert.equal(screen.memoOf('REF:related:amount'), '旧: 金額メモ', 'amount は自アプリに無いので子行へ');
  assert.equal(screen.memoOf('REF:related:date'), '', 'date は自アプリにあるので子行へは引き継がない');
  assert.equal(screen.memoOf('date'), '旧: 日付メモ');
  await screen.save();
  const notes = JSON.parse(screen.saved.notes);
  assert.equal(notes['REF:related:amount'], '旧: 金額メモ', '保存時に複合キーへ移行');
  assert.equal(notes.amount, undefined);
});

test('S-15 ゲストスペース: API は /k/guest/{id}/v1/… を使い、保存後の遷移先もゲストパス', async () => {
  const screen = await loadConfigScreen({ guestSpaceId: 7 });
  assert.equal(screen.tableShown(), true);
  assert.ok(screen.calls.length >= 9);
  assert.ok(screen.calls.every((c) => c.url.startsWith('https://example.cybozu.com/k/guest/7/v1/')), screen.calls.map((c) => c.url).join('\n'));
  assert.deepEqual(screen.usageOf('only_notify'), ['通知: 契約期限通知']);
});

test('S-16 サブテーブル本体と子行、レイアウト外のシステムフィールドも一覧に出る', async () => {
  const screen = await loadConfigScreen();
  assert.ok(screen.rowOf('items').classList.contains('fuc-row-subtable'));
  assert.ok(screen.rowOf('item_total').classList.contains('fuc-row-subtable-child'));
  assert.deepEqual(screen.usageOf('item_price'), ['計算式: item_totalラベル']);
  assert.ok(screen.rowOf('ステータス'), 'レイアウトに無い STATUS も表示');
  const order = screen.rows().map((tr) => tr.dataset.key);
  assert.ok(order.indexOf('date') < order.indexOf('price') && order.indexOf('price') < order.indexOf('related'), 'レイアウト順');
});

test('S-17 config.html は body 断片で、script 参照が無く、クラスは fuc- 接頭辞', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../source/config.html'), 'utf8');
  assert.doesNotMatch(html, /<!DOCTYPE|<html|<head|<body/i);
  assert.doesNotMatch(html, /<script/i);
  const classes = html.match(/class="([^"]+)"/g).flatMap((m) => m.replace(/class="|"/g, '').split(/\s+/));
  classes.forEach((c) => assert.ok(c.startsWith('fuc-') || c.startsWith('kintoneplugin-'), c));
  const selectors = (html.match(/<style>([\s\S]*)<\/style>/)[1].match(/^\s*([.#@][^{]+)\{/gm) || []);
  selectors.forEach((s) => assert.match(s.trim(), /^(\.fuc-|#fuc-|@keyframes fuc-)/, s));
});

test('S-18 manifest: licenseChecker / kuc を含まず、単一ビルド（Trial 分岐なし）', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../source/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.desktop.js, ['js/desktop.js']);
  assert.deepEqual(manifest.config.js, ['vendor/acorn.js', 'js/js-analysis.js', 'js/config.js']);
  assert.equal(manifest.version, '1.3.0');
  assert.doesNotMatch(manifest.name.ja, /試用版/);
  const files = fs.readdirSync(path.resolve(__dirname, '../source/js'));
  assert.deepEqual(files.sort(), ['config.js', 'desktop.js', 'js-analysis.js']);
  const src = fs.readFileSync(path.resolve(__dirname, '../source/js/config.js'), 'utf8') + fs.readFileSync(path.resolve(__dirname, '../source/js/desktop.js'), 'utf8');
  assert.doesNotMatch(src, /licenseChecker|checkLicense|Kucs|nestrec\.com|productId/);
  assert.doesNotMatch(src, /innerHTML/);
  assert.doesNotMatch(src, /record\\\.\(\\w\+\)/, '旧 JavaScript 検出（URL への正規表現）は削除');
});
