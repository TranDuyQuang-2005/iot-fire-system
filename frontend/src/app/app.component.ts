import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MobileLifecycleService } from './core/mobile-lifecycle.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: '<router-outlet />'
})
export class AppComponent {
  private lifecycle = inject(MobileLifecycleService);

  constructor() {
    void this.lifecycle.initialize();
  }
}
