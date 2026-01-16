/**
 * Date and duration utilities for search filtering
 */

/**
 * Parse a duration string into seconds
 * Supports: 7d (days), 2w (weeks), 3m (months), 1y (years)
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([dwmy])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use format like 30d, 2w, 3m, 1y`);
  }

  const [, amount, unit] = match;
  const num = parseInt(amount, 10);

  if (num <= 0) {
    throw new Error(`Duration amount must be positive: ${duration}`);
  }

  const multipliers = {
    d: 24 * 60 * 60, // days to seconds
    w: 7 * 24 * 60 * 60, // weeks to seconds
    m: 30 * 24 * 60 * 60, // months (30 days) to seconds
    y: 365 * 24 * 60 * 60, // years (365 days) to seconds
  };

  return num * multipliers[unit as keyof typeof multipliers];
}

/**
 * Parse a date string into Unix timestamp
 * Supports ISO 8601 format: YYYY-MM-DD or YYYY-MM-DD HH:MM:SS
 */
export function parseDate(dateStr: string): number {
  // Try to parse as ISO 8601
  const date = new Date(dateStr);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD format`);
  }

  return Math.floor(date.getTime() / 1000); // Convert to Unix timestamp
}

/**
 * Format a Unix timestamp as a relative time string
 * e.g., "3 days ago", "2 hours ago", "just now"
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) {
    return 'just now';
  }

  if (diff < 3600) {
    const minutes = Math.floor(diff / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  if (diff < 2592000) {
    const days = Math.floor(diff / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  if (diff < 31536000) {
    const months = Math.floor(diff / 2592000);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }

  const years = Math.floor(diff / 31536000);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Validate that date filter options don't conflict
 */
export function validateDateFilters(options: { updatedWithin?: string; stale?: string }): void {
  if (options.updatedWithin && options.stale) {
    throw new Error('Conflicting filters: --updated-within and --stale cannot be used together');
  }
}
