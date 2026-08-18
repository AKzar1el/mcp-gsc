import { z } from 'zod';

const YYYY_MM_DD = /^(\d{4})-(\d{2})-(\d{2})$/;

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
