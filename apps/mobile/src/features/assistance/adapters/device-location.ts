export async function readDeviceLocation(signal: AbortSignal) {
  const location = await import('expo-location');
  if (signal.aborted) return null;
  const permission = await location.requestForegroundPermissionsAsync();
  if (!permission.granted || signal.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reading = await Promise.race([location.getCurrentPositionAsync({ accuracy: location.Accuracy.Balanced }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('location_deadline')), 10_000); })]);
    return { latitude: reading.coords.latitude, longitude: reading.coords.longitude };
  } finally { clearTimeout(timer); }
}
