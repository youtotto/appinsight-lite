'use strict';

/** source/config.html + source/js/config.js を jsdom 上で読み込むヘルパー */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const fx = require('./fixtures');

const CONFIG_HTML = path.resolve(__dirname, '../../source/config.html');
const CONFIG_JS = path.resolve(__dirname, '../../source/js/config.js');

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} o
 * @param {object} o.config      プラグイン設定（notes は JSON 文字列）
 * @param {object} o.properties  getFormFields の戻り
 * @param {Array|Error} o.layout getFormLayout の戻り（Error なら reject）
 * @param {object} o.settings    設定 API の戻り（views / perRecord / reminder / status / reports / actions / recordAcl / fieldAcl）
 * @param {object} o.related     関連アプリ ID → form/fields の戻り
 * @param {object} o.fail        パス断片 → Error（該当 API を失敗させる。例 { '/app/views': err, 'app=30': err }）
 * @param {number|null} o.guestSpaceId ゲストスペース ID
 */
async function loadConfigScreen({
  config = { notes: '{}', showFieldCode: 'false' },
  properties = fx.formProperties(),
  layout = fx.formLayout(),
  settings = fx.settings(),
  related = { [fx.RELATED_APP_ID]: fx.relatedAppProperties() },
  fail = {},
  guestSpaceId = null,
  scripts = {},
  appId = fx.APP_ID
} = {}) {
  const html = fs.readFileSync(CONFIG_HTML, 'utf8');
  const base = guestSpaceId ? `/k/guest/${guestSpaceId}` : '/k';
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    url: `https://example.cybozu.com${base}/admin/app/${appId}/plugin/config?pluginId=abc`,
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  const logs = [];
  window.console.warn = (...a) => logs.push(a.map(String).join(' '));
  window.console.error = (...a) => logs.push(a.map(String).join(' '));
  window.console.log = () => {};

  window.AbortController = AbortController;
  window.TextDecoder = TextDecoder;
  window.fetch = async (url, options) => {
    const key = new URL(url).searchParams.get('fileKey');
    if (!(key in scripts)) return {ok:false,status:403};
    if (scripts[key] instanceof Error) throw scripts[key];
    return {ok:true,body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(scripts[key]));controller.close();}})};
  };
  let saved = null;
  const calls = [];
  const routes = {
    '/k/v1/app/customize': () => settings.customize || {scope:'ALL',desktop:{js:[]},mobile:{js:[]}},
    '/k/v1/app/views': () => settings.views,
    '/k/v1/app/notifications/general': () => settings.general,
    '/k/v1/app/notifications/perRecord': () => settings.perRecord,
    '/k/v1/app/notifications/reminder': () => settings.reminder,
    '/k/v1/app/status': () => settings.status,
    '/k/v1/app/reports': () => settings.reports,
    '/k/v1/app/actions': () => settings.actions,
    '/k/v1/record/acl': () => settings.recordAcl,
    '/k/v1/field/acl': () => settings.fieldAcl,
    '/k/v1/app/form/fields': (params) => {
      const r = related[String(params.app)];
      if (!r) throw Object.assign(new Error('アプリが見つかりません'), { code: 'GAIA_AP01' });
      return r;
    }
  };
  const api = async (url, method, params) => {
    calls.push({ url, method, params });
    for (const [frag, err] of Object.entries(fail)) {
      if (url.includes(frag) || (params && params.app != null && frag === `app=${params.app}`)) throw err;
    }
    const pathname = new URL(url).pathname.replace(/\.json$/, '').replace(/^\/k\/guest\/\d+/, '/k');
    const handler = routes[pathname];
    if (!handler) throw Object.assign(new Error(`unknown route ${pathname}`), { code: 'TEST' });
    return JSON.parse(JSON.stringify(handler(params)));
  };
  api.url = (p, detectGuest) => `https://example.cybozu.com${detectGuest && guestSpaceId ? `/k/guest/${guestSpaceId}` : '/k'}${p.replace(/^\/k/, '')}.json`;

  window.kintone = {
    $PLUGIN_ID: 'mock-plugin',
    api,
    app: {
      getId: () => appId,
      getFormFields: async () => JSON.parse(JSON.stringify(properties)),
      getFormLayout: async () => {
        if (layout instanceof Error) throw layout;
        return JSON.parse(JSON.stringify(layout));
      }
    },
    plugin: { app: {
      getConfig: () => JSON.parse(JSON.stringify(config)),
      setConfig: (value) => { saved = value; } // 保存後の画面遷移コールバックは呼ばない
    } }
  };

  window.eval(fs.readFileSync(path.resolve(__dirname, '../../source/vendor/acorn.js'), 'utf8'));
  window.eval(fs.readFileSync(path.resolve(__dirname, '../../source/js/js-analysis.js'), 'utf8'));
  window.eval(fs.readFileSync(CONFIG_JS, 'utf8'));
  await wait(120);

  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  const rows = () => Array.from(doc.querySelectorAll('#fuc-tbody tr'));
  const rowOf = (key) => rows().find((tr) => tr.dataset.key === key) || null;

  /* jsdom の realm で作られた配列・オブジェクトは node の deepEqual と噛み合わないので、戻り値をこちらの realm へ写す */
  const toLocal = (v) => {
    if (v instanceof window.Set) return new Set(v);
    if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v));
    return v;
  };
  const internal = {};
  Object.entries(window.FUC_fieldUsageChecker).forEach(([k, v]) => {
    internal[k] = typeof v === 'function' ? (...args) => toLocal(v(...args)) : toLocal(v);
  });

  return {
    window, document: doc, logs, calls,
    internal,
    get saved() { return saved; },
    text: () => doc.body.textContent.replace(/\s+/g, ' ').trim(),
    loadingShown: () => !$('fuc-loading').hidden,
    tableShown: () => !$('fuc-table').hidden,
    message: () => ($('fuc-message').hidden ? '' : $('fuc-message').textContent),
    warning: () => ($('fuc-warning').hidden ? '' : $('fuc-warning').textContent),
    notice: () => doc.querySelector('.fuc-notice').textContent,
    count: () => $('fuc-count').textContent,
    rows,
    visibleRows: () => rows().filter((tr) => !tr.classList.contains('fuc-row-hidden')),
    rowOf,
    usageOf: (key) => Array.from((rowOf(key) || doc.createElement('tr')).querySelectorAll('.fuc-badge')).map((b) => b.textContent),
    memoOf: (key) => { const tr = rowOf(key); const ta = tr && tr.querySelector('textarea'); return ta ? ta.value : null; },
    setMemo: (key, value) => { rowOf(key).querySelector('textarea').value = value; },
    async search(q) { $('fuc-search').value = q; $('fuc-search').dispatchEvent(new window.Event('input')); await wait(10); },
    async filter(v) { $('fuc-filter').value = v; $('fuc-filter').dispatchEvent(new window.Event('change')); await wait(10); },
    async save() { $('fuc-save-btn').click(); await wait(10); },
    setShowFieldCode(v) { $('fuc-show-field-code').checked = v; },
    wait
  };
}

module.exports = { loadConfigScreen, wait };
