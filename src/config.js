'use strict';

const fs = require('fs');
const path = require('path');
const { ConfigError } = require('./errors');
const { readJson, resolveFrom } = require('./utils/files');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function loadConfig(rootDir, configPath) {
  loadEnvFile(path.join(rootDir, '.env'));

  const resolvedConfig = resolveFrom(rootDir, configPath || 'config/report.config.json');
  if (!fs.existsSync(resolvedConfig)) {
    throw new ConfigError(
      `配置文件不存在：${resolvedConfig}\n请复制 config/report.config.example.json 为 config/report.config.json 后填写。`,
      { code: 'CONFIG_NOT_FOUND' }
    );
  }

  const config = await readJson(resolvedConfig);
  const dictionariesPath = path.join(rootDir, 'config/dictionaries.json');
  const dictionaries = fs.existsSync(dictionariesPath)
    ? await readJson(dictionariesPath)
    : { products: [], issueTypes: [], statuses: [] };

  const required = [
    ['gitlab.baseUrl', config.gitlab && config.gitlab.baseUrl],
    ['gitlab.userId', config.gitlab && config.gitlab.userId],
    ['gitlab.tokenEnv', config.gitlab && config.gitlab.tokenEnv]
  ];
  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new ConfigError(`缺少必要配置：${missing.join('、')}`, { code: 'CONFIG_INVALID' });
  }

  const token = process.env[config.gitlab.tokenEnv];
  if (!token) {
    throw new ConfigError(
      `环境变量 ${config.gitlab.tokenEnv} 未设置，请写入 .env 或系统环境变量。`,
      { code: 'TOKEN_MISSING' }
    );
  }

  const paths = config.paths || {};
  const excel = config.excel || {};

  return {
    ...config,
    rootDir,
    configPath: resolvedConfig,
    dictionaries,
    timezone: config.timezone || 'Asia/Shanghai',
    gitlab: {
      ...config.gitlab,
      token,
      requestTimeoutMs: config.gitlab.requestTimeoutMs || 15000,
      maxRetries: Number.isInteger(config.gitlab.maxRetries) ? config.gitlab.maxRetries : 3
    },
    authors: config.authors || { names: [], emails: [] },
    projects: config.projects || {},
    filters: {
      excludeMergeCommits: true,
      ...(config.filters || {})
    },
    jira: {
      baseUrl: '',
      pattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b',
      ...(config.jira || {})
    },
    groupOrder: config.groupOrder || [],
    defaults: config.defaults || {},
    validation: config.validation || {},
    paths: {
      dataDir: resolveFrom(rootDir, paths.dataDir || 'data'),
      outputDir: resolveFrom(rootDir, paths.outputDir || 'output')
    },
    excel: {
      ...excel,
      templatePath: resolveFrom(rootDir, excel.templatePath || 'templates/weekly-report.xlsx'),
      manualInputPath: excel.manualInputPath
        ? resolveFrom(rootDir, excel.manualInputPath)
        : null,
      sheetName: excel.sheetName || '当周数据维护',
      headerRow: excel.headerRow || 1,
      endRow: excel.endRow || 100,
      dateFormat: excel.dateFormat || 'yyyy/mm/dd'
    }
  };
}

module.exports = { loadConfig };
