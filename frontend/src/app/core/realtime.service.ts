import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';

interface RealtimeEnvelope {
  type: string;
  data: unknown;
}

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  readonly telemetry$ = new Subject<any>();
  readonly fire$ = new Subject<any>();
  readonly alert$ = new Subject<any>();
  readonly connection$ = new Subject<any>();
  readonly commandStatus$ = new Subject<any>();
  readonly connected$ = new Subject<void>();

  private socket?: WebSocket;
  private startPromise?: Promise<void>;
  private intentionallyStopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  async start(): Promise<void> {
    this.intentionallyStopped = false;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    if (this.startPromise) return this.startPromise;
    const token = localStorage.getItem('accessToken') ?? '';
    if (!token) throw new Error('Authentication required');

    this.startPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        `${environment.realtimeUrl}?deviceId=${encodeURIComponent(environment.realtimeDeviceId)}`,
        ['iot-fire', `jwt.${token}`]
      );
      this.socket = socket;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        this.connected$.next();
        resolve();
      };
      socket.onmessage = event => this.handleMessage(event.data);
      socket.onerror = () => {
        if (!opened) reject(new Error('Realtime connection failed'));
      };
      socket.onclose = () => {
        if (!opened) reject(new Error('Realtime connection closed'));
        this.scheduleRetry();
      };
    }).finally(() => this.startPromise = undefined);
    return this.startPromise;
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string' || raw === 'pong') return;
    try {
      const message = JSON.parse(raw) as RealtimeEnvelope;
      if (!message || typeof message.type !== 'string') return;
      const targets: Record<string, Subject<any>> = {
        TelemetryUpdated: this.telemetry$,
        FireDetected: this.fire$,
        AlertCreated: this.alert$,
        DeviceConnectionChanged: this.connection$,
        CommandStatusChanged: this.commandStatus$
      };
      targets[message.type]?.next(message.data);
    } catch {
      // Ignore malformed frames; authenticated REST remains authoritative.
    }
  }

  private scheduleRetry(): void {
    if (this.intentionallyStopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start().catch(() => undefined), 5000);
  }

  async stop(): Promise<void> {
    this.intentionallyStopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.close(1000, 'Client stopped');
    this.socket = undefined;
  }
}
