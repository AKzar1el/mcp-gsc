import { z } from 'zod';

const YYYY_MM_DD = /^(\d{4})-(\d{2})-(\d{2})$/;
export const SEARCH_CONSOLE_TIME_ZONE = 'America/Los_Angeles';
export const SEARCH_CONSOLE_DATE_TIME_ZONE_NOTE =
  'Google Search Console interprets this calendar date in Pacific Time (America/Los_Angeles; UTC-8/UTC-7 depending on daylight saving time).';

export function searchConsoleDateDescription(base: string): string {
  return `${base} ${SEARCH_CONSOLE_DATE_TIME_ZONE_NOTE}`;
}

export function getSearchConsoleCalendarDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SEARCH_CONSOLE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) {
    throw new Error('Could not resolve the Search Console calendar date.');
  }
  return `${year}-${month}-${day}`;
}

export function isValidCalendarDate(value: string): boolean {
  const match = YYYY_MM_DD.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;

  const daysInMonth = [
    31,
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

export const SEARCH_CONSOLE_DATE_SCHEMA = z.string().superRefine((value, ctx) => {
  if (!YYYY_MM_DD.test(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Use YYYY-MM-DD format (for example, 2026-01-31).',
    });
    return;
  }

  if (!isValidCalendarDate(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Use a real calendar date in YYYY-MM-DD format (for example, 2024-02-29).',
    });
  }
});

export function assertDateRange(
  startDate: string,
  endDate: string,
  startName = 'start_date',
  endName = 'end_date',
): void {
  if (startDate > endDate) {
    throw new Error(`${startName} must be on or before ${endName}.`);
  }
}

export function assertDateNotInFuture(date: string, today: string): void {
  if (date > today) {
    throw new Error(
      'End date must be today or earlier. Google Search Console has no data for dates that have not happened yet.',
    );
  }
}
