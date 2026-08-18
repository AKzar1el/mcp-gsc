import { assertDateRange } from './date-validation';

export interface IndexedPagesDateRange {
  startDate: string;
  endDate: string;
}

function addUtcDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function resolveIndexedPagesDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  today: string,
): IndexedPagesDateRange {
  const latestCompleteDate = addUtcDays(today, -3);

  if (!startDate && !endDate) {
    return {
      startDate: addUtcDays(latestCompleteDate, -29),
      endDate: latestCompleteDate,
    };
  }

  if (!startDate) {
    return {
      startDate: addUtcDays(endDate!, -29),
      endDate: endDate!,
    };
  }

  if (!endDate) {
    if (startDate > latestCompleteDate) {
      throw new Error(
        `start_date must be on or before ${latestCompleteDate} when end_date is omitted. ` +
        'The generated end_date cannot be later than the latest complete date.',
      );
    }
    const generatedEndDate = addUtcDays(startDate, 29);
    return {
      startDate,
      endDate:
        generatedEndDate > latestCompleteDate
          ? latestCompleteDate
          : generatedEndDate,
    };
  }

  assertDateRange(startDate, endDate);
  return { startDate, endDate };
}
