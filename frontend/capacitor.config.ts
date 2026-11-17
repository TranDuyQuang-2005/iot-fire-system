import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.iotfire.monitoring',
  appName: 'IoT Fire Monitoring',
  webDir: 'dist/iot-fire-ui/browser',
  plugins: {
    PushNotifications: {
      // Foreground messages are rendered by the Angular notification center/toast.
      presentationOptions: []
    }
  }
};

export default config;
