/**
 * Small, dependency-free user-agent summary for login logs: browser, OS and device type. Good
 * enough to recognise "same laptop" vs "new phone"; the raw string is kept alongside.
 */
export interface DeviceSummary {
  browser: string | null;
  os: string | null;
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/FxiOS\/(\d+)/, 'Firefox'],
  [/CriOS\/(\d+)/, 'Chrome'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/, 'Safari'],
];

const OSES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/Windows NT 10/, () => 'Windows'],
  [/Windows NT/, () => 'Windows'],
  [/iPhone OS (\d+)/, (m) => `iOS ${m[1]}`],
  [/iPad.*OS (\d+)/, (m) => `iPadOS ${m[1]}`],
  [/Android (\d+)/, (m) => `Android ${m[1]}`],
  [/Mac OS X/, () => 'macOS'],
  [/CrOS/, () => 'ChromeOS'],
  [/Linux/, () => 'Linux'],
];

export function summariseUserAgent(ua: string | null | undefined): DeviceSummary {
  if (!ua) return { browser: null, os: null, deviceType: 'unknown' };
  if (/bot|crawler|spider|curl|wget|python-requests|okhttp|postman/i.test(ua)) return { browser: ua.split(/[ /]/)[0]?.slice(0, 60) ?? null, os: null, deviceType: 'bot' };
  let browser: string | null = null;
  for (const [re, name] of BROWSERS) {
    const m = ua.match(re);
    if (m) {
      browser = `${name} ${m[1]}`;
      break;
    }
  }
  let os: string | null = null;
  for (const [re, fmt] of OSES) {
    const m = ua.match(re);
    if (m) {
      os = fmt(m);
      break;
    }
  }
  const deviceType = /iPad|Tablet/.test(ua) ? 'tablet' : /Mobi|iPhone|Android/.test(ua) ? 'mobile' : 'desktop';
  return { browser, os, deviceType };
}
