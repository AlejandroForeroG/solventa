import { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Image, ScrollView, Text, View } from 'react-native';

import { theme } from '@/theme';
import type { ClaimReportCopy } from './messages';
import { Action, Page, ui } from './ui';

export function DocumentReview({ uri, copy, onAttach, onCancel }: { uri: string; copy: ClaimReportCopy; onAttach: () => void; onCancel: () => void }) {
  const [preview, setPreview] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [enlarged, setEnlarged] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { onCancel(); return true; });
    return () => back.remove();
  }, [onCancel]);

  return <Page title={copy.document.heading}>
    <Text style={ui.body}>{copy.document.instructions}</Text>
    {preview !== 'failed' && <View style={ui.card}>
      <View onLayout={event => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 && <ScrollView horizontal scrollEnabled={enlarged}>
          <Image source={{ uri }} resizeMode="contain" accessibilityLabel={copy.document.preview}
            style={{ width: width * (enlarged ? 2 : 1), height: enlarged ? 720 : 360 }}
            onLoad={() => setPreview('ready')} onError={() => setPreview('failed')} />
        </ScrollView>}
        {preview === 'loading' && <ActivityIndicator color={theme.colors.primaryDark} accessibilityLabel={copy.evidence.previewing} />}
      </View>
      {preview === 'ready' && <Action label={enlarged ? copy.document.fit : copy.document.enlarge} secondary onPress={() => setEnlarged(value => !value)} />}
    </View>}
    {preview === 'failed' && <Text accessibilityRole="alert" style={ui.notice}>{copy.document.previewFailed}</Text>}
    <Action label={copy.document.attach} disabled={preview !== 'ready'} onPress={onAttach} />
    <Action label={copy.cancel} secondary onPress={onCancel} />
  </Page>;
}
