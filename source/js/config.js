(function () {
  'use strict';

  /*
   * フィールド使用状況チェッカー（設定画面）
   *
   * 1 アプリ内の kintone 設定から確認できるフィールドの使用箇所を一覧する無料ツール。
   *   - 判定の起点はフォーム内の全フィールドコード（サブテーブル内も含む）
   *   - 条件式（filterCond / sort / 計算式）は識別子境界と文字列リテラルを考慮して照合する
   *   - 登録済みJSの静的解析を追加。CSS / 外部REST API / 他アプリからの参照は対象外
   *   - 使用箇所が見つからない場合は「未検出」と表示する（削除の可否を断定する表現は使わない）
   */

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  /* ─────────────────── 定数 ─────────────────── */

  /** 使用箇所の種類（表示名とバッジの色分け） */
  const KINDS = {
    js: { label: 'JS候補', cls: 'partial' },
    calc: { label: '計算式', cls: 'form' },
    lookup: { label: 'ルックアップ', cls: 'form' },
    ref: { label: '関連レコード', cls: 'form' },
    view: { label: '一覧', cls: 'view' },
    notify: { label: '通知', cls: 'notify' },
    reminder: { label: 'リマインダー', cls: 'notify' },
    process: { label: 'プロセス管理', cls: 'process' },
    report: { label: 'グラフ', cls: 'report' },
    action: { label: 'アプリアクション', cls: 'action' },
    acl: { label: 'アクセス権', cls: 'acl' }
  };

  /** 関連レコード一覧の子行（関連先アプリのフィールド）のメモキー接頭辞 */
  const REF_KEY_PREFIX = 'REF:';

  /** 取得する設定 API（キー: [パス, 表示名]） */
  const SETTING_SOURCES = {
    views: ['/k/v1/app/views', '一覧'],
    general: ['/k/v1/app/notifications/general', '通知（アプリの条件通知）'],
    perRecord: ['/k/v1/app/notifications/perRecord', '通知（レコードの条件通知）'],
    reminder: ['/k/v1/app/notifications/reminder', 'リマインダーの条件通知'],
    status: ['/k/v1/app/status', 'プロセス管理'],
    reports: ['/k/v1/app/reports', 'グラフ'],
    actions: ['/k/v1/app/actions', 'アプリアクション'],
    recordAcl: ['/k/v1/record/acl', 'アクセス権（レコード）'],
    fieldAcl: ['/k/v1/field/acl', 'アクセス権（フィールド）']
  };

  /** フィールドタイプの表示名（未知の型はそのまま表示） */
  const TYPE_LABELS = {
    SINGLE_LINE_TEXT: '文字列（1行）', MULTI_LINE_TEXT: '文字列（複数行）', RICH_TEXT: 'リッチエディター',
    NUMBER: '数値', CALC: '計算', RADIO_BUTTON: 'ラジオボタン', CHECK_BOX: 'チェックボックス',
    MULTI_SELECT: '複数選択', DROP_DOWN: 'ドロップダウン', DATE: '日付', TIME: '時刻', DATETIME: '日時',
    FILE: '添付ファイル', LINK: 'リンク', USER_SELECT: 'ユーザー選択', ORGANIZATION_SELECT: '組織選択',
    GROUP_SELECT: 'グループ選択', REFERENCE_TABLE: '関連レコード一覧', SUBTABLE: 'テーブル', GROUP: 'グループ',
    RECORD_NUMBER: 'レコード番号', CREATOR: '作成者', CREATED_TIME: '作成日時', MODIFIER: '更新者',
    UPDATED_TIME: '更新日時', STATUS: 'ステータス', STATUS_ASSIGNEE: '作業者', CATEGORY: 'カテゴリー'
  };

  /* ─────────────────── kintone API ─────────────────── */

  /** ゲストスペースを含む kintone のベースパス（画面遷移用） */
  function getBasePath() {
    const m = /^\/k\/guest\/(\d+)/.exec(location.pathname);
    return m ? `/k/guest/${m[1]}` : '/k';
  }

  /** ゲストスペース対応の GET（kintone.api.url が /k/guest/… を補う） */
  function apiGet(path, params) {
    return kintone.api(kintone.api.url(path, true), 'GET', params);
  }

  /* ─────────────────── 条件式のトークン抽出 ─────────────────── */

  /**
   * 識別子を構成する文字（フィールドコードに使える文字）。
   * 英数字・アンダースコア・各言語の文字に加え、kintone のフィールドコードで許される記号を含める。
   */
  const IDENT_CHAR = /[\p{L}\p{N}_$･＄￥.]/u;

  /** 条件式の文字列リテラル（"..."、\" を含む）を空白に置き換える */
  function stripStringLiterals(text) {
    return String(text).replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  }

  /**
   * 条件式（kintone クエリ / filterCond / sort / 計算式）に現れるフィールドコードを返す。
   *   - 文字列リテラル内は無視する（"date" は参照ではない）
   *   - 識別子境界を見る（date と update_date、A と ABC を区別する）
   *   - 直後に "(" が続くものは関数名として除外する（IF(、SUM(、TODAY( など）
   *
   * @param {string} cond 条件式
   * @param {Set<string>|string[]} codes フォーム内の全フィールドコード
   * @returns {string[]} 見つかったフィールドコード（重複なし・codes の順）
   */
  function extractCondTokens(cond, codes) {
    if (!cond || typeof cond !== 'string') return [];
    const text = stripStringLiterals(cond);
    const found = [];
    for (const code of codes) {
      if (!code) continue;
      let idx = text.indexOf(code);
      while (idx !== -1) {
        const before = idx > 0 ? text[idx - 1] : '';
        const after = text.charAt(idx + code.length);
        const boundary = !(before && IDENT_CHAR.test(before)) && !(after && IDENT_CHAR.test(after));
        const isCall = /^\s*\(/.test(text.slice(idx + code.length));
        if (boundary && !isCall) {
          found.push(code);
          break;
        }
        idx = text.indexOf(code, idx + code.length);
      }
    }
    return found;
  }

  /* ─────────────────── フォーム定義 ─────────────────── */

  /** フォーム内の全フィールドコード（サブテーブル内のフィールドを含む） */
  function collectFieldCodes(properties) {
    const codes = new Set();
    Object.values(properties || {}).forEach((prop) => {
      if (!prop || !prop.code) return;
      codes.add(prop.code);
      if (prop.type === 'SUBTABLE') {
        Object.values(prop.fields || {}).forEach((inner) => { if (inner && inner.code) codes.add(inner.code); });
      }
    });
    return codes;
  }

  /** トップレベルとサブテーブル内を平らに並べたフィールド定義の配列 */
  function flattenFormFields(properties) {
    const list = [];
    Object.values(properties || {}).forEach((prop) => {
      if (!prop || !prop.code) return;
      list.push(prop);
      if (prop.type === 'SUBTABLE') {
        Object.values(prop.fields || {}).forEach((inner) => { if (inner && inner.code) list.push(inner); });
      }
    });
    return list;
  }

  /* ─────────────────── 使用箇所の判定 ─────────────────── */

  function createUsageMap(codes) {
    const map = {};
    codes.forEach((c) => { map[c] = []; });
    return map;
  }

  /** code が自アプリのフィールドなら使用箇所を追加する（同じ種類・同じ名前は 1 回だけ） */
  function mark(map, code, kind, name) {
    if (!code || !Object.prototype.hasOwnProperty.call(map, code)) return false;
    const list = map[code];
    if (!list.some((u) => u.kind === kind && u.name === name)) list.push({ kind, name: String(name ?? '') });
    return true;
  }

  function entityFieldCode(entity) {
    const e = entity && entity.entity ? entity.entity : entity;
    return e && e.type === 'FIELD_ENTITY' && e.code ? e.code : null;
  }

  /**
   * アプリ設定からフィールドごとの使用箇所を求める。
   * 判定の起点はフォーム内の全フィールドコード。他アプリ側のフィールド（関連先アプリの
   * displayFields / relatedField、ルックアップ元アプリの relatedKeyField など）は、
   * 参照先が自アプリ自身であるときだけ自アプリの使用箇所として扱う。
   *
   * @returns {Object<string, Array<{kind: string, name: string}>>} code → 使用箇所
   */
  /** アプリの条件通知の通知イベント（API のフラグ名 → 表示名） */
  const GENERAL_NOTIFY_EVENTS = [
    ['recordAdded', 'レコード追加'],
    ['recordEdited', 'レコード編集'],
    ['commentAdded', 'コメント書き込み'],
    ['statusChanged', 'ステータス更新'],
    ['fileImported', 'ファイル読み込み']
  ];

  function extractUsage({ appId, properties, views, general, perRecord, reminder, status, reports, actions, recordAcl, fieldAcl }) {
    const codeSet = collectFieldCodes(properties);
    const map = createUsageMap(codeSet);
    const self = String(appId ?? '');
    const tokens = (cond) => extractCondTokens(cond, codeSet);
    const isSelfApp = (relatedApp) => relatedApp && String(relatedApp.app ?? '') !== '' && String(relatedApp.app) === self;

    /* フォーム: 計算式・ルックアップ・関連レコード一覧 */
    flattenFormFields(properties).forEach((prop) => {
      const label = prop.label || prop.code;

      if ((prop.type === 'CALC' || prop.type === 'SINGLE_LINE_TEXT') && prop.expression) {
        tokens(prop.expression).forEach((c) => mark(map, c, 'calc', label));
      }

      if (prop.lookup) {
        const lu = prop.lookup;
        mark(map, prop.code, 'lookup', label);
        (lu.fieldMappings || []).forEach((m) => { if (m && m.field) mark(map, m.field, 'lookup', label); });
        if (isSelfApp(lu.relatedApp)) {
          /* 自アプリ自身を参照するルックアップだけ、参照先側のフィールドも自アプリの使用箇所になる */
          if (lu.relatedKeyField) mark(map, lu.relatedKeyField, 'lookup', label);
          tokens(lu.filterCond).forEach((c) => mark(map, c, 'lookup', label));
          tokens(lu.sort).forEach((c) => mark(map, c, 'lookup', label));
          (lu.lookupPickerFields || []).forEach((c) => mark(map, c, 'lookup', label));
        }
      }

      if (prop.type === 'REFERENCE_TABLE' && prop.referenceTable) {
        const rt = prop.referenceTable;
        if (rt.condition && rt.condition.field) mark(map, rt.condition.field, 'ref', label);
        if (isSelfApp(rt.relatedApp)) {
          /* 自アプリ自身を参照する関連レコード一覧だけ、関連先側の条件・並び替え・表示フィールドも自アプリの使用箇所になる */
          if (rt.condition && rt.condition.relatedField) mark(map, rt.condition.relatedField, 'ref', label);
          tokens(rt.filterCond).forEach((c) => mark(map, c, 'ref', label));
          tokens(rt.sort).forEach((c) => mark(map, c, 'ref', label));
          (rt.displayFields || []).forEach((c) => mark(map, c, 'ref', label));
        }
      }
    });

    /* 一覧 */
    Object.entries((views && views.views) || {}).forEach(([key, view]) => {
      if (!view) return;
      const name = view.name || key;
      (view.fields || []).forEach((c) => mark(map, c, 'view', name));
      tokens(view.filterCond).forEach((c) => mark(map, c, 'view', name));
      tokens(view.sort).forEach((c) => mark(map, c, 'view', name));
      if (view.type === 'CALENDAR') {
        if (view.date) mark(map, view.date, 'view', name);
        if (view.title) mark(map, view.title, 'view', name);
      }
    });

    /* 通知（アプリの条件通知）: 通知先にフィールドが指定されているものを、通知イベントごとに検出 */
    ((general && general.notifications) || []).forEach((n) => {
      const code = entityFieldCode(n);
      if (!code) return;
      const events = GENERAL_NOTIFY_EVENTS.filter(([flag]) => n[flag] === true).map(([, label]) => label);
      (events.length ? events : ['アプリの条件通知']).forEach((name) => mark(map, code, 'notify', name));
    });

    /* 通知（レコードの条件通知） */
    ((perRecord && perRecord.notifications) || []).forEach((n, i) => {
      if (!n) return;
      const name = n.title || `条件通知 ${i + 1}`;
      tokens(n.filterCond).forEach((c) => mark(map, c, 'notify', name));
      (n.targets || []).forEach((t) => mark(map, entityFieldCode(t), 'notify', name));
    });

    /* リマインダーの条件通知 */
    ((reminder && reminder.notifications) || []).forEach((n, i) => {
      if (!n) return;
      const name = n.title || `リマインダー ${i + 1}`;
      if (n.timing && n.timing.code) mark(map, n.timing.code, 'reminder', name);
      tokens(n.filterCond).forEach((c) => mark(map, c, 'reminder', name));
      (n.targets || []).forEach((t) => mark(map, entityFieldCode(t), 'reminder', name));
    });

    /* プロセス管理: アクションの条件、ステータスの作業者 */
    if (status) {
      (status.actions || []).forEach((a, i) => {
        if (!a) return;
        const name = a.name ? `アクション「${a.name}」` : `アクション ${i + 1}`;
        tokens(a.filterCond).forEach((c) => mark(map, c, 'process', name));
      });
      Object.entries(status.states || {}).forEach(([key, state]) => {
        if (!state) return;
        const name = `ステータス「${state.name || key}」の作業者`;
        (((state.assignee || {}).entities) || []).forEach((e) => mark(map, entityFieldCode(e), 'process', name));
      });
    }

    /* グラフ */
    Object.entries((reports && reports.reports) || {}).forEach(([key, rep]) => {
      if (!rep) return;
      const name = rep.name || key;
      (rep.groups || []).forEach((g) => { if (g && g.code) mark(map, g.code, 'report', name); });
      (rep.aggregations || []).forEach((a) => { if (a && a.code) mark(map, a.code, 'report', name); });
      (rep.sorts || []).forEach((s) => { if (s && s.by) mark(map, s.by, 'report', name); });
      tokens(rep.filterCond).forEach((c) => mark(map, c, 'report', name));
    });

    /* アプリアクション */
    Object.entries((actions && actions.actions) || {}).forEach(([key, action]) => {
      if (!action) return;
      const name = action.name || key;
      (action.mappings || []).forEach((m) => {
        if (m && m.srcType === 'FIELD' && m.srcField) mark(map, m.srcField, 'action', name);
      });
      tokens(action.filterCond).forEach((c) => mark(map, c, 'action', name));
    });

    /* アクセス権（レコード: 条件式と対象のフィールド指定。フィールド: 対象フィールド） */
    ((recordAcl && recordAcl.rights) || []).forEach((r) => {
      if (!r) return;
      tokens(r.filterCond).forEach((c) => mark(map, c, 'acl', 'レコードのアクセス権'));
      (r.entities || []).forEach((e) => mark(map, entityFieldCode(e), 'acl', 'レコードのアクセス権'));
    });
    ((fieldAcl && fieldAcl.rights) || []).forEach((r) => {
      if (r && r.code) mark(map, r.code, 'acl', 'フィールドのアクセス権');
    });

    return map;
  }

  /* ─────────────────── 行データ ─────────────────── */

  function buildRefKey(parentCode, refCode) {
    return `${REF_KEY_PREFIX}${parentCode}:${refCode}`;
  }

  /** レイアウト順のトップレベルフィールドコード（レイアウトが取れないときは properties の順） */
  function layoutOrder(layout, properties) {
    const codes = [];
    const seen = new Set();
    const push = (code) => { if (code && !seen.has(code)) { seen.add(code); codes.push(code); } };
    const walk = (rows) => {
      (rows || []).forEach((row) => {
        if (!row) return;
        if (row.type === 'ROW') (row.fields || []).forEach((f) => push(f && f.code));
        else if (row.type === 'SUBTABLE') push(row.code);
        else if (row.type === 'GROUP') walk(row.layout);
      });
    };
    walk(Array.isArray(layout) ? layout : null);
    Object.values(properties || {}).forEach((p) => push(p && p.code));
    return codes;
  }

  /** 初期値の表示用文字列 */
  function formatInitialValue(field) {
    const t = field && field.type;
    const dv = field && field.defaultValue;
    const nameOf = (e) => {
      if (!e || typeof e !== 'object') return String(e ?? '');
      if (e.type === 'FUNCTION') {
        if (e.code === 'LOGINUSER()') return 'ログインユーザー';
        if (e.code === 'PRIMARY_ORGANIZATION()') return '主所属組織';
        return String(e.code ?? '');
      }
      if (e.type === 'USER') return `ユーザー:${e.code}`;
      if (e.type === 'GROUP') return `グループ:${e.code}`;
      if (e.type === 'ORGANIZATION') return `組織:${e.code}`;
      return String(e.code ?? '');
    };
    if (t === 'USER_SELECT' || t === 'ORGANIZATION_SELECT' || t === 'GROUP_SELECT') {
      return (Array.isArray(dv) ? dv : []).map(nameOf).join(', ');
    }
    if (dv == null) return '';
    if (Array.isArray(dv)) return dv.join(', ');
    if (typeof dv === 'object') { try { return JSON.stringify(dv); } catch (_e) { return String(dv); } }
    return String(dv);
  }

  function fieldRow({ field, kind, label, key, judged, usage, depth = 0 }) {
    return {
      key: key || field.code,
      code: field.code,
      label: label != null ? label : (field.label || field.code),
      type: field.type || '',
      kind,
      judged,
      usage: judged ? (usage || []) : null,
      required: Boolean(field.required),
      unique: Boolean(field.unique),
      defaultValue: formatInitialValue(field),
      depth
    };
  }

  /**
   * 表の行を組み立てる。関連レコード一覧は関連先アプリのフィールド情報を取得して子行にする。
   * 関連先の取得に失敗した場合は、その関連レコード一覧の子行だけ「取得失敗」にし、本体の行は表示する。
   */
  async function buildRows({ properties, layout, usage }) {
    const rows = [];
    const codes = layoutOrder(layout, properties);
    const relatedCache = new Map();
    const fetchRelatedFields = (appId) => {
      const k = String(appId);
      if (!relatedCache.has(k)) {
        relatedCache.set(k, apiGet('/k/v1/app/form/fields', { app: appId })
          .then((resp) => ({ ok: true, properties: (resp && resp.properties) || {} }))
          .catch((error) => ({ ok: false, error })));
      }
      return relatedCache.get(k);
    };

    for (const code of codes) {
      const field = properties[code];
      if (!field) continue;

      if (field.type === 'SUBTABLE') {
        rows.push(fieldRow({ field, kind: 'subtable', judged: true, usage: usage[code] }));
        Object.values(field.fields || {}).forEach((inner) => {
          if (!inner || !inner.code) return;
          rows.push(fieldRow({ field: inner, kind: 'subtable-child', label: `┗ ${inner.label || inner.code}`, judged: true, usage: usage[inner.code], depth: 1 }));
        });
        continue;
      }

      if (field.type === 'REFERENCE_TABLE') {
        rows.push(fieldRow({ field, kind: 'reference', judged: true, usage: usage[code] }));
        const rt = field.referenceTable;
        const relatedAppId = rt && rt.relatedApp ? rt.relatedApp.app : null;
        const displayFields = (rt && Array.isArray(rt.displayFields)) ? rt.displayFields : [];
        if (relatedAppId == null) {
          rows.push({
            key: buildRefKey(code, '*'), code: '', label: '┗ 関連先アプリの情報を取得できません（参照先アプリを閲覧する権限がない可能性があります）',
            type: '', kind: 'reference-failed', judged: false, usage: null, required: false, unique: false, defaultValue: '', depth: 1, noMemo: true
          });
          continue;
        }
        const related = await fetchRelatedFields(relatedAppId);
        if (!related.ok) {
          rows.push({
            key: buildRefKey(code, '*'), code: '', label: `┗ 関連先アプリ（ID ${relatedAppId}）のフィールド情報を取得できませんでした`,
            type: '', kind: 'reference-failed', judged: false, usage: null, required: false, unique: false, defaultValue: '', depth: 1, noMemo: true
          });
          continue;
        }
        displayFields.forEach((refCode) => {
          const refField = related.properties[refCode] || { code: refCode, label: '(不明なフィールド)', type: '(?)' };
          rows.push({
            key: buildRefKey(code, refCode),
            code: refCode,
            label: `┗ ${refField.label || refCode}`,
            type: refField.type || '(?)',
            kind: 'reference-child',
            judged: false,
            usage: null,
            required: Boolean(refField.required),
            unique: Boolean(refField.unique),
            defaultValue: formatInitialValue(refField),
            depth: 1,
            relatedAppId
          });
        });
        continue;
      }

      rows.push(fieldRow({ field, kind: 'field', judged: true, usage: usage[code] }));
    }
    return rows;
  }

  /* ─────────────────── メモ（既存データとの互換） ─────────────────── */

  function parseNotes(raw) {
    if (!raw) return { notes: {}, broken: false };
    try {
      const parsed = JSON.parse(raw);
      return { notes: (parsed && typeof parsed === 'object') ? parsed : {}, broken: false };
    } catch (_e) {
      return { notes: {}, broken: true };
    }
  }

  /**
   * 行のメモ初期値。
   * 関連レコード子行は複合キー（REF:親:関連先コード）を使う。旧版は関連先コードをそのまま
   * キーにしていたため、複合キーが無く、かつそのコードが自アプリに存在しない場合だけ旧キーを引き継ぐ。
   */
  function noteFor(notes, row, localCodes) {
    if (row.kind === 'reference-child') {
      if (Object.prototype.hasOwnProperty.call(notes, row.key)) return String(notes[row.key] ?? '');
      if (!localCodes.has(row.code) && Object.prototype.hasOwnProperty.call(notes, row.code)) return String(notes[row.code] ?? '');
      return '';
    }
    return Object.prototype.hasOwnProperty.call(notes, row.key) ? String(notes[row.key] ?? '') : '';
  }

  /* ─────────────────── 画面 ─────────────────── */

  const $ = (id) => document.getElementById(id);

  function showLoading() { const el = $('fuc-loading'); if (el) el.hidden = false; }
  function hideLoading() { const el = $('fuc-loading'); if (el) el.hidden = true; }

  function showMessage(text) {
    const el = $('fuc-message');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }

  function showWarning(items) {
    const el = $('fuc-warning');
    if (!el) return;
    el.replaceChildren();
    if (!items.length) { el.hidden = true; return; }
    const p = document.createElement('p');
    p.textContent = '次の情報は取得できなかったため、判定に含まれていません。使用箇所が実際より少なく表示されることがあります。';
    el.appendChild(p);
    const ul = document.createElement('ul');
    items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    el.appendChild(ul);
    el.hidden = false;
  }

  function describeError(error) {
    if (!error) return '';
    const code = error.code ? String(error.code) : '';
    const message = error.message ? String(error.message) : '';
    return [code, message].filter(Boolean).join(' ');
  }

  function badge(text, cls) {
    const span = document.createElement('span');
    span.className = `fuc-badge ${cls ? `fuc-badge-${cls}` : ''}`.trim();
    span.textContent = text;
    return span;
  }

  function renderUsageCell(td, row) {
    const wrap = document.createElement('div');
    wrap.className = 'fuc-badges';
    if (row.kind === 'reference-failed') {
      wrap.appendChild(badge('取得失敗', 'partial'));
    } else if (!row.judged) {
      wrap.appendChild(badge('関連先アプリのフィールド（判定対象外）', 'na'));
    } else if (!row.usage || row.usage.length === 0) {
      wrap.appendChild(badge('未検出', 'unused'));
    } else {
      row.usage.forEach((u) => {
        const kind = KINDS[u.kind] || { label: u.kind, cls: '' };
        const b = badge(u.name ? `${kind.label}: ${u.name}` : kind.label, kind.cls);
        b.title = u.name ? `${kind.label}「${u.name}」で使用` : kind.label;
        wrap.appendChild(b);
        if (u.snippet) {
          const detail = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = u.certainty + '：' + u.reason;
          const pre = document.createElement('pre');
          pre.style.whiteSpace = 'pre-wrap'; pre.style.overflowWrap = 'anywhere';
          pre.textContent = u.snippet;
          detail.append(summary, pre); wrap.appendChild(detail);
        }
      });
    }
    td.appendChild(wrap);
  }

  function renderRows(rows, notes, localCodes) {
    const tbody = $('fuc-tbody');
    tbody.replaceChildren();
    rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      tr.className = `fuc-row fuc-row-${row.kind}`;
      tr.dataset.key = row.key;
      tr.dataset.type = row.type;
      tr.dataset.placement = row.kind;
      tr.dataset.code = row.code;
      tr.dataset.label = row.label;
      tr.dataset.judged = row.judged ? 'true' : 'false';
      tr.dataset.used = row.judged && row.usage && row.usage.length > 0 ? 'true' : 'false';

      const cells = [];
      const td = (text, cls) => {
        const el = document.createElement('td');
        el.textContent = text;
        if (cls) el.className = cls;
        cells.push(el);
        return el;
      };
      td(String(index + 1), 'fuc-td-center');
      td(row.label);
      td(row.code, 'fuc-td-code');
      td(row.type ? (TYPE_LABELS[row.type] || row.type) : '');
      const usageTd = document.createElement('td');
      usageTd.className = 'fuc-td-usage';
      renderUsageCell(usageTd, row);
      cells.push(usageTd);
      td(row.required ? '〇' : '', 'fuc-td-center');
      td(row.unique ? '〇' : '', 'fuc-td-center');
      td(row.defaultValue);
      const memoTd = document.createElement('td');
      if (!row.noMemo) {
        const memo = document.createElement('textarea');
        memo.className = 'fuc-memo';
        memo.rows = 2;
        memo.value = noteFor(notes, row, localCodes);
        memo.setAttribute('aria-label', `${row.label} のメモ`);
        memoTd.appendChild(memo);
      }
      cells.push(memoTd);
      cells.forEach((c) => tr.appendChild(c));
      tbody.appendChild(tr);
    });
  }

  /** 検索・フィルターを適用し、件数を更新する */
  function applyFilter() {
    const query = ($('fuc-search') ? $('fuc-search').value : '').trim().toLowerCase();
    const type = $('fuc-type').value;
    const placement = $('fuc-placement').value;
    const mode = $('fuc-filter') ? $('fuc-filter').value : 'all';
    const rows = Array.from(document.querySelectorAll('#fuc-tbody tr'));
    let shown = 0;
    let judged = 0;
    let used = 0;
    rows.forEach((tr) => {
      const isJudged = tr.dataset.judged === 'true';
      const isUsed = tr.dataset.used === 'true';
      if (isJudged) { judged += 1; if (isUsed) used += 1; }
      let visible = true;
      if (query) {
        const hay = `${tr.dataset.code || ''}\n${tr.dataset.label || ''}`.toLowerCase();
        visible = hay.includes(query);
      }
      if (visible && mode !== 'all') {
        visible = isJudged && (mode === 'used' ? isUsed : !isUsed);
      }
      if (type && tr.dataset.type !== type) visible = false;
      if (placement && tr.dataset.placement !== placement) visible = false;
      tr.classList.toggle('fuc-row-hidden', !visible);
      if (visible) shown += 1;
    });
    const count = $('fuc-count');
    if (count) {
      count.textContent = `判定対象 ${judged} フィールド（使用箇所あり ${used}・未検出 ${judged - used}）／表示中 ${shown} 件`;
    }
    const empty = $('fuc-empty');
    if (empty) empty.hidden = shown !== 0;
  }

  /* ─────────────────── 保存 / キャンセル ─────────────────── */

  function save() {
    const memoMap = {};
    document.querySelectorAll('#fuc-tbody tr').forEach((tr) => {
      const key = tr.dataset.key;
      const memo = tr.querySelector('textarea');
      if (!key || !memo) return;
      const value = memo.value.trim();
      if (value) memoMap[key] = value;
    });
    const showFieldCode = $('fuc-show-field-code').checked ? 'true' : 'false';
    kintone.plugin.app.setConfig({ notes: JSON.stringify(memoMap), showFieldCode }, () => {
      location.href = `${getBasePath()}/admin/app/${kintone.app.getId()}/plugin/?message=CONFIG_SAVED#/`;
    });
  }

  function cancel() {
    location.href = `${getBasePath()}/admin/app/${kintone.app.getId()}/plugin/`;
  }

  /* ─────────────────── 設定の取得 ─────────────────── */

  /** 各設定 API を個別に取得し、失敗したものは名前と理由を返す（1 つ失敗しても他は使う） */
  let currentRows = [];
  let jsCoverage = 'JS未取得';
  async function downloadScript(fileKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const url = kintone.api.url('/k/v1/file.json', true) + '?fileKey=' + encodeURIComponent(fileKey);
      const response = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal });
      if (!response.ok) throw new Error('ファイル取得失敗 HTTP ' + response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0, text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > window.AppInsightLiteJS.MAX_BYTES) { await reader.cancel(); throw new Error('取得上限（2 MiB）を超えています'); }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { clearTimeout(timer); }
  }
  async function loadJavaScript(appId, localCodes, usage, warnings) {
    const target = $('fuc-js-files');
    try {
      const config = await apiGet('/k/v1/app/customize', { app: appId });
      const result = await window.AppInsightLiteJS.scan(config, Array.from(localCodes), downloadScript);
      const failed = result.files.filter(f => f.error).length;
      jsCoverage = `JS ${result.files.length}登録／解析 ${result.files.length - failed}／解析できず ${failed}（適用範囲 ${result.scope || '不明'}）`;
      for (const file of result.files) {
        const detail = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `${file.platform}: ${file.name} — ${file.status} (${file.hits.length}候補)`;
        detail.appendChild(summary);
        const text = document.createElement('p');
        text.textContent = file.error || (file.issues.length ? file.issues.slice(0, 50).map(i => `${i.line}行: ${i.reason}`).join('\n') + (file.issues.length > 50 ? '\n（先頭50件を表示）' : '') : '静的に確認できる範囲を解析しました。別名・文字列結合・外部コードなどは検出できない場合があります。');
        text.style.whiteSpace = 'pre-wrap'; detail.appendChild(text); target.appendChild(detail);
        if (file.error) warnings.push(`JS ${file.name}: ${file.error}`);
        for (const hit of file.hits) {
          if (Object.prototype.hasOwnProperty.call(usage, hit.code)) usage[hit.code].push({ ...hit, kind: 'js', name: `${file.platform}/${file.name}:${hit.line}:${hit.column}`, file: file.name });
        }
      }
    } catch (e) {
      jsCoverage = 'JS設定を取得できませんでした';
      warnings.push(jsCoverage + '（' + describeError(e) + '）');
    }
    $('fuc-overview').textContent = jsCoverage;
  }
  function exportCsv(details) {
    const visible = new Map(Array.from(document.querySelectorAll('#fuc-tbody tr')).filter(tr => !tr.classList.contains('fuc-row-hidden')).map(tr => [tr.dataset.key, tr]));
    const rows = currentRows.filter(row => visible.has(row.key));
    const context = [String(kintone.app.getId()), new Date().toISOString(), '表示中のみ／未検出は削除の安全を保証しません／' + jsCoverage];
    const output = [details ? ['アプリID', '出力日時', '範囲', 'コード', '名称', '種別', '使用箇所', '判定', '行', '列', '抜粋'] : ['アプリID', '出力日時', '範囲', 'コード', '名称', '型', '配置', '使用箇所・候補数', 'メモ']];
    for (const row of rows) {
      if (details) for (const use of row.usage || []) output.push([...context, row.code, row.label, use.kind, use.name, use.certainty || '設定内の参照', use.line || '', use.column || '', use.snippet || '']);
      else output.push([...context, row.code, row.label, row.type, row.kind, row.judged ? (row.usage || []).length : '判定対象外', visible.get(row.key).querySelector('textarea')?.value || '']);
    }
    const url = URL.createObjectURL(new Blob([window.AppInsightLiteJS.csv(output)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'appinsight-lite-' + (details ? 'usage' : 'fields') + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function fetchSettings(appId) {
    const entries = Object.entries(SETTING_SOURCES);
    const results = await Promise.allSettled(entries.map(([, [path]]) => apiGet(path, { app: appId })));
    const settings = {};
    const failures = [];
    results.forEach((r, i) => {
      const [key, [, label]] = entries[i];
      if (r.status === 'fulfilled') settings[key] = r.value;
      else {
        settings[key] = null;
        failures.push(`${label}（${describeError(r.reason) || '取得に失敗しました'}）`);
      }
    });
    return { settings, failures };
  }

  /* ─────────────────── 初期化 ─────────────────── */

  async function init() {
    const rawConfig = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
    const { notes, broken } = parseNotes(rawConfig.notes);
    if ($('fuc-show-field-code')) $('fuc-show-field-code').checked = rawConfig.showFieldCode === 'true';

    $('fuc-save-btn').addEventListener('click', save);
    $('fuc-cancel-btn').addEventListener('click', cancel);
    $('fuc-search').addEventListener('input', applyFilter);
    $('fuc-filter').addEventListener('change', applyFilter);
    $('fuc-type').addEventListener('change', applyFilter);
    $('fuc-placement').addEventListener('change', applyFilter);
    $('fuc-csv-fields').addEventListener('click', () => exportCsv(false));
    $('fuc-csv-usage').addEventListener('click', () => exportCsv(true));

    showLoading();
    const warnings = [];
    if (broken) warnings.push('保存済みのメモを読み込めませんでした（保存すると現在の内容で上書きされます）');

    try {
      const appId = kintone.app.getId();
      const properties = await kintone.app.getFormFields();
      let layout = null;
      try {
        layout = await kintone.app.getFormLayout();
      } catch (e) {
        warnings.push(`フォームのレイアウト（${describeError(e) || '取得に失敗しました'}）。フィールド定義の順で表示します`);
      }

      const { settings, failures } = await fetchSettings(appId);
      warnings.push(...failures);

      const usage = extractUsage({ appId, properties, ...settings });
      const localCodes = collectFieldCodes(properties);
      await loadJavaScript(appId, localCodes, usage, warnings);
      const rows = await buildRows({ properties, layout, usage });
      currentRows = rows;
      for (const type of [...new Set(rows.map(r => r.type))].filter(Boolean).sort()) {
        const option = document.createElement('option'); option.value = type; option.textContent = TYPE_LABELS[type] || type; $('fuc-type').appendChild(option);
      }
      $('fuc-overview').textContent += ' ／ 設定API取得 ' + (Object.keys(SETTING_SOURCES).length - failures.length) + '/' + Object.keys(SETTING_SOURCES).length + ' ／ 取得日時 ' + new Date().toLocaleString();

      renderRows(rows, notes, localCodes);
      $('fuc-toolbar').hidden = false;
      $('fuc-table').hidden = false;
      applyFilter();
    } catch (e) {
      console.error('フィールド使用状況チェッカー: 初期化に失敗しました', e);
      showMessage(`フィールド情報の取得に失敗しました。${describeError(e) ? `（${describeError(e)}）` : ''}ページを再読み込みしても解消しない場合は、アプリの管理権限とネットワーク環境をご確認ください。`);
    } finally {
      showWarning(warnings);
      hideLoading();
    }
  }

  /* テストと他ツールから参照できるよう、純粋関数を公開する */
  window.FUC_fieldUsageChecker = {
    extractCondTokens, stripStringLiterals, collectFieldCodes, extractUsage, buildRefKey, layoutOrder, formatInitialValue, parseNotes, KINDS, REF_KEY_PREFIX
  };

  init();
})();
