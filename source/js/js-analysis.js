(function (root) {
  'use strict';
  const MAX_BYTES = 2 * 1024 * 1024;
  function analyze(text, codes) {
    if (text.length > MAX_BYTES) throw new Error('解析上限（2 MiB）を超えています');
    let ast;
    try { ast = root.acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); }
    catch (_) { ast = root.acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
    const known = new Set(codes), hits = [], issues = [], seen = new Set();
    const lines = text.split(/\r?\n/);
    const add = (node, code, certainty, reason) => {
      if (!known.has(code)) return;
      const key = `${node.start}:${code}`;
      if (seen.has(key)) return;
      if (hits.length >= 1000) { if (!issues.some(i => i.reason.includes('候補上限'))) issues.push({ line: node.loc.start.line, reason: '候補上限1000件に達したため、残りの候補は表示しません' }); return; }
      seen.add(key);
      hits.push({ code, certainty, reason, line: node.loc.start.line, column: node.loc.start.column + 1,
        snippet: lines[node.loc.start.line - 1].slice(Math.max(0, node.loc.start.column - 80), node.loc.start.column + 160) });
    };
    // Deliberately do not infer record identity from variable names. A member of an
    // unrelated object can have the same name; these are evidence candidates.
    const stack = [{ node: ast, parent: null }];
    while (stack.length) {
      const { node, parent } = stack.pop();
      if (node.type === 'MemberExpression') {
        const prop = node.property;
        if (!node.computed && prop.type === 'Identifier') add(prop, prop.name, '参照候補', 'プロパティ参照（対象オブジェクトは未確定）');
        else if (prop.type === 'Literal' && typeof prop.value === 'string') add(prop, prop.value, '参照候補', '固定文字列によるプロパティ参照');
        else if (node.computed) issues.length < 100 && issues.push({ line: node.loc.start.line, reason: '動的なプロパティ指定：フィールドコードを確定できません' });
      } else if (node.type === 'Literal' && typeof node.value === 'string' && !(parent && parent.type === 'MemberExpression' && parent.property === node)) {
        add(node, node.value, '文字列候補', 'フィールドコードと同じ文字列（参照とは限りません）');
      } else if (node.type === 'TemplateLiteral' && !node.expressions.length) {
        add(node, node.quasis[0].value.cooked, '文字列候補', '固定テンプレート文字列');
      } else if (node.type === 'Identifier' && parent && parent.type === 'Property' && parent.key === node && !parent.computed) {
        add(node, node.name, '参照候補', 'オブジェクトのキー・分割代入（対象は未確定）');
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['eval', 'Function'].includes(node.callee.name)) issues.push({ line: node.loc.start.line, reason: '動的コードの生成：生成後のコードは解析しません' });
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (let i = value.length - 1; i >= 0; i--) if (value[i] && value[i].type) stack.push({ node: value[i], parent: node }); }
        else if (value && typeof value === 'object' && value.type) stack.push({ node: value, parent: node });
      }
    }
    return { hits: hits.sort((a, b) => a.line - b.line || a.column - b.column), issues };
  }
  async function scan(customize, codes, download) {
    const files = [], cache = new Map();
    for (const platform of ['desktop', 'mobile']) {
      for (const entry of (customize[platform] && customize[platform].js) || []) {
        const name = entry.type === 'FILE' ? entry.file && entry.file.name : entry.url;
        const result = { platform, name: name || '(名称不明)', status: '解析できず', hits: [], issues: [] };
        files.push(result);
        try {
          if (entry.type !== 'FILE') throw new Error('URL指定のJSは自動取得しません。外部配信・CORS・認証条件により解析対象外');
          if (!entry.file || !entry.file.fileKey) throw new Error('ファイルキーがありません');
          if (Number(entry.file.size) > MAX_BYTES) throw new Error('取得上限（2 MiB）を超えています');
          const key = entry.file.fileKey;
          if (!cache.has(key)) cache.set(key, download(key));
          const text = await cache.get(key);
          Object.assign(result, analyze(text, codes));
          result.status = result.issues.length ? '一部解析（動的指定あり）' : '解析済み（静的解析の範囲）';
        } catch (error) { result.error = String(error.message || error); }
      }
    }
    return { scope: customize.scope, files };
  }
  function csv(rows) {
    return '\uFEFF' + rows.map(row => row.map(value => {
      let s = String(value == null ? '' : value);
      if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    }).join(',')).join('\r\n');
  }
  root.AppInsightLiteJS = { analyze, scan, csv, MAX_BYTES };
})(typeof window === 'undefined' ? globalThis : window);
