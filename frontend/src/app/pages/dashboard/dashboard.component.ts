import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Chart } from 'chart.js/auto';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { PushNotificationService } from '../../core/push-notification.service';

type ChartMetric = 'temperature' | 'humidity' | 'smoke';
type ActivityType = 'ALL' | 'ALERT' | 'SYSTEM' | 'CONTROL';
type ActivitySeverity = 'ALL' | 'NORMAL' | 'INFO' | 'WARNING' | 'CRITICAL';
type ActivitySort = 'NEWEST' | 'OLDEST' | 'SEVERITY';

interface CommandView {
  command: string;
  status: string;
  reason?: string;
}

interface ActivityItem {
  id: string;
  category: Exclude<ActivityType, 'ALL'>;
  severity: Exclude<ActivitySeverity, 'ALL'>;
  title: string;
  message: string;
  createdAt: string;
  deviceName: string;
  expanded?: boolean;
}

interface NotificationItem extends ActivityItem { read: boolean; }
interface ToastItem {
  id: number;
  title: string;
  message: string;
  severity: Exclude<ActivitySeverity, 'ALL'>;
}

function loadReadNotificationIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem('iot-fire-read-notifications') ?? '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

@Component({
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('metricChart') metricCanvas?: ElementRef<HTMLCanvasElement>;

  private api = inject(ApiService);
  private auth = inject(AuthService);
  private realtime = inject(RealtimeService);
  private push = inject(PushNotificationService);
  private router = inject(Router);
  private subs: Subscription[] = [];
  private metricChart?: Chart;
  private toastSequence = 0;
  private toastTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly readNotificationIds = new Set<string>(loadReadNotificationIds());
  private readonly recentEventIds = new Set<string>();

  devices: any[] = [];
  selectedDevice = 'ESP32_001';
  latest: any = null;
  readings: any[] = [];
  alerts: any[] = [];
  activities: ActivityItem[] = [];
  notifications: NotificationItem[] = [];
  toasts: ToastItem[] = [];
  fireAlert: any = null;
  lastCommand: CommandView | null = null;
  apiError = '';
  realtimeError = '';
  loading = true;
  commandBusy = false;
  notificationPermissionDenied = false;
  notificationOpen = false;
  importantNotificationsOnly = false;
  chartMetric: ChartMetric = 'temperature';
  activityType: ActivityType = 'ALL';
  activitySeverity: ActivitySeverity = 'ALL';
  activitySort: ActivitySort = 'NEWEST';
  activitySearch = '';
  activityPage = 1;
  readonly activityPageSize = 5;
  role = this.auth.role();
  username = localStorage.getItem('username') ?? 'Người dùng';

  get device(): any | undefined {
    return this.devices.find(d => d.deviceCode === this.selectedDevice);
  }

  get isOnline(): boolean {
    return this.device?.status === 'ONLINE';
  }

  get selectedDeviceName(): string {
    return this.friendlyDeviceName(this.device ?? { deviceCode: this.selectedDevice });
  }

  get lastSeen(): string | null {
    return this.device?.lastSeen ?? this.latest?.lastSeen ?? this.latest?.receivedAt ?? null;
  }

  get currentState(): string {
    return this.latest?.systemState ?? this.latest?.state ?? this.device?.currentState ?? 'UNKNOWN';
  }

  get currentMode(): string {
    return this.latest?.mode ?? this.device?.currentMode ?? 'UNKNOWN';
  }

  get stateLabel(): string {
    if (!this.isOnline) return 'Mất kết nối';
    const labels: Record<string, string> = {
      NORMAL: 'Bình thường', HOT: 'Nhiệt độ cao', WARNING: 'Cảnh báo',
      HIGH_RISK: 'Nguy cơ cao', FIRE: 'Phát hiện cháy',
      SUPPRESSING: 'Đang xử lý', POST_FIRE: 'Sau sự cố', UNKNOWN: 'Chưa xác định'
    };
    return labels[this.currentState] ?? labels['UNKNOWN'];
  }

  get modeLabel(): string {
    return this.currentMode === 'AUTO' ? 'Tự động' : this.currentMode === 'MANUAL' ? 'Thủ công' : 'Chưa xác định';
  }

  get stateTone(): string {
    if (!this.isOnline) return 'state-offline';
    if (['FIRE', 'SUPPRESSING'].includes(this.currentState)) return 'state-danger';
    if (['WARNING', 'HIGH_RISK'].includes(this.currentState)) return 'state-warning';
    if (this.currentState === 'HOT' || this.currentState === 'POST_FIRE') return 'state-caution';
    if (this.currentState === 'NORMAL') return 'state-normal';
    return 'state-neutral';
  }

  get isCriticalState(): boolean {
    return ['HIGH_RISK', 'FIRE', 'SUPPRESSING'].includes(this.currentState);
  }

  get stateDescription(): string {
    const descriptions: Record<string, string> = {
      NORMAL: 'Mọi chỉ số đang trong ngưỡng an toàn.',
      HOT: 'Nhiệt độ cao hơn bình thường, hãy tiếp tục theo dõi.',
      WARNING: 'Hệ thống phát hiện dấu hiệu bất thường cần chú ý.',
      HIGH_RISK: 'Nguy cơ cháy đang ở mức cao, còi cảnh báo được duy trì.',
      FIRE: 'Đã phát hiện cháy. Hệ thống đang ưu tiên các biện pháp an toàn.',
      SUPPRESSING: 'Hệ thống đang thực hiện quy trình xử lý cháy.',
      POST_FIRE: 'Sự cố đã giảm, cần kiểm tra trước khi đặt lại cảnh báo.',
      UNKNOWN: 'Chưa nhận được dữ liệu trạng thái.'
    };
    return !this.isOnline ? 'Không nhận được dữ liệu mới từ thiết bị giám sát.' : descriptions[this.currentState] ?? descriptions['UNKNOWN'];
  }

  get isSafetyState(): boolean {
    return ['WARNING', 'HIGH_RISK', 'FIRE', 'SUPPRESSING'].includes(this.currentState);
  }

  get buzzerSafetyMessage(): string {
    if (this.currentState === 'HIGH_RISK')
      return 'Còi bắt buộc hoạt động khi hệ thống ở mức nguy cơ cao.';
    if (this.currentState === 'FIRE')
      return 'Không thể tắt còi khi đã xác nhận cháy.';
    if (this.currentState === 'SUPPRESSING')
      return 'Không thể tắt còi trong quá trình xử lý cháy.';
    if (this.currentState === 'POST_FIRE')
      return 'Cảnh báo sau sự cố được duy trì cho đến khi đặt lại an toàn.';
    if (this.currentState === 'WARNING' && this.currentMode === 'MANUAL')
      return 'Ở chế độ Thủ công, bạn có thể tắt còi nhưng trạng thái Cảnh báo vẫn được duy trì.';
    return '';
  }

  get controlsDisabled(): boolean {
    return !this.isOnline || this.commandBusy;
  }

  get userInitial(): string {
    return this.username.trim().charAt(0).toUpperCase() || 'U';
  }

  get temperatureTone(): string {
    const value = this.latest?.temperature;
    if (value == null) return 'metric-neutral';
    if (value >= 50) return 'metric-danger';
    if (value >= 40) return 'metric-warning';
    return 'metric-normal';
  }

  get smokeTone(): string {
    const level = this.latest?.smokeLevel;
    if (level === 'CRITICAL') return 'metric-danger';
    if (level === 'WARNING') return 'metric-warning';
    return 'metric-normal';
  }

  get flameTone(): string {
    if (this.latest?.flameConfirmed) return 'metric-danger';
    if (this.latest?.flameDetected) return 'metric-warning';
    return 'metric-normal';
  }

  get chartTitle(): string {
    return this.chartMetric === 'temperature'
      ? 'Nhiệt độ'
      : this.chartMetric === 'humidity'
        ? 'Độ ẩm'
        : 'Khói / khí';
  }

  get chartCurrentValue(): string {
    if (!this.latest) return '--';
    if (this.chartMetric === 'temperature') return `${this.latest.temperature ?? '--'} °C`;
    if (this.chartMetric === 'humidity') return `${this.latest.humidity ?? '--'} %`;
    return `${this.latest.smokeRaw ?? '--'}`;
  }

  get temperatureDescription(): string {
    const value = this.latest?.temperature;
    if (value == null) return 'Chưa có dữ liệu';
    if (value >= 50) return 'Nhiệt độ nguy hiểm';
    if (value >= 40) return 'Cao hơn bình thường';
    return 'Trong ngưỡng an toàn';
  }

  get smokeDescription(): string {
    if (this.latest?.smokeLevel === 'CRITICAL') return 'Mức khói/khí nguy hiểm';
    if (this.latest?.smokeLevel === 'WARNING') return 'Có dấu hiệu bất thường';
    return 'Không phát hiện bất thường';
  }

  get flameDescription(): string {
    if (this.latest?.flameConfirmed) return 'Đã xác nhận có lửa';
    if (this.latest?.flameDetected) return 'Có tín hiệu nghi ngờ';
    return 'Không phát hiện lửa';
  }

  get heatRateDescription(): string {
    const rate = this.latest?.temperatureRate;
    if (rate == null) return 'Chưa có dữ liệu';
    if (rate >= 0.35) return 'Đang tăng nhanh';
    if (rate > 0.1) return 'Đang tăng nhẹ';
    return 'Ổn định';
  }

  get unreadNotificationCount(): number {
    return this.notifications.filter(item => !item.read).length;
  }

  get visibleNotifications(): NotificationItem[] {
    const items = this.importantNotificationsOnly
      ? this.notifications.filter(item => item.severity === 'CRITICAL' || item.severity === 'WARNING')
      : this.notifications;
    return items.slice(0, 8);
  }

  get filteredActivities(): ActivityItem[] {
    const term = this.activitySearch.trim().toLocaleLowerCase('vi');
    const severityRank: Record<ActivityItem['severity'], number> = { CRITICAL: 4, WARNING: 3, INFO: 2, NORMAL: 1 };
    const items = this.activities.filter(item => {
      const typeMatches = this.activityType === 'ALL' || item.category === this.activityType;
      const severityMatches = this.activitySeverity === 'ALL' || item.severity === this.activitySeverity;
      const searchMatches = !term || `${item.title} ${item.message} ${item.deviceName}`.toLocaleLowerCase('vi').includes(term);
      return typeMatches && severityMatches && searchMatches;
    });
    return items.sort((a, b) => {
      if (this.activitySort === 'OLDEST') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (this.activitySort === 'SEVERITY') {
        const difference = severityRank[b.severity] - severityRank[a.severity];
        if (difference) return difference;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  get activityTotalPages(): number {
    return Math.max(1, Math.ceil(this.filteredActivities.length / this.activityPageSize));
  }

  get pagedActivities(): ActivityItem[] {
    const page = Math.min(this.activityPage, this.activityTotalPages);
    return this.filteredActivities.slice((page - 1) * this.activityPageSize, page * this.activityPageSize);
  }

  ngOnInit(): void {
    this.bindRealtime();
    void this.push.initializeAfterLogin(false);
    this.loadInitial();
    this.realtime.start().catch(() => {
      this.realtimeError = 'Kết nối trực tiếp đang gián đoạn. Hệ thống sẽ tự thử lại.';
    });
  }

  private bindRealtime(): void {
    this.subs.push(this.push.permissionDenied$.subscribe(denied => this.notificationPermissionDenied = denied));
    this.subs.push(this.push.foregroundNotification$.subscribe(event => this.receiveNotification(event)));
    this.subs.push(this.realtime.connected$.subscribe(() => {
      this.realtimeError = '';
      if (this.devices.length) this.reloadDevice();
    }));
    this.subs.push(this.realtime.telemetry$.subscribe(reading => {
      if (reading.deviceId !== this.selectedDevice) return;
      this.updateDeviceConnection('ONLINE', reading.lastSeen ?? reading.receivedAt);
      this.latest = reading;
      this.loading = false;
      this.apiError = '';
      this.appendReading(reading);
    }));
    this.subs.push(this.realtime.connection$.subscribe(connection => {
      const status = connection.status ?? (connection.online ? 'ONLINE' : 'OFFLINE');
      this.updateDeviceInList(connection.deviceId, status, connection.lastSeen);
      if (status === 'OFFLINE') this.receiveNotification({
        deviceId: connection.deviceId,
        eventType: 'DEVICE_OFFLINE',
        severity: 'WARNING',
        message: 'Không nhận được dữ liệu mới từ thiết bị giám sát.',
        createdAt: new Date().toISOString()
      });
    }));
    this.subs.push(this.realtime.fire$.subscribe(event => {
      if (event.deviceId === this.selectedDevice) this.fireAlert = event;
    }));
    this.subs.push(this.realtime.alert$.subscribe(event => {
      this.receiveNotification(event);
      this.loadActivities();
    }));
    this.subs.push(this.realtime.commandStatus$.subscribe(response => {
      if (response.deviceId && response.deviceId !== this.selectedDevice) return;
      this.commandBusy = false;
      this.lastCommand = {
        command: response.command,
        status: response.status,
        reason: response.reason
      };
      this.addCommandActivity(response);
      this.showToast(
        response.status === 'ACKNOWLEDGED' ? 'Đã thực hiện thao tác' : 'Không thể thực hiện thao tác',
        `${this.commandLabel(response.command)}: ${this.commandStatusLabel(response.status)}`,
        response.status === 'ACKNOWLEDGED' ? 'INFO' : 'WARNING'
      );
    }));
  }

  ngAfterViewInit(): void {
    this.renderChart();
  }

  ngOnDestroy(): void {
    this.subs.forEach(subscription => subscription.unsubscribe());
    this.toastTimers.forEach(timer => clearTimeout(timer));
    void this.realtime.stop();
    this.metricChart?.destroy();
  }

  loadInitial(): void {
    this.loading = true;
    this.api.devices().subscribe({
      next: devices => {
        this.devices = devices;
        if (devices.length && !devices.some(device => device.deviceCode === this.selectedDevice))
          this.selectedDevice = devices[0].deviceCode;
        if (devices.length) this.reloadDevice();
        else {
          this.loading = false;
          this.apiError = 'Chưa có thiết bị giám sát. Dữ liệu sẽ xuất hiện khi thiết bị kết nối.';
        }
      },
      error: () => {
        this.loading = false;
        this.apiError = 'Không thể tải thông tin thiết bị giám sát.';
      }
    });
    this.loadActivities();
    this.loadAlerts();
  }

  onDeviceChange(): void {
    this.fireAlert = null;
    this.lastCommand = null;
    this.reloadDevice();
  }

  reloadDevice(): void {
    if (!this.selectedDevice) return;
    this.loading = true;
    this.apiError = '';
    this.api.latest(this.selectedDevice).subscribe({
      next: response => {
        this.mergeDevice(response.device);
        this.latest = response.reading
          ? { ...response.reading, status: response.device.status, lastSeen: response.device.lastSeen }
          : null;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.apiError = 'Không thể tải dữ liệu mới nhất. Dữ liệu đang hiển thị có thể đã cũ.';
      }
    });
    this.api.readings(this.selectedDevice, 100).subscribe({
      next: response => {
        this.readings = [...(response.items ?? [])]
          .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
          .slice(-100);
        this.renderChart();
      },
      error: () => this.apiError = 'Không thể tải dữ liệu biểu đồ.'
    });
  }

  loadAlerts(): void {
    this.api.alerts().subscribe({
      next: alerts => {
        this.alerts = alerts;
        this.notifications = alerts.map(alert => {
          const item = this.mapAlertToNotification(alert);
          return { ...item, read: this.readNotificationIds.has(item.id) || Boolean(alert.isAcknowledged) };
        });
      },
      error: () => this.apiError ||= 'Không thể tải danh sách cảnh báo.'
    });
  }

  loadActivities(): void {
    this.api.events().subscribe({
      next: events => {
        const commands = this.activities.filter(item => item.category === 'CONTROL');
        this.activities = [...commands, ...events.map(event => this.mapEventToActivity(event))];
        this.activityPage = Math.min(this.activityPage, this.activityTotalPages);
      },
      error: () => this.apiError ||= 'Không thể tải lịch sử hoạt động.'
    });
  }

  private mergeDevice(updated: any): void {
    if (!updated) return;
    const index = this.devices.findIndex(device => device.deviceCode === updated.deviceCode);
    if (index >= 0) this.devices[index] = { ...this.devices[index], ...updated };
    else this.devices.push(updated);
  }

  private updateDeviceConnection(status: string, lastSeen?: string): void {
    this.updateDeviceInList(this.selectedDevice, status, lastSeen);
  }

  private updateDeviceInList(deviceId: string, status: string, lastSeen?: string): void {
    const index = this.devices.findIndex(device => device.deviceCode === deviceId);
    if (index >= 0)
      this.devices[index] = { ...this.devices[index], status, lastSeen: lastSeen ?? this.devices[index].lastSeen };
    else
      this.devices.push({ deviceCode: deviceId, name: '', status, lastSeen: lastSeen ?? null });
  }

  friendlyDeviceName(device: any): string {
    return 'Thiết bị giám sát';
  }

  private mapEventToActivity(event: any): ActivityItem {
    const severity = this.normalizeSeverity(event.severity);
    return {
      id: `event-${event.id ?? `${event.eventType}-${event.createdAt}`}`,
      category: severity === 'CRITICAL' || severity === 'WARNING' ? 'ALERT' : 'SYSTEM',
      severity,
      title: this.eventTitle(event.eventType),
      message: this.friendlyMessage(event.message, event.eventType),
      createdAt: event.createdAt ?? new Date().toISOString(),
      deviceName: this.friendlyDeviceName(event.device ?? { deviceCode: event.deviceId })
    };
  }

  private mapAlertToNotification(alert: any): NotificationItem {
    const activity = this.mapEventToActivity({
      ...alert,
      eventType: alert.type ?? alert.eventType,
      deviceId: alert.deviceId ?? alert.device?.deviceCode
    });
    return { ...activity, id: `alert-${alert.id ?? activity.id}`, category: 'ALERT', read: false };
  }

  private receiveNotification(event: any): void {
    const eventId = String(event.eventId ?? event.id ?? '');
    if (eventId && this.recentEventIds.has(eventId)) return;
    if (eventId) {
      this.recentEventIds.add(eventId);
      if (this.recentEventIds.size > 100) this.recentEventIds.delete(this.recentEventIds.values().next().value!);
    }
    const notification = this.mapAlertToNotification({
      ...event,
      id: eventId || `${Date.now()}-${event.eventType}`,
      message: event.message ?? event.body
    });
    this.notifications = [notification, ...this.notifications.filter(item => item.id !== notification.id)];
    this.showToast(notification.title, notification.message, notification.severity);
  }

  private addCommandActivity(response: any): void {
    const acknowledged = response.status === 'ACKNOWLEDGED';
    const item: ActivityItem = {
      id: `command-${response.commandId ?? Date.now()}`,
      category: 'CONTROL',
      severity: acknowledged ? 'INFO' : 'WARNING',
      title: this.commandLabel(response.command),
      message: response.reason || this.commandStatusLabel(response.status),
      createdAt: new Date().toISOString(),
      deviceName: this.selectedDeviceName
    };
    this.activities = [item, ...this.activities.filter(activity => activity.id !== item.id)];
  }

  appendReading(reading: any): void {
    const duplicate = this.readings.some(item =>
      (reading.id && item.id === reading.id) ||
      (!reading.id && item.receivedAt === reading.receivedAt && item.uptimeMs === reading.uptimeMs));
    if (!duplicate) this.readings.push(reading);
    this.readings = this.readings
      .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
      .slice(-100);
    this.renderChart();
  }

  selectChartMetric(metric: ChartMetric): void {
    if (this.chartMetric === metric) return;
    this.chartMetric = metric;
    this.renderChart();
  }

  renderChart(): void {
    if (!this.metricCanvas) return;

    const metricConfig = {
      temperature: { field: 'temperature', label: 'Nhiệt độ (°C)', color: '#f04438', soft: 'rgba(240,68,56,.12)' },
      humidity: { field: 'humidity', label: 'Độ ẩm (%)', color: '#1677ff', soft: 'rgba(22,119,255,.12)' },
      smoke: { field: 'smokeRaw', label: 'Mức khói / khí', color: '#7a5af8', soft: 'rgba(122,90,248,.12)' }
    }[this.chartMetric];

    const labels = this.readings.map(reading => new Date(reading.receivedAt).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
    const values = this.readings.map(reading => reading[metricConfig.field]);

    this.metricChart?.destroy();
    this.metricChart = new Chart(this.metricCanvas.nativeElement, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: metricConfig.label,
          data: values,
          borderColor: metricConfig.color,
          backgroundColor: metricConfig.soft,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.35,
          spanGaps: true,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: { displayColors: false }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#667085', maxTicksLimit: 7, maxRotation: 0 }
          },
          y: {
            beginAtZero: this.chartMetric === 'smoke',
            border: { display: false },
            grid: { color: 'rgba(16,24,40,.06)' },
            ticks: { color: '#667085', maxTicksLimit: 5 }
          }
        }
      }
    });
  }

  toggleNotificationCenter(): void {
    this.notificationOpen = !this.notificationOpen;
  }

  markNotificationRead(item: NotificationItem): void {
    item.read = true;
    this.readNotificationIds.add(item.id);
    this.persistReadNotifications();
  }

  markAllNotificationsRead(): void {
    this.notifications.forEach(item => {
      item.read = true;
      this.readNotificationIds.add(item.id);
    });
    this.persistReadNotifications();
  }

  openNotification(item: NotificationItem): void {
    this.markNotificationRead(item);
    this.notificationOpen = false;
    this.activityType = 'ALERT';
    this.activitySearch = item.title;
    this.activityPage = 1;
    document.getElementById('activity-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private persistReadNotifications(): void {
    localStorage.setItem('iot-fire-read-notifications', JSON.stringify([...this.readNotificationIds].slice(-500)));
  }

  showToast(title: string, message: string, severity: Exclude<ActivitySeverity, 'ALL'>): void {
    const toast: ToastItem = { id: ++this.toastSequence, title, message, severity };
    this.toasts = [...this.toasts.slice(-2), toast];
    this.toastTimers.push(setTimeout(() => this.dismissToast(toast.id), severity === 'CRITICAL' ? 9000 : 5500));
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter(toast => toast.id !== id);
  }

  setActivityType(type: ActivityType): void {
    this.activityType = type;
    this.activityPage = 1;
  }

  activityFiltersChanged(): void {
    this.activityPage = 1;
  }

  previousActivityPage(): void {
    this.activityPage = Math.max(1, this.activityPage - 1);
  }

  nextActivityPage(): void {
    this.activityPage = Math.min(this.activityTotalPages, this.activityPage + 1);
  }

  toggleActivity(item: ActivityItem): void {
    item.expanded = !item.expanded;
  }

  send(command: string): void {
    const buzzerBlockReason = this.buzzerBlockReason(command);
    if (buzzerBlockReason) {
      this.lastCommand = { command, status: 'BLOCKED', reason: buzzerBlockReason };
      this.showToast('Không thể thực hiện', buzzerBlockReason, 'WARNING');
      return;
    }
    if (!this.beginCommand(command)) return;
    this.api.command(this.selectedDevice, command).subscribe({
      next: response => this.lastCommand = { command, status: response.status ?? 'SENT' },
      error: error => this.finishCommandWithError(command, error)
    });
  }

  setMode(mode: 'AUTO' | 'MANUAL'): void {
    const command = mode === 'AUTO' ? 'SET_AUTO_MODE' : 'SET_MANUAL_MODE';
    if (!this.beginCommand(command)) return;
    this.api.setMode(this.selectedDevice, mode).subscribe({
      next: response => this.lastCommand = { command, status: response.status ?? 'SENT' },
      error: error => this.finishCommandWithError(command, error)
    });
  }

  resetAlarm(): void {
    const command = 'RESET_ALARM';
    if (!this.beginCommand(command)) return;
    this.api.resetAlarm(this.selectedDevice).subscribe({
      next: response => this.lastCommand = { command, status: response.status ?? 'SENT' },
      error: error => this.finishCommandWithError(command, error)
    });
  }

  private beginCommand(command: string): boolean {
    if (!this.isOnline) {
      this.lastCommand = { command, status: 'BLOCKED', reason: 'Thiết bị giám sát đang mất kết nối' };
      this.showToast('Không thể điều khiển', 'Thiết bị giám sát đang mất kết nối.', 'WARNING');
      return false;
    }
    this.commandBusy = true;
    this.lastCommand = { command, status: 'SENDING' };
    return true;
  }

  private finishCommandWithError(command: string, error: any): void {
    this.commandBusy = false;
    const reason = error?.error?.message ?? error?.error?.code ?? 'Không thể gửi yêu cầu điều khiển';
    this.lastCommand = {
      command,
      status: error?.status === 409 ? 'REJECTED' : 'FAILED',
      reason
    };
    this.showToast('Thao tác không thành công', reason, 'WARNING');
  }

  fanOnDisabled(): boolean {
    return this.controlsDisabled || ['FIRE', 'SUPPRESSING', 'HIGH_RISK', 'WARNING'].includes(this.currentState);
  }

  pumpOnDisabled(): boolean {
    return this.controlsDisabled || this.currentState !== 'NORMAL';
  }

  pumpOffDisabled(): boolean {
    return this.controlsDisabled || ['FIRE', 'SUPPRESSING'].includes(this.currentState);
  }

  buzzerOnDisabled(): boolean {
    return this.controlsDisabled || this.currentMode !== 'MANUAL';
  }

  buzzerOffDisabled(): boolean {
    return this.controlsDisabled ||
      this.currentMode !== 'MANUAL' ||
      ['HIGH_RISK', 'FIRE', 'SUPPRESSING', 'POST_FIRE'].includes(this.currentState);
  }

  buzzerTooltip(command: 'BUZZER_ON' | 'BUZZER_OFF'): string {
    if (!this.isOnline) return 'Không thể điều khiển khi thiết bị offline';
    if (this.currentMode !== 'MANUAL') return 'Chuyển sang Thủ công để điều khiển còi';
    if (command === 'BUZZER_OFF') {
      if (this.currentState === 'HIGH_RISK')
        return 'Không thể tắt còi khi hệ thống đang ở mức nguy cơ cao';
      if (this.currentState === 'FIRE') return 'Không thể tắt còi khi đã xác nhận cháy';
      if (this.currentState === 'SUPPRESSING') return 'Không thể tắt còi trong quá trình xử lý cháy';
      if (this.currentState === 'POST_FIRE') return 'Cần đặt lại cảnh báo sau khi kiểm tra an toàn';
    }
    return '';
  }

  private buzzerBlockReason(command: string): string {
    if (command !== 'BUZZER_ON' && command !== 'BUZZER_OFF') return '';
    if (this.currentMode !== 'MANUAL') return 'Chuyển sang Thủ công để điều khiển còi';
    return command === 'BUZZER_OFF' ? this.buzzerTooltip('BUZZER_OFF') : '';
  }

  commandTone(status: string): string {
    if (status === 'ACKNOWLEDGED') return 'command-success';
    if (['REJECTED', 'FAILED', 'TIMEOUT', 'BLOCKED'].includes(status)) return 'command-error';
    return 'command-pending';
  }

  commandLabel(command: string): string {
    const labels: Record<string, string> = {
      FAN_ON: 'Bật quạt thông gió', FAN_OFF: 'Tắt quạt thông gió',
      PUMP_ON: 'Bật bơm chữa cháy', PUMP_OFF: 'Tắt bơm chữa cháy',
      BUZZER_ON: 'Bật còi cảnh báo', BUZZER_OFF: 'Tắt còi cảnh báo',
      SET_AUTO_MODE: 'Chuyển sang Tự động', SET_MANUAL_MODE: 'Chuyển sang Thủ công',
      RESET_ALARM: 'Đặt lại cảnh báo'
    };
    return labels[command] ?? 'Thao tác điều khiển';
  }

  commandStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      ACKNOWLEDGED: 'Đã thực hiện', REJECTED: 'Bị từ chối', FAILED: 'Không thành công',
      TIMEOUT: 'Quá thời gian', SENT: 'Đã gửi', SENDING: 'Đang gửi', BLOCKED: 'Không được phép'
    };
    return labels[status] ?? status;
  }

  severityTone(severity: string): string {
    const value = this.normalizeSeverity(severity);
    if (value === 'CRITICAL') return 'severity-critical';
    if (value === 'WARNING') return 'severity-warning';
    if (value === 'NORMAL') return 'severity-normal';
    return 'severity-info';
  }

  severityLabel(severity: string): string {
    const value = this.normalizeSeverity(severity);
    return { CRITICAL: 'Nguy hiểm', WARNING: 'Cảnh báo', INFO: 'Thông báo', NORMAL: 'Bình thường' }[value];
  }

  categoryLabel(category: ActivityItem['category']): string {
    return { ALERT: 'Cảnh báo', SYSTEM: 'Hệ thống', CONTROL: 'Điều khiển' }[category];
  }

  private normalizeSeverity(severity: string): ActivityItem['severity'] {
    const value = (severity || 'INFO').toUpperCase();
    if (value === 'CRITICAL' || value === 'HIGH') return 'CRITICAL';
    if (value === 'WARNING') return 'WARNING';
    if (value === 'NORMAL' || value === 'LOW') return 'NORMAL';
    return 'INFO';
  }

  private eventTitle(type: string): string {
    const titles: Record<string, string> = {
      FIRE_DETECTED: 'Phát hiện nguy cơ cháy', HIGH_RISK: 'Nguy cơ cháy tăng cao',
      FIRE_SUPPRESSING: 'Đang kích hoạt xử lý cháy', FIRE_CLEARED: 'Tình trạng cháy đã giảm',
      SMOKE_WARNING: 'Phát hiện khói hoặc khí bất thường', HIGH_TEMPERATURE: 'Nhiệt độ tăng cao',
      DEVICE_OFFLINE: 'Mất kết nối thiết bị giám sát',
      WARNING: 'Có dấu hiệu bất thường', FIRE: 'CẢNH BÁO CHÁY', SUPPRESSING: 'Đang xử lý sự cố',
      POST_FIRE: 'Ngọn lửa đã được dập', DEVICE_ONLINE: 'Đã kết nối lại'
    };
    return titles[type] ?? 'Cập nhật từ hệ thống';
  }

  private friendlyMessage(message: string, type: string): string {
    const messages: Record<string, string> = {
      FIRE_DETECTED: 'Hệ thống đã xác nhận dấu hiệu cháy và chuyển sang chế độ an toàn.',
      HIGH_RISK: 'Nhiệt độ và khói đang ở mức nguy hiểm, cần kiểm tra ngay.',
      FIRE_SUPPRESSING: 'Bơm chữa cháy đang hoạt động, quạt thông gió đã được tắt.',
      FIRE_CLEARED: 'Không còn phát hiện lửa, hệ thống đang chờ kiểm tra và đặt lại.',
      SMOKE_WARNING: 'Mức khói hoặc khí cao hơn bình thường.',
      HIGH_TEMPERATURE: 'Nhiệt độ đã vượt ngưỡng làm mát.',
      DEVICE_OFFLINE: 'Không nhận được dữ liệu mới trong khoảng thời gian cho phép.',
      WARNING: 'Hệ thống phát hiện khói hoặc khí bất thường.',
      FIRE: 'Hệ thống đã phát hiện cháy. Bơm chữa cháy đang được kích hoạt.',
      SUPPRESSING: 'Hệ thống đang thực hiện xử lý cháy.',
      POST_FIRE: 'Hệ thống đang chờ kiểm tra và xác nhận an toàn.',
      DEVICE_ONLINE: 'Thiết bị giám sát đã hoạt động trở lại.'
    };
    return messages[type] ?? message ?? 'Hệ thống vừa ghi nhận một thay đổi.';
  }

  trackByActivity(_: number, item: ActivityItem): string {
    return item.id;
  }

  formatEventType(type: string): string {
    return (type || 'EVENT').replaceAll('_', ' ');
  }

  async logout(): Promise<void> {
    await this.push.unregister();
    await this.realtime.stop();
    this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
