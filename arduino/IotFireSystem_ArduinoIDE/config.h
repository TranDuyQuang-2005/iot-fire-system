#pragma once

// ============================================================
// TESTED PIN MAP - GIỮ NGUYÊN THEO CODE BẠN ĐÃ TEST
// ============================================================
#define MQ2_AO 34
#define MQ2_DO 35
#define DHT_PIN 18
#define FLAME_PIN 23
#define BUZZER_PIN 19
#define BOM 21       // GPIO21 -> relay bơm (đã test thực tế)
#define QUAT 25      // GPIO25 -> relay quạt (đã test thực tế)
#define LED_RED 13
#define LED_GREEN 14
#define OLED_SDA 32
#define OLED_SCL 33

// Relay thực tế bạn đã test: HIGH = ON, LOW = OFF
#define RELAY_ON HIGH
#define RELAY_OFF LOW

// Buzzer đã được kiểm tra là active HIGH. Gom polarity tại đây để mọi lệnh
// và state safety luôn đi qua buzzerOn()/buzzerOff().
#define BUZZER_OUTPUT_ON HIGH
#define BUZZER_OUTPUT_OFF LOW

// ============================================================
// THIẾT BỊ
// ============================================================
#define DHT_TYPE DHT22
#define OLED_ADDRESS 0x3C
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1

// ============================================================
// NGƯỠNG BAN ĐẦU - TẤT CẢ ĐỂ TẬP TRUNG, KHÔNG HARDCODE RẢI RÁC
// MQ-2 của bạn: bình thường AO cao (~4095), có gas/khói AO giảm.
// ============================================================
constexpr int GAS_ON_THRESHOLD = 2000;
constexpr int GAS_OFF_THRESHOLD = 2600;
constexpr int SMOKE_CRITICAL_THRESHOLD = 1300;

constexpr float TEMP_FAN_ON = 40.0f;
constexpr float TEMP_FAN_OFF = 37.0f;
constexpr float TEMP_DANGER = 50.0f;
constexpr float TEMP_RATE_HIGH = 0.35f; // °C/s, cần hiệu chỉnh thực tế

constexpr unsigned long FLAME_CONFIRM_MS = 1000;
constexpr unsigned long FLAME_CLEAR_MS = 3000;
constexpr unsigned long HIGH_RISK_CONFIRM_MS = 5000;
constexpr unsigned long FIRE_TO_SUPPRESSING_MS = 1000;
constexpr unsigned long PUMP_MAX_RUNTIME_MS = 30000;

constexpr unsigned long SENSOR_INTERVAL_MS = 2000; // DHT22 nên đọc khoảng >= 2 giây/lần
constexpr unsigned long TELEMETRY_INTERVAL_MS = 4000;
constexpr unsigned long SERIAL_INTERVAL_MS = 2000;
constexpr unsigned long OLED_INTERVAL_MS = 500;
constexpr unsigned long GREEN_BLINK_INTERVAL_MS = 2000;
constexpr unsigned long WARNING_BLINK_INTERVAL_MS = 600;

// ============================================================
// MQTT
// ============================================================
constexpr char DEVICE_ID[] = "ESP32_001";
constexpr char MQTT_TELEMETRY_TOPIC[] = "iot/fire/device/ESP32_001/telemetry";
constexpr char MQTT_EVENT_TOPIC[] = "iot/fire/device/ESP32_001/event";
constexpr char MQTT_COMMAND_TOPIC[] = "iot/fire/device/ESP32_001/command";
constexpr char MQTT_COMMAND_RESPONSE_TOPIC[] = "iot/fire/device/ESP32_001/command-response";
