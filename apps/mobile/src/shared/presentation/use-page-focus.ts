import { useEffect, useRef, type ComponentRef } from 'react';
import { AccessibilityInfo, Platform, ScrollView, Text } from 'react-native';

// Page changes return to the heading after commit, including pages whose content has the same height.
export function usePageFocus(key?: string | number) {
  const scrollRef = useRef<ScrollView>(null);
  const headingRef = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (key === undefined) return;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      if (Platform.OS !== 'web' && headingRef.current) AccessibilityInfo.sendAccessibilityEvent(headingRef.current, 'focus');
    });
    return () => cancelAnimationFrame(frame);
  }, [key]);
  return { scrollRef, headingRef };
}
