'use strict';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDateString(value, label = '日期') {
  if (!DATE_RE.test(value || '')) {
    throw new Error(`${label}必须为 YYYY-MM-DD 格式：${value}`);
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}不是有效日期：${value}`);
  }
}

function addDays(dateString, days) {
  assertDateString(dateString);
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(dateString) {
  assertDateString(dateString);
  return new Date(`${dateString}T12:00:00Z`).getUTCDay();
}

function dateInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function timestampToDate(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateInTimezone(date, timezone);
}

function isDateInRange(value, start, end) {
  return Boolean(value && value >= start && value <= end);
}

function toExcelDate(dateString) {
  assertDateString(dateString);
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function formatDisplayDate(dateString) {
  return String(dateString || '').replace(/-/g, '/');
}

module.exports = {
  assertDateString,
  addDays,
  dayOfWeek,
  dateInTimezone,
  timestampToDate,
  isDateInRange,
  toExcelDate,
  formatDisplayDate
};

