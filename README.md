# IOT FIRE SYSTEM – ESP32 + MQTT + ASP.NET Core + SQL Server + Angular

Bộ source này bám theo đề cương của nhóm: thiết bị biên ESP32 xử lý an toàn cục bộ, MQTT truyền Telemetry/Event/Command, ASP.NET Core + SQL Server xử lý/lưu trữ, SignalR phát realtime và Angular làm Dashboard.

## 1. PIN MAP ĐÃ KHÓA THEO CODE BẠN ĐÃ TEST

| Thiết bị | GPIO | Ghi chú |
|---|---:|---|
| MQ-2 AO | 34 | ADC input |
| MQ-2 DO | 35 | Digital input |
| DHT22 | 18 | Data |
| Flame Sensor | 23 | LOW = phát hiện lửa |
| Buzzer | 19 | HIGH = ON |
| Bơm / Relay | 21 | HIGH = ON – mapping đã test thực tế |
| Quạt / Relay | 25 | HIGH = ON – mapping đã test thực tế |
| LED đỏ | 13 | Output |
| LED xanh | 14 | Output |
| OLED SDA | 32 | I2C |
| OLED SCL | 33 | I2C |

**Mapping relay hiện tại đã chốt theo mạch thực tế: Bơm GPIO21, Quạt GPIO25.**

## 2. Điểm khác giữa code test cũ và logic đề cương

Code test cũ có 3 điểm phải sửa để đúng đề cương:

1. Code cũ bật quạt khi `gasDetected || tempWarning`; đề cương yêu cầu **khói/WARNING => FAN OFF**, chỉ HOT mới bật quạt.
2. Code cũ bật bơm khi `flameDetected || tempDanger`; đề cương yêu cầu **Flame phải được xác nhận ổn định (FlameConfirmed)** hoặc nhánh HIGH_RISK được xác nhận mới FIRE/PUMP ON.
3. Code cũ chưa có `NORMAL/HOT/WARNING/HIGH_RISK/FIRE/SUPPRESSING/POST_FIRE`, chưa có MQTT, AUTO/MANUAL, command response, offline handling.

Firmware mới trong `firmware/src/main.cpp` đã sửa các điểm này.

## 3. Phần cứng chưa có PIN đã test

Trong đề cương có LED vàng và EMERGENCY STOP, nhưng code test bạn gửi chỉ có:
- LED đỏ GPIO13
- LED xanh GPIO14
- chưa có GPIO LED vàng
- chưa có GPIO nút Emergency Stop

Vì vậy source **không tự bịa chân mới**. WARNING hiện dùng LED đỏ nhấp nháy + buzzer nhẹ. Khi bạn test thêm LED vàng/E-Stop, hãy thêm pin vào `config.h`.

## 4. Firmware ESP32

### Chuẩn bị

1. Cài VS Code + PlatformIO.
2. Copy:

```text
firmware/include/secrets.example.h
```

thành:

```text
firmware/include/secrets.h
```

3. Điền Wi-Fi và MQTT Broker IP.
4. Build/upload môi trường `esp32dev`.

### State Machine

```text
NORMAL
HOT
WARNING
HIGH_RISK
FIRE
SUPPRESSING
POST_FIRE
```

Quy tắc quan trọng:

```text
FlameDetected ổn định >= FLAME_CONFIRM_MS
-> FlameConfirmed
-> FIRE
```

Không bắt buộc MQ-2 phải cùng báo khói.

Nhánh 2:

```text
Smoke critical + dT/dt cao kéo dài
-> HIGH_RISK
-> FIRE
```

### MQTT topics

```text
iot/fire/device/ESP32_001/telemetry
iot/fire/device/ESP32_001/event
iot/fire/device/ESP32_001/command
iot/fire/device/ESP32_001/command-response
```

## 4.1. Arduino IDE (đang dùng trên máy hiện tại)

Project đã kèm sketch sẵn tại:

```text
arduino/IotFireSystem_ArduinoIDE/IotFireSystem_ArduinoIDE.ino
```

Chỉ cần sửa `secrets.h` nếu Wi-Fi/IP laptop thay đổi. Mapping đã chốt: `BOM=21`, `QUAT=25`.

## 5. MQTT / Mosquitto

### Tài khoản MQTT local đã cấu hình sẵn

```text
ESP32:   tai khoan rieng trong `secrets.h` (khong commit)
Backend: tai khoan rieng trong `.env` (khong commit)
```

`mosquitto/config/password_file` duoc git-ignore. Backend lay tai khoan MQTT tu `.env`; khong ghi mat khau vao source.


Source cấu hình yêu cầu username/password.

Tạo `mosquitto/config/password_file` trước khi `docker compose up`.

Ví dụ Linux/Git Bash:

```bash
docker run --rm -it -v "$(pwd)/mosquitto/config:/mosquitto/config" eclipse-mosquitto:2 \
  mosquitto_passwd -c /mosquitto/config/password_file iot_device

docker run --rm -it -v "$(pwd)/mosquitto/config:/mosquitto/config" eclipse-mosquitto:2 \
  mosquitto_passwd /mosquitto/config/password_file iot_backend
```

Đặt password trùng với `firmware/include/secrets.h` và `docker-compose.yml`.

## 6. Backend

Công nghệ:
- ASP.NET Core Web API
- EF Core + SQL Server
- MQTTnet
- SignalR
- JWT + Role
- Swagger/OpenAPI

API chính:

```text
POST /api/auth/login
GET  /api/devices
GET  /api/devices/{deviceId}
GET  /api/devices/{deviceId}/latest
GET  /api/devices/{deviceId}/readings
GET  /api/events
GET  /api/alerts
PUT  /api/alerts/{id}/acknowledge
POST /api/devices/{deviceId}/commands
PUT  /api/devices/{deviceId}/mode
POST /api/devices/{deviceId}/reset-alarm
```

SignalR hub:

```text
/iotHub
```

Events:

```text
TelemetryUpdated
DeviceStateChanged
AlertCreated
FireDetected
CommandStatusChanged
DeviceConnectionChanged
```

## 7. Database

EF Core áp dụng migration bằng `MigrateAsync()` và giữ nguyên dữ liệu hiện có. Database cũ từng được tạo bằng `EnsureCreated()` được baseline một lần trước khi migration mới chạy.

Bảng:
- Users
- Devices
- SensorReadings
- Events
- Alerts
- Commands
- AuditLogs
- UserPushTokens

Migration hiện có: `InitialCreate` và `AddUserPushTokens`.

## 8. Frontend Angular

Chức năng hiện có:
- Login JWT
- Giao diện một thiết bị, không hiển thị mã kỹ thuật trên Dashboard
- Realtime telemetry qua SignalR
- FIRE ALERT
- Cards Temperature/Humidity/MQ2/Flame/State/Fan/Pump
- Chart nhiệt độ và MQ-2
- Alert history
- AUTO/MANUAL
- Fan/Pump commands
- Reset Alarm
- Disable FAN ON ở trạng thái an toàn nguy hiểm
- Trung tâm thông báo, FCM foreground/background và deep-link về Dashboard trên Android

## 8.1 Android (Capacitor + Firebase)

Source Android nằm trực tiếp trong `frontend/android`, package `com.iotfire.monitoring`. Hướng dẫn cấu hình public HTTPS, Firebase, build APK và test thông báo nằm tại [ANDROID_APP.md](ANDROID_APP.md). Không tạo `google-services.json` hoặc service-account giả; hai file thật phải được người quản trị Firebase cung cấp và luôn nằm ngoài Git.

## 9. Chạy local

### Cách 1 – Docker cho Server

> Trên Windows hiện tại, chạy từ thư mục `E:\iot-fire-system`:
>
> ```bat
> docker compose up -d --build
> docker ps
> ```
>
> Mosquitto init sẽ tự đặt quyền đọc cho `password_file`; SQL Server có healthcheck để Backend chờ DB sẵn sàng.


1. Tạo MQTT password file.
2. Kiểm tra password trong `docker-compose.yml`.
3. Chạy:

```bash
docker compose up --build
```

- Backend: `http://localhost:8082`
- Swagger: `http://localhost:8082/swagger`
- Frontend: `http://localhost:4200`
- MQTT: `localhost:1883`
- SQL Server từ Windows/SSMS: `localhost:1434` (bên trong Docker vẫn là `sqlserver:1433`)

### ESP32 kết nối MQTT

Cloud runtime dùng hostname EMQX và TLS, không dùng IPv4 LAN:

```cpp
#define MQTT_HOST "e1110a86.ala.asia-southeast1.emqxsl.com"
#define MQTT_PORT 8883
#define MQTT_USE_TLS true
```

Mosquitto port 1883 chỉ được giữ làm fallback development. Khi dùng fallback, cấu hình hostname DNS/mDNS của máy chạy Docker thay vì ghi IP LAN cố định.

## 10. Tài khoản prototype

Mặc định nếu DB trống:

```text
username/password: cau hinh trong `.env`
```

**Đổi ngay khi demo trên mạng thật.**

## 11. Test bắt buộc theo đề cương

1. NORMAL: không khói, không lửa, nhiệt độ thấp -> fan/pump OFF.
2. HOT: nhiệt độ >= `TEMP_FAN_ON`, không khói/lửa -> fan ON.
3. WARNING: khói vượt ngưỡng -> fan OFF, pump OFF, cảnh báo.
4. Flame ngắn < 1s -> không FIRE.
5. Flame >= 1s -> FIRE ngay dù Smoke thấp và nhiệt độ bình thường.
6. FIRE -> fan OFF, pump/buzzer/LED đỏ ON.
7. Mất Wi-Fi -> local state machine vẫn xử lý FIRE.
8. MQTT/Backend nhận telemetry và event.
9. SQL Server lưu readings/events/alerts/commands.
10. Angular nhận SignalR và hiện FIRE ALERT.
11. FAN_ON bị reject khi FIRE/WARNING/HIGH_RISK/SUPPRESSING.
12. POST_FIRE chỉ RESET khi môi trường an toàn.

## 12. Các ngưỡng cần hiệu chỉnh sau khi lắp thật

Hiện giữ dữ liệu bạn đã test:

```text
GAS_ON_THRESHOLD  = 2000
GAS_OFF_THRESHOLD = 2600
TEMP_FAN_ON        = 40°C
TEMP_DANGER        = 50°C
FLAME_CONFIRM_MS   = 1000ms
```

`SMOKE_CRITICAL_THRESHOLD`, `TEMP_RATE_HIGH` và thời gian HIGH_RISK cần thu log thực tế rồi hiệu chỉnh.
