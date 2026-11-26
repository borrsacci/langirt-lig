import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.langirt.lig',
  appName: 'Langırt Ligi',
  webDir: 'dist',
  android: { backgroundColor: '#0A2A21' },
  plugins: {
    StatusBar: { backgroundColor: '#0A2A21', style: 'DARK', overlaysWebView: false },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
