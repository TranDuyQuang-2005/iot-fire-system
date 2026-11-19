import { Capacitor } from '@capacitor/core';
import { mobileServerUrl } from './mobile-server';
import { webServerUrl } from './web-server';

const localWebHosts = new Set(['localhost', '127.0.0.1']);
const isLocalWeb = !Capacitor.isNativePlatform() && localWebHosts.has(window.location.hostname);
const serverUrl = Capacitor.isNativePlatform() ? mobileServerUrl : (isLocalWeb ? '' : webServerUrl);

export const environment = {
  mobileServerUrl,
  webServerUrl,
  apiBaseUrl: `${serverUrl}/api`,
  realtimeUrl: `${serverUrl.replace(/^http/, 'ws')}/realtime`,
  realtimeDeviceId: 'ESP32_001'
};
