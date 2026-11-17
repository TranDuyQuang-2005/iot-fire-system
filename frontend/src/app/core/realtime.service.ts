import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  readonly telemetry$ = new Subject<any>();
  readonly fire$ = new Subject<any>();
  readonly alert$ = new Subject<any>();
  readonly connection$ = new Subject<any>();
  readonly commandStatus$ = new Subject<any>();
  readonly connected$ = new Subject<void>();

  private connection?: signalR.HubConnection;
  private startPromise?: Promise<void>;
  private intentionallyStopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  async start(): Promise<void> {
    this.intentionallyStopped = false;
    if (this.connection?.state === signalR.HubConnectionState.Connected ||
        this.connection?.state === signalR.HubConnectionState.Reconnecting ||
        this.connection?.state === signalR.HubConnectionState.Connecting) return;
    if (this.startPromise) return this.startPromise;

    if (!this.connection) this.connection = this.createConnection();
    this.startPromise = this.connection.start()
      .then(() => this.connected$.next())
      .catch(error => {
        this.scheduleRetry();
        throw error;
      })
      .finally(() => this.startPromise = undefined);
    return this.startPromise;
  }

  private createConnection(): signalR.HubConnection {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl(environment.signalRUrl, {
        accessTokenFactory: () => localStorage.getItem('accessToken') ?? ''
      })
      .withAutomaticReconnect([0, 2000, 5000, 10000])
      .build();

    connection.on('TelemetryUpdated', x => this.telemetry$.next(x));
    connection.on('FireDetected', x => this.fire$.next(x));
    connection.on('AlertCreated', x => this.alert$.next(x));
    connection.on('DeviceConnectionChanged', x => this.connection$.next(x));
    connection.on('CommandStatusChanged', x => this.commandStatus$.next(x));
    connection.onreconnected(() => this.connected$.next());
    connection.onclose(() => {
      this.scheduleRetry();
    });
    return connection;
  }

  private scheduleRetry(): void {
    if (this.intentionallyStopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start().catch(() => undefined), 5000);
  }

  async stop(): Promise<void> {
    this.intentionallyStopped = true;
    clearTimeout(this.retryTimer);
    if (this.connection && this.connection.state !== signalR.HubConnectionState.Disconnected)
      await this.connection.stop();
  }
}
