import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Device } from '@capacitor/device';
import {
  PushNotifications,
  type PushNotificationSchema
} from '@capacitor/push-notifications';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { BehaviorSubject, Subject, firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';

export interface AppPushEvent {
  eventId: string;
  eventType: string;
  title: string;
  message: string;
  severity: string;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class PushNotificationService {
  readonly permissionDenied$ = new BehaviorSubject(false);
  readonly foregroundNotification$ = new Subject<AppPushEvent>();

  private api = inject(ApiService);
  private router = inject(Router);
  private initialized = false;
  private registrationRequested = false;
  private currentToken = '';
  private handles: PluginListenerHandle[] = [];

  async initializeAfterLogin(requestPermission: boolean): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await this.ensureListeners();
      await this.createChannels();

      let permission = await PushNotifications.checkPermissions();
      if (permission.receive === 'prompt' && requestPermission)
        permission = await PushNotifications.requestPermissions();

      const denied = permission.receive === 'denied';
      this.permissionDenied$.next(denied);
      if (permission.receive === 'granted' && !this.registrationRequested) {
        this.registrationRequested = true;
        try { await PushNotifications.register(); }
        catch (error) {
          this.registrationRequested = false;
          throw error;
        }
      }
    } catch (error) {
      console.warn('Push notifications are unavailable; the app remains usable', error);
    }
  }

  async unregister(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    const token = this.currentToken || await this.readStoredToken();
    if (token) {
      try { await firstValueFrom(this.api.unregisterPushToken(token)); } catch { /* best effort on logout */ }
    }
    try { await PushNotifications.unregister(); } catch { /* Firebase may be unavailable */ }
    this.currentToken = '';
    this.registrationRequested = false;
    try { await SecureStoragePlugin.remove({ key: 'fcmToken' }); } catch { /* already absent */ }
  }

  private async ensureListeners(): Promise<void> {
    if (this.initialized) return;
    const handles = await Promise.all([
      await PushNotifications.addListener('registration', token => void this.registerToken(token.value)),
      await PushNotifications.addListener('registrationError', error => {
        this.registrationRequested = false;
        console.warn('FCM registration failed', error);
      }),
      await PushNotifications.addListener('pushNotificationReceived', notification => {
        this.foregroundNotification$.next(this.normalize(notification));
      }),
      await PushNotifications.addListener('pushNotificationActionPerformed', action => {
        void this.openNotification(action.notification);
      })
    ]);
    this.handles.push(...handles);
    this.initialized = true;
  }

  private async registerToken(token: string): Promise<void> {
    if (!token) return;
    this.currentToken = token;
    try {
      const info = await Device.getInfo();
      const deviceName = [info.manufacturer, info.model].filter(Boolean).join(' ').trim() || 'Android';
      await firstValueFrom(this.api.registerPushToken(token, 'android', deviceName));
      await SecureStoragePlugin.set({ key: 'fcmToken', value: token });
    } catch (error) {
      console.warn('Unable to register push token with backend', error);
    }
  }

  private async createChannels(): Promise<void> {
    const channels = [
      { id: 'fire_critical', name: 'Cảnh báo cháy khẩn cấp', description: 'Cháy, nguy cơ cao và xử lý sự cố', importance: 5, vibration: true, sound: 'default' },
      { id: 'warning', name: 'Cảnh báo an toàn', description: 'Dấu hiệu bất thường và trạng thái sau sự cố', importance: 4, vibration: true, sound: 'default' },
      { id: 'system', name: 'Trạng thái hệ thống', description: 'Kết nối của thiết bị giám sát', importance: 3, vibration: true, sound: 'default' }
    ] as const;
    for (const channel of channels) await PushNotifications.createChannel(channel);
  }

  private normalize(notification: PushNotificationSchema): AppPushEvent {
    const data = notification.data ?? {};
    const eventType = String(data.eventType ?? data.type ?? 'SYSTEM');
    return {
      eventId: String(data.eventId ?? notification.id),
      eventType,
      title: notification.title ?? this.defaultTitle(eventType),
      message: notification.body ?? String(data.message ?? 'Hệ thống vừa ghi nhận một thay đổi.'),
      severity: String(data.severity ?? this.defaultSeverity(eventType)),
      createdAt: String(data.createdAt ?? new Date().toISOString())
    };
  }

  private async openNotification(notification: PushNotificationSchema): Promise<void> {
    const event = this.normalize(notification);
    await this.router.navigate(['/'], { queryParams: { event: event.eventType, eventId: event.eventId } });
    this.foregroundNotification$.next(event);
  }

  private async readStoredToken(): Promise<string> {
    try { return (await SecureStoragePlugin.get({ key: 'fcmToken' })).value || ''; }
    catch { return ''; }
  }

  private defaultSeverity(type: string): string {
    if (['FIRE', 'HIGH_RISK', 'SUPPRESSING'].includes(type)) return 'CRITICAL';
    if (['WARNING', 'POST_FIRE', 'DEVICE_OFFLINE'].includes(type)) return 'WARNING';
    return 'INFO';
  }

  private defaultTitle(type: string): string {
    const titles: Record<string, string> = {
      WARNING: '⚠️ Có dấu hiệu bất thường', HIGH_RISK: '⚠️ Nguy cơ cháy cao', FIRE: '🔥 CẢNH BÁO CHÁY',
      SUPPRESSING: '🚨 Đang xử lý sự cố', POST_FIRE: '✅ Ngọn lửa đã được dập',
      DEVICE_OFFLINE: '📡 Mất kết nối', DEVICE_ONLINE: '✅ Đã kết nối lại'
    };
    return titles[type] ?? 'Cập nhật từ hệ thống';
  }
}
