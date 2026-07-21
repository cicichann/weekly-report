#!/usr/bin/env node
'use strict';

const path = require('path');
const readline = require('readline');
const { run } = require('./src/pipeline');
const { createLogger } = require('./src/logger');

function parseArgs(argv) {
  const options = {};
  let command = 'generate';
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) command = args.shift();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--week') options.week = args[++index];
    else if (arg === '--config') options.config = args[++index];
    else if (arg === '--from-cache') options.fromCache = true;
    else if (arg === '--refresh') options.fromCache = false;
    else if (arg === '--allow-empty') options.allowEmpty = true;
    else if (arg === '--silent') options.silent = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--excel-only') options.excelOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return { command, options };
}

function printHelp() {
  console.log(`周报流水线

用法：node cli.js <command> [options]

命令：
  generate    生成待审核 Excel，确认后读取该 Excel 并生成 HTML（默认）
  prepare     只生成当前周待审核 Excel
  continue    读取审核后的 Excel 并生成 HTML
  fetch       只获取并保存 GitLab 原始数据
  validate    校验已有原始数据
  render      continue 的兼容别名

参数：
  --week YYYY-MM-DD   指定目标周内的任意一天
  --config PATH       指定配置文件
  --from-cache        生成时复用已有原始数据
  --refresh           强制重新请求 GitLab（默认行为）
  --allow-empty       允许生成空周报
  --yes, -y           不询问，生成 Excel 后立即继续生成 HTML
  --excel-only        生成 Excel 后退出，稍后用 continue 继续
  --silent            隐藏过程日志
  --help              显示帮助`);
}

function askToContinue(excelFile) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n待审核 Excel：${excelFile}`);
  console.log('你可以现在打开并修改该文件，保存后回到这里继续。');
  return new Promise(resolve => {
    terminal.question('是否继续生成 HTML？直接回车/Y：继续，N：暂不生成 [Y/n]：', answer => {
      terminal.close();
      resolve(!['n', 'no'].includes(String(answer || '').trim().toLowerCase()));
    });
  });
}

function printSummary(result) {
  const period = result.period;
  console.log(`\n周报周期：${period.reportStart.replace(/-/g, '/')} ～ ${period.reportEnd.replace(/-/g, '/')}`);
  console.log(`GitLab 边界：after=${period.gitlabAfter}，before=${period.gitlabBefore}`);
  if (result.validation) {
    const summary = result.validation.summary;
    console.log(`\nEvents：${summary.events}`);
    console.log(`Push Events：${summary.pushEvents}`);
    console.log(`真实 Commits：${summary.commits}`);
    console.log(`有效周报条目：${summary.accepted}`);
    console.log(`拒绝记录：${summary.rejected}`);
    console.log(`警告：${summary.warnings}`);
  }
  if (result.excelResult) console.log(`\nExcel：${result.paths.excelFile}`);
  if (result.htmlResult) console.log(`HTML：${result.paths.htmlFile}`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`参数错误：${error.message}`);
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (parsed.options.help) {
    printHelp();
    return;
  }

  const logger = createLogger(parsed.options.silent);
  const runOptions = {
    ...parsed.options,
    rootDir: path.resolve(__dirname)
  };
  try {
    if (parsed.command === 'generate') {
      const prepared = await run('prepare', runOptions, logger);
      printSummary(prepared);

      const shouldContinue = parsed.options.excelOnly
        ? false
        : parsed.options.yes || await askToContinue(prepared.paths.excelFile);

      if (!shouldContinue) {
        console.log(`\nHTML 尚未生成。维护 Excel 后可继续执行：`);
        console.log(`node cli.js continue --week ${prepared.period.referenceDate}`);
        return;
      }

      const completed = await run('continue', runOptions, logger);
      printSummary(completed);
      return;
    }

    const result = await run(parsed.command, runOptions, logger);
    printSummary(result);
  } catch (error) {
    console.error(`\n执行失败 [${error.code || 'UNEXPECTED_ERROR'}]：${error.message}`);
    if (error.details && error.details.issues) {
      for (const item of error.details.issues.slice(0, 10)) {
        console.error(`- ${item.level.toUpperCase()} ${item.code}：${item.message}`);
      }
    }
    process.exitCode = error.exitCode || 1;
  }
}

main();
