import { Injectable, inject } from '@angular/core';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { AuthService } from './auth.service';
import { RealtimeService } from './realtime.service';
import { PushNotificationService } from './push-notification.service';

@Injectable({ providedIn: 'root' })
export class MobileLifecycleService {
  private realtime = inject(RealtimeService);
  private auth = inject(AuthService);
  private push = inject(PushNotificationService);
  private initialized = false;
  private handles: PluginListenerHandle[] = [];

  async initialize(): Promise<void> {
    if (this.initialized || !Capacitor.isNativePlatform()) return;
    this.initialized = true;
    this.handles.push(
      await App.addListener('appStateChange', state => {
        if (state.isActive && this.auth.isLoggedIn()) void this.realtime.start().catch(() => undefined);
      }),
      await Network.addListener('networkStatusChange', status => {
        if (status.connected && this.auth.isLoggedIn()) void this.realtime.start().catch(() => undefined);
      })
    );
    if (this.auth.isLoggedIn()) await this.push.initializeAfterLogin(false);
  }
}
