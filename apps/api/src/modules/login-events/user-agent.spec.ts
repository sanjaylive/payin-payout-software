import { describe, expect, it } from 'vitest';
import { summariseUserAgent } from './user-agent';

describe('summariseUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome 141', 'Windows', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15', 'Safari 18', 'macOS', 'desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1', 'Safari 18', 'iOS 18', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Samsung Internet 25', 'Android 14', 'mobile'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge 141', 'Windows', 'desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0', 'Firefox 139', 'Linux', 'desktop'],
  ])('%s', (ua, browser, os, deviceType) => {
    expect(summariseUserAgent(ua)).toEqual({ browser, os, deviceType });
  });

  it('flags scripts and handles missing values', () => {
    expect(summariseUserAgent('curl/8.7.1').deviceType).toBe('bot');
    expect(summariseUserAgent(null)).toEqual({ browser: null, os: null, deviceType: 'unknown' });
  });
});
