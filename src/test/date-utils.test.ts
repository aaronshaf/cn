/**
 * Tests for date and duration utilities
 */

import { describe, expect, test } from 'bun:test';
import { formatRelativeTime, parseDate, parseDuration, validateDateFilters } from '../lib/search/date-utils.js';

describe('Date Utils', () => {
  describe('parseDuration', () => {
    test('parses days correctly', () => {
      expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60);
      expect(parseDuration('30d')).toBe(30 * 24 * 60 * 60);
      expect(parseDuration('1d')).toBe(24 * 60 * 60);
    });

    test('parses weeks correctly', () => {
      expect(parseDuration('1w')).toBe(7 * 24 * 60 * 60);
      expect(parseDuration('2w')).toBe(14 * 24 * 60 * 60);
    });

    test('parses months correctly', () => {
      expect(parseDuration('1m')).toBe(30 * 24 * 60 * 60);
      expect(parseDuration('3m')).toBe(90 * 24 * 60 * 60);
    });

    test('parses years correctly', () => {
      expect(parseDuration('1y')).toBe(365 * 24 * 60 * 60);
      expect(parseDuration('2y')).toBe(730 * 24 * 60 * 60);
    });

    test('throws on invalid format', () => {
      expect(() => parseDuration('invalid')).toThrow('Invalid duration format');
      expect(() => parseDuration('7')).toThrow('Invalid duration format');
      expect(() => parseDuration('d7')).toThrow('Invalid duration format');
      expect(() => parseDuration('7x')).toThrow('Invalid duration format');
    });

    test('throws on zero or negative amounts', () => {
      expect(() => parseDuration('0d')).toThrow('Duration amount must be positive');
      expect(() => parseDuration('-7d')).toThrow('Invalid duration format');
    });
  });

  describe('parseDate', () => {
    test('parses ISO 8601 dates', () => {
      const date = new Date('2024-01-15');
      expect(parseDate('2024-01-15')).toBe(Math.floor(date.getTime() / 1000));
    });

    test('parses dates with time', () => {
      const date = new Date('2024-01-15T10:30:00');
      expect(parseDate('2024-01-15T10:30:00')).toBe(Math.floor(date.getTime() / 1000));
    });

    test('throws on invalid format', () => {
      expect(() => parseDate('invalid')).toThrow('Invalid date format');
      expect(() => parseDate('2024-13-45')).toThrow('Invalid date format');
      expect(() => parseDate('')).toThrow('Invalid date format');
    });
  });

  describe('formatRelativeTime', () => {
    const now = Math.floor(Date.now() / 1000);

    test('formats recent times as "just now"', () => {
      expect(formatRelativeTime(now)).toBe('just now');
      expect(formatRelativeTime(now - 30)).toBe('just now');
    });

    test('formats minutes ago', () => {
      expect(formatRelativeTime(now - 60)).toBe('1 minute ago');
      expect(formatRelativeTime(now - 120)).toBe('2 minutes ago');
      expect(formatRelativeTime(now - 1800)).toBe('30 minutes ago');
    });

    test('formats hours ago', () => {
      expect(formatRelativeTime(now - 3600)).toBe('1 hour ago');
      expect(formatRelativeTime(now - 7200)).toBe('2 hours ago');
    });

    test('formats days ago', () => {
      expect(formatRelativeTime(now - 86400)).toBe('1 day ago');
      expect(formatRelativeTime(now - 172800)).toBe('2 days ago');
      expect(formatRelativeTime(now - 604800)).toBe('7 days ago');
    });

    test('formats months ago', () => {
      expect(formatRelativeTime(now - 2592000)).toBe('1 month ago');
      expect(formatRelativeTime(now - 5184000)).toBe('2 months ago');
    });

    test('formats years ago', () => {
      expect(formatRelativeTime(now - 31536000)).toBe('1 year ago');
      expect(formatRelativeTime(now - 63072000)).toBe('2 years ago');
    });
  });

  describe('validateDateFilters', () => {
    test('allows updatedWithin without conflicts', () => {
      expect(() => validateDateFilters({ updatedWithin: '7d' })).not.toThrow();
    });

    test('allows stale without conflicts', () => {
      expect(() => validateDateFilters({ stale: '90d' })).not.toThrow();
    });

    test('throws when both updatedWithin and stale are specified', () => {
      expect(() =>
        validateDateFilters({
          updatedWithin: '7d',
          stale: '90d',
        }),
      ).toThrow('Conflicting filters');
    });

    test('allows empty options', () => {
      expect(() => validateDateFilters({})).not.toThrow();
    });
  });
});
