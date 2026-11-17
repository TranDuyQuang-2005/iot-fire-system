import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { PushNotificationService } from '../../core/push-notification.service';

@Component({
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css']
})
export class LoginComponent {
  username = '';
  password = '';
  error = '';
  loading = false;

  private auth = inject(AuthService);
  private router = inject(Router);
  private push = inject(PushNotificationService);

  login() {
    this.loading = true;
    this.error = '';
    this.auth.login(this.username, this.password).subscribe({
      next: async () => {
        await this.router.navigateByUrl('/');
        // Android 13+ shows the native permission prompt here, after a successful login.
        await this.push.initializeAfterLogin(true);
      },
      error: e => {
        this.error = e?.error?.message ?? 'Đăng nhập thất bại';
        this.loading = false;
      }
    });
  }
}
