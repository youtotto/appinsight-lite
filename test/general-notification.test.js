'use strict';

/** アプリの条件通知（/k/v1/app/notifications/general）の通知先 FIELD_ENTITY を検出する回帰テスト */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfigScreen } = require('./helpers/load-config');
const fx = require('./helpers/fixtures');

const names = (usage, code) => (usage[code] || []).map((u) => `${u.kind}:${u.name}`);

test('G-1 更新者を通知先（コメント書き込み）に指定 → 通知として検出', async () => {
  const screen = await loadConfigScreen();
  const usage = screen.internal.extractUsage({ appId: fx.APP_ID, properties: fx.formProperties(), ...fx.settings() });
  assert.deepEqual(names(usage, '更新者'), ['notify:コメント書き込み']);
});

test('G-2 作成者を複数イベント（レコード編集・コメント書き込み・ステータス更新）の通知先に指定 → それぞれ検出', async () => {
  const screen = await loadConfigScreen();
  const usage = screen.internal.extractUsage({ appId: fx.APP_ID, properties: fx.formProperties(), ...fx.settings() });
  assert.deepEqual(names(usage, '作成者'), ['notify:レコード編集', 'notify:コメント書き込み', 'notify:ステータス更新']);
});

test('G-3 作業者を通知先（ステータス更新）に指定 → 検出（既存のプロセス管理・一覧の判定はそのまま）', async () => {
  const screen = await loadConfigScreen();
  const usage = screen.internal.extractUsage({ appId: fx.APP_ID, properties: fx.formProperties(), ...fx.settings() });
  assert.deepEqual(names(usage, '作業者'), ['notify:ステータス更新']);
  assert.deepEqual(names(usage, 'approver'), ['process:ステータス「未処理」の作業者']);
  assert.deepEqual(names(usage, 'notify_target'), ['notify:契約期限通知']);
});

test('G-4 ユーザー・組織・グループ指定の通知先はフィールド使用扱いにしない', async () => {
  const screen = await loadConfigScreen();
  const props = fx.formProperties();
  /* 通知先のコードと同名のフィールドがあっても、FIELD_ENTITY 以外は数えない */
  props.user1 = fx.field('user1', 'SINGLE_LINE_TEXT');
  props.org1 = fx.field('org1', 'SINGLE_LINE_TEXT');
  props.grp1 = fx.field('grp1', 'SINGLE_LINE_TEXT');
  const usage = screen.internal.extractUsage({ appId: fx.APP_ID, properties: props, general: fx.settings().general });
  assert.deepEqual(usage.user1, []);
  assert.deepEqual(usage.org1, []);
  assert.deepEqual(usage.grp1, []);
});

test('G-5 同じフィールド・同じ通知イベントの重複バッジを作らない。イベント未指定は「アプリの条件通知」', async () => {
  const screen = await loadConfigScreen();
  const general = {
    notifications: [
      { entity: { type: 'FIELD_ENTITY', code: 'owner' }, commentAdded: true, recordEdited: true },
      { entity: { type: 'FIELD_ENTITY', code: 'owner' }, commentAdded: true },
      { entity: { type: 'FIELD_ENTITY', code: 'approver' } }
    ]
  };
  const usage = screen.internal.extractUsage({ appId: fx.APP_ID, properties: fx.formProperties(), general });
  assert.deepEqual(names(usage, 'owner'), ['notify:レコード編集', 'notify:コメント書き込み']);
  assert.deepEqual(names(usage, 'approver'), ['notify:アプリの条件通知']);
});

test('G-6 画面: バッジは既存の通知表示ルール「通知: <イベント名>」', async () => {
  const screen = await loadConfigScreen();
  assert.deepEqual(screen.usageOf('更新者'), ['通知: コメント書き込み']);
  assert.deepEqual(screen.usageOf('作成者'), ['通知: レコード編集', '通知: コメント書き込み', '通知: ステータス更新']);
  assert.deepEqual(screen.usageOf('作業者'), ['通知: ステータス更新']);
  assert.ok(screen.calls.some((c) => c.url.includes('/k/v1/app/notifications/general.json')));
});

test('G-7 アプリの条件通知が取得できない（403）ときは警告に出し、他の判定は続行', async () => {
  const err = Object.assign(new Error('権限がありません'), { code: 'GAIA_IL23' });
  const screen = await loadConfigScreen({ fail: { '/notifications/general': err } });
  assert.equal(screen.loadingShown(), false);
  assert.match(screen.warning(), /通知（アプリの条件通知）（GAIA_IL23/);
  assert.deepEqual(screen.usageOf('更新者'), ['未検出']);
  assert.deepEqual(screen.usageOf('notify_target'), ['通知: 契約期限通知']);
});

test('W-1 文言: source のユーザー向け文字列に削除安全性を断定する旧表現が残っていない', () => {
  const root = path.resolve(__dirname, '../source');
  const files = ['config.html', 'js/config.js', 'js/desktop.js', 'manifest.json'];
  const banned = ['未使用', '削除可', '削除可能', '安全に削除', '使用されていません', '削除して安全です', '安全です'];
  files.forEach((f) => {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    banned.forEach((w) => assert.ok(!text.includes(w), `${f} に「${w}」`));
  });
  const html = fs.readFileSync(path.join(root, 'config.html'), 'utf8');
  assert.match(html, /未検出/);
  /* 唯一の「安全」は注意書きの否定文（削除の安全は保証されません）だけ */
  const safeMentions = html.match(/安全/g) || [];
  assert.equal(safeMentions.length, 1);
  assert.match(html, /削除の安全は保証されません/);
});
