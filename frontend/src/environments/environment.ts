import { Capacitor } from '@capacitor/core';

// Public HTTPS endpoint used only by the native Capacitor application.
// Web deployments keep using same-origin /api and /iotHub through the existing proxy.
const mobileServerUrl = 'https://laptop-jq3b9t7h.tailb58134.ts.net';
const serverUrl = Capacitor.isNativePlatform() ? mobileServerUrl : '';

export const environment = {
  mobileServerUrl,
  apiBaseUrl: `${serverUrl}/api`,
  signalRUrl: `${serverUrl}/iotHub`
};
