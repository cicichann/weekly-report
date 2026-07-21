'use strict';

const ExcelJS = require('exceljs');
const { pathExists } = require('./utils/files');
const { isDateInRange } = require('./utils/dates');
const { buildJiraUrl, isMergeCommit } = require('./normalize');

const HEADER_ALIASES = {
  index: ['序号'],
  group: ['业务线', '产品线'],
  date: ['日期', '解决日期'],
  product: ['产品'],
  projectName: ['项目', '项目名称'],
  issueType: ['问题类型', '类型'],
  jira: ['jira', 'jira编号', 'jira 编号'],
  title: ['工作内容', '任务描述', '描述'],
  owner: ['负责人', '处理人'],
  feedbackPerson: ['反馈人'],
  status: ['解决状态', '状态'],
  detail: ['处理详情'],
  remark: ['备注'],
  branch: ['分支'],
  sha: ['commit sha', 'commit', '提交sha', '提交哈希']
};

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeHeader(value) {
  return cleanText(value).replace(/\s+/g, ' ').toLowerCase();
}

function readCellValue(cell) {
  const value = cell.value;
  if (value == null) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (value.result != null) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map(item => item.text).join('');
    if (value.text != null) return value.text;
  }
  return value;
}

function readText(row, column) {
  if (!column) return '';
  return cleanText(readCellValue(row.getCell(column)));
}

function resolveHeaderMap(sheet, headerRow) {
  const available = new Map();
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, column) => {
    available.set(normalizeHeader(readCellValue(cell)), column);
  });

  const result = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const alias = aliases.find(value => available.has(normalizeHeader(value)));
    if (alias) result[key] = available.get(normalizeHeader(alias));
  }
  return result;
}

function formatDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseManualDate(value, period) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'number' && value > 20000) {
    const milliseconds = Math.round((value - 25569) * 86400 * 1000);
    const date = new Date(milliseconds);
    return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const text = cleanText(value);
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    const year = Number(period.reportStart.slice(0, 4));
    return formatDateParts(year, Number(match[1]), Number(match[2]));
  }
  return '';
}

function extractCommitMarker(remark) {
  const match = String(remark || '').match(/\[commit:([a-f0-9]{7,40})\]/i);
  return match ? match[1] : '';
}

function cleanRemark(remark) {
  return String(remark || '').replace(/\[commit:[a-f0-9]{7,40}\]/gi, '').trim();
}

function hasContent(item) {
  return Boolean(
    item.group || item.date || item.projectName || item.jira || item.title ||
    item.detail || item.owner || item.feedbackPerson || item.status || item.remark
  );
}

async function findManualExcel(config, paths) {
  // 当前周期 output 中的 Excel 永远优先，它是用户审核和维护的最终数据源。
  const candidates = [paths.excelFile, config.excel.manualInputPath].filter(Boolean);
  for (const file of candidates) {
    if (await pathExists(file)) return file;
  }
  return null;
}

async function readManualExcel(config, period, paths) {
  const file = await findManualExcel(config, paths);
  if (!file) return { file: null, items: [], rejected: [] };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet(config.excel.sheetName);
  if (!sheet) return { file, items: [], rejected: [{ reason: 'MANUAL_SHEET_MISSING', sheetName: config.excel.sheetName }] };

  const headerRow = config.excel.headerRow || 1;
  const columns = resolveHeaderMap(sheet, headerRow);
  const items = [];
  const rejected = [];
  const lastRow = Math.max(sheet.actualRowCount, config.excel.endRow || 100);

  for (let rowNumber = headerRow + 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawDate = columns.date ? readCellValue(row.getCell(columns.date)) : '';
    const productValue = readText(row, columns.product);
    const explicitGroup = readText(row, columns.group);
    const rawRemark = readText(row, columns.remark);
    const jira = readText(row, columns.jira).toUpperCase();
    const sha = readText(row, columns.sha) || extractCommitMarker(rawRemark);
    const item = {
      id: `manual:${rowNumber}`,
      source: 'manual',
      rowNumber,
      projectId: '',
      projectMapped: true,
      group: explicitGroup || productValue,
      product: explicitGroup ? productValue : '',
      date: parseManualDate(rawDate, period),
      projectName: readText(row, columns.projectName),
      issueType: readText(row, columns.issueType),
      jira,
      jiraUrl: buildJiraUrl(jira, config),
      title: readText(row, columns.title),
      owner: readText(row, columns.owner),
      feedbackPerson: readText(row, columns.feedbackPerson),
      status: readText(row, columns.status),
      detail: readText(row, columns.detail),
      remark: cleanRemark(rawRemark),
      branch: readText(row, columns.branch),
      sha,
      shortSha: sha.slice(0, 8),
      committedAt: ''
    };

    if (!hasContent(item)) continue;
    if (config.filters.excludeMergeCommits && isMergeCommit({ title: item.title })) {
      rejected.push({ reason: 'MANUAL_MERGE_COMMIT', rowNumber, title: item.title, sha: item.sha });
      continue;
    }
    if (item.date && !isDateInRange(item.date, period.reportStart, period.reportEnd)) {
      rejected.push({ reason: 'MANUAL_OUTSIDE_PERIOD', rowNumber, date: item.date });
      continue;
    }
    items.push(item);
  }

  return { file, items, rejected, columns };
}

module.exports = {
  readManualExcel,
  resolveHeaderMap,
  parseManualDate,
  extractCommitMarker,
  cleanRemark
};
