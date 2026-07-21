'use strict';

const fs = require('fs');
const path = require('path');

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function pathExists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch (_) {
    return false;
  }
}

async function readJson(file) {
  const content = await fs.promises.readFile(file, 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    error.message = `JSON 解析失败：${file}\n${error.message}`;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tempFile, file);
}

async function replaceFileAtomic(tempFile, targetFile) {
  await ensureDir(path.dirname(targetFile));
  await fs.promises.rename(tempFile, targetFile);
}

function resolveFrom(rootDir, targetPath) {
  if (!targetPath) return null;
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(rootDir, targetPath);
}

module.exports = {
  ensureDir,
  pathExists,
  readJson,
  writeJsonAtomic,
  replaceFileAtomic,
  resolveFrom
};

