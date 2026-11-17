import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  role: string;
  username: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);

  login(username: string, password: string) {
    return this.http.post<LoginResponse>(`${environment.apiBaseUrl}/auth/login`, { username, password }).pipe(
      tap(r => {
        localStorage.setItem('accessToken', r.accessToken);
        localStorage.setItem('role', r.role);
        localStorage.setItem('username', r.username);
        void this.persistNativeSession(r);
      })
    );
  }

  logout() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('role');
    localStorage.removeItem('username');
    if (Capacitor.isNativePlatform()) {
      for (const key of ['accessToken', 'role', 'username'])
        void SecureStoragePlugin.remove({ key }).catch(() => undefined);
    }
  }

  private async persistNativeSession(response: LoginResponse): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    await Promise.all([
      SecureStoragePlugin.set({ key: 'accessToken', value: response.accessToken }),
      SecureStoragePlugin.set({ key: 'role', value: response.role }),
      SecureStoragePlugin.set({ key: 'username', value: response.username })
    ]);
  }

  token() { return localStorage.getItem('accessToken'); }
  role() { return localStorage.getItem('role'); }
  isLoggedIn() {
    const token = this.token();
    if (!token) return false;
    try {
      const encodedPayload = token.split('.')[1];
      const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
      const valid = typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
      if (!valid) this.logout();
      return valid;
    } catch {
      this.logout();
      return false;
    }
  }
}
