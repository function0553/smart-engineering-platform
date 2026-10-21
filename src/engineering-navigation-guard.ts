const blockedEvent = 'engineering-navigation-blocked';

// Share the existing draft/upload guards with the outer desktop navigation.
export function engineeringNavigationBlocked(includeDialog = true) {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented || (includeDialog && Array.from(document.querySelectorAll('[role=dialog]')).some(element => element.getClientRects().length > 0));
}

export function notifyEngineeringNavigationBlocked() {
  window.dispatchEvent(new Event(blockedEvent));
}

export function onEngineeringNavigationBlocked(handle: () => void) {
  window.addEventListener(blockedEvent, handle);
  return () => window.removeEventListener(blockedEvent, handle);
}
