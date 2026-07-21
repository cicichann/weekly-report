'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { calculatePeriod } = require('../src/period');
const { normalizeGitData } = require('../src/normalize');
const { validateNormalized } = require('../src/validate');
const { renderHtml } = require('../src/generate-html');
const { generateExcel } = require('../src/generate-excel');
const { generateHtml } = require('../src/generate-html');
const { verifyOutputs } = require('../src/verify');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const baseConfig = {
  timezone: 'Asia/Shanghai',
  authors: { names: ['Chen Xi'], emails: ['chen@example.com'] },
  projects: {
    '1': { name: '海云前端', group: '海云', product: '海云', issueType: '功能开发', status: '已解决' }
  },
  groupOrder: ['海云'],
  defaults: {},
  validation: { requireProjectMapping: true },
  dictionaries: {
    products: ['海云'], issueTypes: ['功能开发'], statuses: ['已解决']
  },
  excel: { templatePath: '/not-exists.xlsx', sheetName: '当周数据维护', dateFormat: 'yyyy/mm/dd' }
};

test('周日仍归入当周周一至周日', () => {
  const period = calculatePeriod('2026-07-19', 'Asia/Shanghai');
  assert.strictEqual(period.reportStart, '2026-07-13');
  assert.strictEqual(period.reportEnd, '2026-07-19');
  assert.strictEqual(period.gitlabAfter, '2026-07-12');
  assert.strictEqual(period.gitlabBefore, '2026-07-20');
});

test('按作者和日期过滤，并写入连续数字序号', () => {
  const period = calculatePeriod('2026-07-17', 'Asia/Shanghai');
  const raw = {
    fetchedAt: new Date().toISOString(),
    stats: { events: 2, pushEvents: 2, commits: 3 },
    failures: [],
    commits: [
      { project_id: 1, id: 'b', title: '修复页面布局问题', author_name: 'Chen Xi', committed_date: '2026-07-17T09:00:00+08:00' },
      { project_id: 1, id: 'a', title: '新增筛选功能', author_email: 'chen@example.com', committed_date: '2026-07-16T09:00:00+08:00' },
      { project_id: 1, id: 'c', title: '他人提交', author_name: 'Other', committed_date: '2026-07-17T09:00:00+08:00' }
    ]
  };
  const result = normalizeGitData(raw, baseConfig, period);
  assert.strictEqual(result.items.length, 2);
  assert.deepStrictEqual(result.items.map(item => item.index), [1, 2]);
  assert.deepStrictEqual(result.items.map(item => item.sha), ['b', 'a']);
});

test('空周报默认校验失败', () => {
  const period = calculatePeriod('2026-07-17', 'Asia/Shanghai');
  const normalized = {
    period,
    source: { stats: {}, failures: [] },
    stats: { input: 0, accepted: 0, rejected: 0 },
    items: [], rejected: []
  };
  const validation = validateNormalized(normalized, baseConfig);
  assert.strictEqual(validation.passed, false);
  assert(validation.issues.some(item => item.code === 'EMPTY_REPORT'));
});

test('HTML 对提交内容进行转义', () => {
  const period = calculatePeriod('2026-07-17', 'Asia/Shanghai');
  const html = renderHtml({ period, items: [{
    index: 1, date: '2026-07-17', group: '海云', product: '海云', issueType: '功能开发',
    title: '<script>alert(1)</script>', status: '已解决', detail: '', projectName: '项目', shortSha: 'abc'
  }] });
  assert(!html.includes('<script>alert(1)</script>'));
  assert(html.includes('&lt;script&gt;'));
});

test('Excel 序号为数字且日期使用指定格式', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'weekly-report-test-'));
  try {
    const target = path.join(tempDir, 'report.xlsx');
    const period = calculatePeriod('2026-07-17', 'Asia/Shanghai');
    const item = {
      index: 1, date: '2026-07-17', group: '海云', product: '海云', issueType: '功能开发',
      title: '实现周报流水线', status: '已解决', detail: '', projectName: '海云前端', branch: 'main', shortSha: 'abc123'
    };
    await generateExcel({ period, items: [item] }, baseConfig, target);
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(target);
    const sheet = workbook.getWorksheet('当周数据维护');
    assert.strictEqual(sheet.getCell('A2').value, 1);
    assert.strictEqual(sheet.getCell('B2').numFmt, 'yyyy/mm/dd');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('Excel、HTML 与同一快照的条数一致', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'weekly-report-verify-'));
  try {
    const period = calculatePeriod('2026-07-17', 'Asia/Shanghai');
    const snapshot = {
      period,
      items: [{
        index: 1, date: '2026-07-17', group: '海云', product: '海云', issueType: '功能开发',
        title: '验证双格式产物', status: '已解决', detail: '', projectName: '海云前端', branch: 'main', shortSha: 'abc123'
      }]
    };
    const paths = {
      excelFile: path.join(tempDir, 'report.xlsx'),
      htmlFile: path.join(tempDir, 'report.html')
    };
    await generateExcel(snapshot, baseConfig, paths.excelFile);
    await generateHtml(snapshot, paths.htmlFile);
    const result = await verifyOutputs(snapshot, baseConfig, paths);
    assert.deepStrictEqual(result, { passed: true, excelRows: 1, htmlRows: 1 });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      console.log(`✓ ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${entry.name}`);
      console.error(error.stack || error.message);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed) process.exitCode = 1;
})();
