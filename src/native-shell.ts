/**
 * The iOS client is a WKWebView inside a UINavigationController that already
 * shows the title plus 返回 / 更多, so the page should not draw a second bar.
 * Newer builds announce themselves; older builds are recognised as an embedded
 * iOS web view (an iPhone/iPad user agent without the Safari token).
 */
export function inIOSShell() {
  if (typeof navigator === 'undefined' || window.AndroidDailyReport) return false;
  const ua = navigator.userAgent;
  if (/SmartEngineering-iOS/.test(ua)) return true;
  return /\b(iPhone|iPad|iPod)\b/.test(ua) && !/\bSafari\//.test(ua) && !/MicroMessenger|AlipayClient|DingTalk/i.test(ua);
}
