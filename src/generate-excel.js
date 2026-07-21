'use strict';

const path = require('path');
const ExcelJS = require('exceljs');
const { ensureDir, pathExists, replaceFileAtomic } = require('./utils/files');
const { toExcelDate } = require('./utils/dates');
const { OutputError } = require('./errors');

const COLUMNS = [
  { header: '序号', key: 'index', width: 8 },
  { header: '业务线', key: 'group', width: 18 },
  { header: '日期', key: 'date', width: 13 },
  { header: '产品', key: 'product', width: 18 },
  { header: '项目', key: 'projectName', width: 22 },
  { header: '问题类型', key: 'issueType', width: 14 },
  { header: 'JIRA编号', key: 'jira', width: 16 },
  { header: '工作内容', key: 'title', width: 48 },
  { header: '负责人', key: 'owner', width: 14 },
  { header: '反馈人', key: 'feedbackPerson', width: 14 },
  { header: '解决状态', key: 'status', width: 14 },
  { header: '处理详情', key: 'detail', width: 35 },
  { header: '备注', key: 'remark', width: 28 },
  { header: '分支', key: 'branch', width: 18 },
  { header: 'Commit SHA', key: 'sha', width: 18 }
];

function styleHeader(row) {
  row.height = 24;
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  row.eachCell(cell => {
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      left: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      bottom: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      right: { style: 'thin', color: { argb: 'FFD9E2F3' } }
    };
  });
}

async function generateExcel(snapshot, config, targetFile) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Weekly Report Pipeline';
  workbook.created = new Date();

  if (await pathExists(config.excel.templatePath)) {
    await workbook.xlsx.readFile(config.excel.templatePath);
  }

  const existingSheet = workbook.getWorksheet(config.excel.sheetName);
  if (existingSheet) {
    // ExcelJS 在带样式、数据验证或合并单元格的模板中，spliceRows 可能残留旧行。
    // 删除并重建目标工作表，确保重复执行不会把新数据追加到旧数据之后。
    workbook.removeWorksheet(existingSheet.id);
  }
  const sheet = workbook.addWorksheet(config.excel.sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  sheet.columns = COLUMNS;
  styleHeader(sheet.getRow(1));
  sheet.autoFilter = { from: 'A1', to: 'O1' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const item of snapshot.items) {
    const row = sheet.addRow({
      ...item,
      date: toExcelDate(item.date),
      jira: item.jira && item.jiraUrl
        ? { text: item.jira, hyperlink: item.jiraUrl }
        : item.jira
    });
    row.getCell('date').numFmt = config.excel.dateFormat;
    row.getCell('index').numFmt = '0';
    row.alignment = { vertical: 'top', wrapText: true };
    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        right: { style: 'thin', color: { argb: 'FFD9D9D9' } }
      };
    });
  }

  const dictionaries = config.dictionaries || {};
  for (let row = 2; row <= Math.max(snapshot.items.length + 1, 100); row += 1) {
    if ((dictionaries.issueTypes || []).length) {
      sheet.getCell(`F${row}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`"${dictionaries.issueTypes.join(',')}"`]
      };
    }
    if ((dictionaries.statuses || []).length) {
      sheet.getCell(`K${row}`).dataValidation = {
        type: 'list', allowBlank: true,
        formulae: [`"${dictionaries.statuses.join(',')}"`]
      };
    }
  }

  await ensureDir(path.dirname(targetFile));
  const tempFile = `${targetFile}.${process.pid}.tmp.xlsx`;
  try {
    await workbook.xlsx.writeFile(tempFile);
    await replaceFileAtomic(tempFile, targetFile);
  } catch (error) {
    throw new OutputError(`Excel 生成失败：${error.message}`, {
      code: 'EXCEL_GENERATION_FAILED', details: { targetFile }
    });
  }

  return { file: targetFile, rows: snapshot.items.length, sheetName: config.excel.sheetName };
}

module.exports = { generateExcel, COLUMNS };
