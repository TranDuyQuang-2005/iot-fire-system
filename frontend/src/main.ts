import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { authInterceptor } from './app/core/auth.interceptor';
import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

async function restoreNativeSession(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  for (const key of ['accessToken', 'role', 'username']) {
    try {
      const { value } = await SecureStoragePlugin.get({ key });
      if (value) localStorage.setItem(key, value);
    } catch {
      localStorage.removeItem(key);
    }
  }
}

restoreNativeSession()
  .then(() => bootstrapApplication(AppComponent, {
    providers: [
      provideRouter(routes),
      provideHttpClient(withInterceptors([authInterceptor]))
    ]
  }))
  .catch(err => console.error(err));
