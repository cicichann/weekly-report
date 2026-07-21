'use strict';

const fs = require('fs');
const ExcelJS = require('exceljs');
const { OutputError } = require('./errors');

async function verifyExcel(snapshot, config, excelFile) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(excelFile);
  } catch (error) {
    throw new OutputError(`生成后的 Excel 无法读取：${error.message}`, {
      code: 'EXCEL_VERIFY_READ_FAILED'
    });
  }

  const sheet = workbook.getWorksheet(config.excel.sheetName);
  if (!sheet) {
    throw new OutputError(`Excel 缺少工作表：${config.excel.sheetName}`, {
      code: 'EXCEL_VERIFY_SHEET_MISSING'
    });
  }

  let excelRows = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 1 && Number.isInteger(row.getCell(1).value)) excelRows += 1;
  });
  if (excelRows !== snapshot.items.length) {
    throw new OutputError(
      `Excel 条数与快照不一致：Excel=${excelRows}，快照=${snapshot.items.length}`,
      { code: 'EXCEL_ROW_COUNT_MISMATCH' }
    );
  }

  return { passed: true, excelRows };
}

async function verifyHtml(snapshot, htmlFile) {
  const html = await fs.promises.readFile(htmlFile, 'utf8');
  const match = html.match(/<meta name="report-item-count" content="(\d+)">/);
  const htmlRows = match ? Number(match[1]) : NaN;
  if (htmlRows !== snapshot.items.length) {
    throw new OutputError(
      `HTML 条数与快照不一致：HTML=${htmlRows}，快照=${snapshot.items.length}`,
      { code: 'HTML_ROW_COUNT_MISMATCH' }
    );
  }

  return { passed: true, htmlRows };
}

async function verifyOutputs(snapshot, config, paths) {
  const excel = await verifyExcel(snapshot, config, paths.excelFile);
  const html = await verifyHtml(snapshot, paths.htmlFile);
  return { passed: true, excelRows: excel.excelRows, htmlRows: html.htmlRows };
}

module.exports = { verifyOutputs, verifyExcel, verifyHtml };
