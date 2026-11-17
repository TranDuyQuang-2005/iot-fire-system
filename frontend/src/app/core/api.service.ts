import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  devices() { return this.http.get<any[]>(`${environment.apiBaseUrl}/devices`); }
  latest(deviceId: string) { return this.http.get<any>(`${environment.apiBaseUrl}/devices/${deviceId}/latest`); }
  readings(deviceId: string, pageSize = 100) {
    return this.http.get<any>(`${environment.apiBaseUrl}/devices/${deviceId}/readings?page=1&pageSize=${pageSize}`);
  }
  events() { return this.http.get<any[]>(`${environment.apiBaseUrl}/events`); }
  alerts() { return this.http.get<any[]>(`${environment.apiBaseUrl}/alerts`); }
  command(deviceId: string, command: string) {
    return this.http.post<any>(`${environment.apiBaseUrl}/devices/${deviceId}/commands`, { command });
  }
  setMode(deviceId: string, mode: 'AUTO' | 'MANUAL') {
    return this.http.put<any>(`${environment.apiBaseUrl}/devices/${deviceId}/mode`, { mode });
  }
  resetAlarm(deviceId: string) {
    return this.http.post<any>(`${environment.apiBaseUrl}/devices/${deviceId}/reset-alarm`, {});
  }
  registerPushToken(token: string, platform: string, deviceName: string) {
    return this.http.post(`${environment.apiBaseUrl}/push/register`, { token, platform, deviceName });
  }
  unregisterPushToken(token: string) {
    return this.http.post(`${environment.apiBaseUrl}/push/unregister`, { token });
  }
}
