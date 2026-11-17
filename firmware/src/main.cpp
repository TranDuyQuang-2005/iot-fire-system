#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <time.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>

#include "config.h"
#include "types.h"
#include "secrets.h"
#include "mqtt_ca.h"

// ============================================================
// HARDWARE OBJECTS
// ============================================================
DHT dht(DHT_PIN, DHT_TYPE);
Adafruit_SH1106G display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
WiFiClient wifiClient;
WiFiClientSecure secureWifiClient;
Client& mqttNetworkClient = MQTT_USE_TLS
    ? static_cast<Client&>(secureWifiClient)
    : static_cast<Client&>(wifiClient);
PubSubClient mqtt(mqttNetworkClient);

// ============================================================
// RUNTIME STATE
// ============================================================
SensorSnapshot sensors;
ActuatorState actuators;
SystemState systemState = SystemState::NORMAL;
SystemState previousState = SystemState::NORMAL;
SystemMode systemMode = SystemMode::AUTO;

bool oledOk = false;
bool manualFanRequest = false;
bool manualPumpRequest = false;
bool manualBuzzerRequest = false;
bool manualBuzzerOverride = false;
bool resetRequested = false;
bool pumpSafetyLatchedOff = false;

unsigned long stateEnteredAt = 0;
unsigned long pumpStartedAt = 0;
unsigned long flameFirstDetectedAt = 0;
unsigned long flameClearStartedAt = 0;
unsigned long highRiskStartedAt = 0;
unsigned long previousSensorAt = 0;
unsigned long previousTelemetryAt = 0;
unsigned long previousSerialAt = 0;
unsigned long previousOledAt = 0;
unsigned long previousGreenBlinkAt = 0;
unsigned long previousWarningBlinkAt = 0;

bool greenBlinkState = false;
bool warningBlinkState = false;
bool tlsClockSyncRequested = false;
bool tlsConfigurationErrorLogged = false;

float previousTemperature = NAN;
unsigned long previousTemperatureAt = 0;

// ============================================================
// HELPERS
// ============================================================
void setState(SystemState nextState) {
  if (nextState == systemState) return;
  previousState = systemState;
  systemState = nextState;
  stateEnteredAt = millis();

  // Khi bắt đầu một sự kiện FIRE mới, cho phép bơm chạy lại.
  if (systemState == SystemState::FIRE &&
      previousState != SystemState::SUPPRESSING &&
      previousState != SystemState::FIRE) {
    pumpSafetyLatchedOff = false;
    pumpStartedAt = 0;
  }

  // Ra khỏi chuỗi FIRE/SUPPRESSING thì reset bộ giới hạn runtime.
  if (systemState == SystemState::NORMAL ||
      systemState == SystemState::HOT ||
      systemState == SystemState::WARNING ||
      systemState == SystemState::HIGH_RISK) {
    pumpSafetyLatchedOff = false;
    pumpStartedAt = 0;
  }

  Serial.printf("[STATE] %s -> %s\n",
                stateToString(previousState),
                stateToString(systemState));
}

void fanOn() {
  digitalWrite(QUAT, RELAY_ON);
  actuators.fanOn = true;
}

void fanOff() {
  digitalWrite(QUAT, RELAY_OFF);
  actuators.fanOn = false;
}

void pumpOn() {
  if (!actuators.pumpOn) pumpStartedAt = millis();
  digitalWrite(BOM, RELAY_ON);
  actuators.pumpOn = true;
}

void pumpOff() {
  digitalWrite(BOM, RELAY_OFF);
  actuators.pumpOn = false;
}

void buzzerOn() {
  digitalWrite(BUZZER_PIN, BUZZER_OUTPUT_ON);
  actuators.buzzerOn = true;
}

void buzzerOff() {
  digitalWrite(BUZZER_PIN, BUZZER_OUTPUT_OFF);
  actuators.buzzerOn = false;
}

void redLed(bool on) {
  digitalWrite(LED_RED, on ? HIGH : LOW);
  actuators.redLedOn = on;
}

void greenLed(bool on) {
  digitalWrite(LED_GREEN, on ? HIGH : LOW);
  actuators.greenLedOn = on;
}

int readMQ2Average() {
  long total = 0;
  for (int i = 0; i < 10; i++) {
    total += analogRead(MQ2_AO);
    delay(5);
  }
  return static_cast<int>(total / 10);
}

// ============================================================
// SENSOR PROCESSING
// ============================================================
void updateFlameConfirmation(unsigned long now) {
  if (sensors.flameDetected) {
    flameClearStartedAt = 0;
    if (flameFirstDetectedAt == 0) flameFirstDetectedAt = now;
    sensors.flameConfirmed = (now - flameFirstDetectedAt >= FLAME_CONFIRM_MS);
  } else {
    flameFirstDetectedAt = 0;
    sensors.flameConfirmed = false;
    if (flameClearStartedAt == 0) flameClearStartedAt = now;
  }
}

void updateTemperatureRate(unsigned long now) {
  if (!sensors.dhtOk) {
    sensors.temperatureRate = 0.0f;
    return;
  }

  if (!isnan(previousTemperature) && previousTemperatureAt > 0 && now > previousTemperatureAt) {
    float seconds = (now - previousTemperatureAt) / 1000.0f;
    if (seconds > 0.0f) {
      sensors.temperatureRate = (sensors.temperature - previousTemperature) / seconds;
    }
  }

  previousTemperature = sensors.temperature;
  previousTemperatureAt = now;
}

void readSensors() {
  const unsigned long now = millis();

  sensors.mq2Analog = readMQ2Average();
  sensors.mq2Digital = digitalRead(MQ2_DO);

  // Hysteresis đúng theo dữ liệu bạn đã test: AO càng thấp => gas/khói càng mạnh.
  if (!sensors.gasDetected) {
    if (sensors.mq2Analog < GAS_ON_THRESHOLD) sensors.gasDetected = true;
  } else {
    if (sensors.mq2Analog > GAS_OFF_THRESHOLD) sensors.gasDetected = false;
  }
  sensors.smokeCritical = sensors.mq2Analog <= SMOKE_CRITICAL_THRESHOLD;

  sensors.temperature = dht.readTemperature();
  sensors.humidity = dht.readHumidity();
  sensors.dhtOk = !isnan(sensors.temperature) && !isnan(sensors.humidity);
  updateTemperatureRate(now);

  sensors.flameDigital = digitalRead(FLAME_PIN);
  sensors.flameDetected = (sensors.flameDigital == LOW); // LOW = có lửa theo code bạn đã test
  updateFlameConfirmation(now);
}

// ============================================================
// STATE MACHINE
// ============================================================
bool isHighRiskCondition() {
  return sensors.smokeCritical &&
         sensors.dhtOk &&
         sensors.temperatureRate >= TEMP_RATE_HIGH;
}

bool isEnvironmentSafeAfterFire() {
  const bool flameClearedLongEnough = !sensors.flameDetected &&
                                      flameClearStartedAt > 0 &&
                                      (millis() - flameClearStartedAt >= FLAME_CLEAR_MS);
  return flameClearedLongEnough && !sensors.smokeCritical;
}

void evaluateStateMachine() {
  const unsigned long now = millis();

  // 1) Đang xử lý cháy: giữ state và chỉ rời khi lửa đã mất ổn định.
  if (systemState == SystemState::SUPPRESSING) {
    if (sensors.flameConfirmed || sensors.flameDetected) return;
    if (isEnvironmentSafeAfterFire()) {
      setState(SystemState::POST_FIRE);
    }
    return;
  }

  // 2) FIRE vừa được xác nhận.
  if (systemState == SystemState::FIRE) {
    if (sensors.flameConfirmed || sensors.flameDetected) {
      if (now - stateEnteredAt >= FIRE_TO_SUPPRESSING_MS) {
        setState(SystemState::SUPPRESSING);
      }
      return;
    }
    if (isEnvironmentSafeAfterFire()) {
      setState(SystemState::POST_FIRE);
    }
    return;
  }

  // 3) POST_FIRE chỉ quay về NORMAL khi có RESET và môi trường đã an toàn.
  if (systemState == SystemState::POST_FIRE) {
    if (sensors.flameConfirmed) {
      resetRequested = false;
      setState(SystemState::FIRE);
      return;
    }
    if (resetRequested && isEnvironmentSafeAfterFire()) {
      resetRequested = false;
      setState(SystemState::NORMAL);
    }
    return;
  }

  // 4) Nhánh 1 của đề cương: FlameConfirmed => FIRE ngay,
  // KHÔNG bắt buộc MQ-2 hoặc nhiệt độ phải đồng thời kích hoạt.
  if (sensors.flameConfirmed) {
    highRiskStartedAt = 0;
    setState(SystemState::FIRE);
    return;
  }

  // 5) Nhánh 2: khói rất cao + nhiệt độ tăng nhanh.
  if (isHighRiskCondition()) {
    if (highRiskStartedAt == 0) highRiskStartedAt = now;

    if (now - highRiskStartedAt >= HIGH_RISK_CONFIRM_MS) {
      setState(SystemState::FIRE);
    } else {
      setState(SystemState::HIGH_RISK);
    }
    return;
  }
  highRiskStartedAt = 0;

  // 6) Khói bất thường => WARNING và bắt buộc FAN OFF.
  if (sensors.gasDetected) {
    setState(SystemState::WARNING);
    return;
  }

  // 7) Nóng nhưng không có dấu hiệu cháy => HOT với hysteresis.
  if (sensors.dhtOk) {
    if (systemState == SystemState::HOT && sensors.temperature > TEMP_FAN_OFF) {
      return; // giữ HOT cho đến khi <= TEMP_FAN_OFF
    }
    if (sensors.temperature >= TEMP_FAN_ON) {
      setState(SystemState::HOT);
      return;
    }
  }

  setState(SystemState::NORMAL);
}

// ============================================================
// ACTUATOR CONTROLLER
// ============================================================
void applyActuators() {
  const unsigned long now = millis();

  // Giới hạn runtime bơm cho MÔ HÌNH THỬ NGHIỆM.
  // Một khi đạt giới hạn, bơm bị latch OFF cho đến khi chuỗi FIRE kết thúc/reset.
  if (actuators.pumpOn && pumpStartedAt > 0 &&
      now - pumpStartedAt >= PUMP_MAX_RUNTIME_MS) {
    pumpSafetyLatchedOff = true;
    pumpOff();
    Serial.println("[SAFETY] PUMP_MAX_RUNTIME reached -> PUMP forced OFF");
  }

  switch (systemState) {
    case SystemState::NORMAL:
      if (systemMode == SystemMode::MANUAL) {
        manualFanRequest ? fanOn() : fanOff();
        if (manualPumpRequest && !pumpSafetyLatchedOff) pumpOn(); else pumpOff();
      } else {
        fanOff();
        pumpOff();
      }
      if (systemMode == SystemMode::MANUAL && manualBuzzerOverride && manualBuzzerRequest) buzzerOn();
      else buzzerOff();
      redLed(false);
      break;

    case SystemState::HOT:
      // AUTO: bật quạt. MANUAL vẫn có thể tắt quạt vì đây không phải trạng thái cháy.
      if (systemMode == SystemMode::AUTO || manualFanRequest) fanOn();
      else fanOff();
      pumpOff();
      if (systemMode == SystemMode::MANUAL && manualBuzzerOverride && manualBuzzerRequest) buzzerOn();
      else buzzerOff();
      redLed(false);
      break;

    case SystemState::WARNING:
      fanOff();
      pumpOff();
      if (systemMode == SystemMode::MANUAL && manualBuzzerOverride) {
        manualBuzzerRequest ? buzzerOn() : buzzerOff();
      } else {
        if (now - previousWarningBlinkAt >= WARNING_BLINK_INTERVAL_MS) {
          previousWarningBlinkAt = now;
          warningBlinkState = !warningBlinkState;
        }
        warningBlinkState ? buzzerOn() : buzzerOff();
      }
      redLed(warningBlinkState);
      break;

    case SystemState::HIGH_RISK:
      fanOff();
      pumpOff();
      buzzerOn();
      redLed(true);
      break;

    case SystemState::FIRE:
    case SystemState::SUPPRESSING:
      // Safety rule: FIRE/HIGH priority > manual command.
      fanOff();
      if (!pumpSafetyLatchedOff) pumpOn(); else pumpOff();
      buzzerOn();
      redLed(true);
      break;

    case SystemState::POST_FIRE:
      fanOff();
      pumpOff();
      if (now - previousWarningBlinkAt >= WARNING_BLINK_INTERVAL_MS) {
        previousWarningBlinkAt = now;
        warningBlinkState = !warningBlinkState;
      }
      warningBlinkState ? buzzerOn() : buzzerOff();
      redLed(true);
      break;
  }

  // LED xanh: nháy 2 giây khi NORMAL/HOT, tắt trong trạng thái cảnh báo/cháy.
  if (systemState == SystemState::NORMAL || systemState == SystemState::HOT) {
    if (now - previousGreenBlinkAt >= GREEN_BLINK_INTERVAL_MS) {
      previousGreenBlinkAt = now;
      greenBlinkState = !greenBlinkState;
    }
    greenLed(greenBlinkState);
  } else {
    greenLed(false);
  }
}

// ============================================================
// MQTT
// ============================================================
void publishCommandResponse(const char* commandId,
                            const char* command,
                            const char* status,
                            const char* reason = nullptr) {
  if (!mqtt.connected()) return;

  StaticJsonDocument<384> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["commandId"] = commandId ? commandId : "";
  doc["command"] = command ? command : "";
  doc["status"] = status;
  if (reason) doc["reason"] = reason;
  if (reason) doc["message"] = reason;

  char payload[384];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  mqtt.publish(MQTT_COMMAND_RESPONSE_TOPIC, payload, n);
}

bool unsafeFanOnState() {
  return systemState == SystemState::FIRE ||
         systemState == SystemState::SUPPRESSING ||
         systemState == SystemState::HIGH_RISK ||
         systemState == SystemState::WARNING;
}

void handleCommand(const String& body) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    publishCommandResponse("", "", "REJECTED", "INVALID_JSON");
    return;
  }

  const char* commandId = doc["commandId"] | "";
  const char* command = doc["command"] | "";

  if (strcmp(command, "SET_AUTO_MODE") == 0) {
    systemMode = SystemMode::AUTO;
    manualFanRequest = false;
    manualPumpRequest = false;
    manualBuzzerRequest = false;
    manualBuzzerOverride = false;
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  if (strcmp(command, "SET_MANUAL_MODE") == 0) {
    systemMode = SystemMode::MANUAL;
    manualBuzzerOverride = false;
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  if (strcmp(command, "FAN_ON") == 0) {
    if (unsafeFanOnState()) {
      publishCommandResponse(commandId, command, "REJECTED", "FAN_ON_NOT_ALLOWED_DURING_SAFETY_STATE");
      return;
    }
    systemMode = SystemMode::MANUAL;
    manualFanRequest = true;
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  if (strcmp(command, "FAN_OFF") == 0) {
    systemMode = SystemMode::MANUAL;
    manualFanRequest = false;
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  if (strcmp(command, "PUMP_ON") == 0) {
    // Manual pump chỉ được áp dụng thực sự ở NORMAL.
    if (systemState != SystemState::NORMAL) {
      publishCommandResponse(commandId, command, "REJECTED", "PUMP_ON_ONLY_ALLOWED_IN_NORMAL");
      return;
    }
    systemMode = SystemMode::MANUAL;
    manualPumpRequest = true;
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  if (strcmp(command, "PUMP_OFF") == 0) {
    // Trong FIRE/SUPPRESSING, không cho manual tắt bơm vì safety rule.
    if (systemState == SystemState::FIRE || systemState == SystemState::SUPPRESSING) {
      publishCommandResponse(commandId, command, "REJECTED", "PUMP_OFF_NOT_ALLOWED_DURING_FIRE");
      return;
    }
    systemMode = SystemMode::MANUAL;
    manualPumpRequest = false;
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  if (strcmp(command, "BUZZER_ON") == 0) {
    if (systemMode != SystemMode::MANUAL) {
      publishCommandResponse(commandId, command, "REJECTED", "Manual mode required");
      return;
    }
    manualBuzzerRequest = true;
    manualBuzzerOverride = true;
    buzzerOn();
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  if (strcmp(command, "BUZZER_OFF") == 0) {
    if (systemMode != SystemMode::MANUAL) {
      publishCommandResponse(commandId, command, "REJECTED", "Manual mode required");
      return;
    }
    if (systemState == SystemState::HIGH_RISK ||
        systemState == SystemState::FIRE ||
        systemState == SystemState::SUPPRESSING) {
      buzzerOn();
      String message = String("Cannot disable buzzer during ") + stateToString(systemState);
      publishCommandResponse(commandId, command, "REJECTED", message.c_str());
      return;
    }
    if (systemState == SystemState::POST_FIRE) {
      publishCommandResponse(commandId, command, "REJECTED", "Cannot disable buzzer during POST_FIRE; RESET_ALARM is required");
      return;
    }
    manualBuzzerRequest = false;
    manualBuzzerOverride = true;
    buzzerOff();
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  if (strcmp(command, "RESET_ALARM") == 0) {
    if (systemState != SystemState::POST_FIRE) {
      publishCommandResponse(commandId, command, "REJECTED", "RESET_ONLY_ALLOWED_IN_POST_FIRE");
      return;
    }
    if (!isEnvironmentSafeAfterFire()) {
      publishCommandResponse(commandId, command, "REJECTED", "ENVIRONMENT_NOT_SAFE");
      return;
    }
    resetRequested = true;
    publishCommandResponse(commandId, command, "ACKNOWLEDGED");
    return;
  }

  publishCommandResponse(commandId, command, "REJECTED", "UNKNOWN_COMMAND");
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String body;
  body.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) body += static_cast<char>(payload[i]);
  Serial.printf("[MQTT] RX %s: %s\n", topic, body.c_str());

  if (String(topic) == MQTT_COMMAND_TOPIC) {
    handleCommand(body);
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  // Không block chờ Wi-Fi: local safety loop phải tiếp tục chạy khi mất mạng.
  Serial.printf("[WIFI] Start/retry connect to %s (non-blocking)\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;

  if (MQTT_USE_TLS) {
    if (strlen(MQTT_ROOT_CA) == 0) {
      if (!tlsConfigurationErrorLogged) {
        Serial.println("[MQTT] TLS enabled but MQTT_ROOT_CA is empty");
        tlsConfigurationErrorLogged = true;
      }
      return;
    }

    // X.509 certificate validation needs a valid clock. Start NTP without
    // blocking the local fire-safety loop and retry MQTT on the next cycle.
    if (time(nullptr) < 1700000000) {
      if (!tlsClockSyncRequested) {
        configTime(0, 0, "pool.ntp.org", "time.nist.gov");
        tlsClockSyncRequested = true;
        Serial.println("[MQTT] Waiting for NTP time before TLS connection");
      }
      return;
    }
  }

  String clientId = String(DEVICE_ID) + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  if (mqtt.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD)) {
    Serial.println("[MQTT] Connected");
    mqtt.subscribe(MQTT_COMMAND_TOPIC);
  } else {
    Serial.printf("[MQTT] Connect failed rc=%d\n", mqtt.state());
  }
}

void publishEvent(const char* eventType, const char* severity, const char* message) {
  if (!mqtt.connected()) return;
  StaticJsonDocument<512> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["eventType"] = eventType;
  doc["severity"] = severity;
  doc["state"] = stateToString(systemState);
  doc["message"] = message;
  doc["uptimeMs"] = millis();

  char payload[512];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  mqtt.publish(MQTT_EVENT_TOPIC, payload, n);
}

void publishStateTransitionEvent() {
  static SystemState lastPublished = SystemState::NORMAL;
  static bool initialized = false;

  if (!initialized) {
    lastPublished = systemState;
    initialized = true;
    return;
  }
  if (systemState == lastPublished) return;

  switch (systemState) {
    case SystemState::WARNING:
      publishEvent("SMOKE_WARNING", "WARNING", "Smoke/gas threshold exceeded");
      break;
    case SystemState::HIGH_RISK:
      publishEvent("HIGH_RISK", "HIGH", "Critical smoke + fast temperature rise");
      break;
    case SystemState::FIRE:
      publishEvent("FIRE_DETECTED", "CRITICAL", "Fire condition confirmed");
      break;
    case SystemState::SUPPRESSING:
      publishEvent("FIRE_SUPPRESSING", "CRITICAL", "Pump active, fan forced OFF");
      break;
    case SystemState::POST_FIRE:
      publishEvent("FIRE_CLEARED", "INFO", "Flame cleared, waiting for reset");
      break;
    case SystemState::HOT:
      publishEvent("HIGH_TEMPERATURE", "WARNING", "Temperature above cooling threshold");
      break;
    default:
      break;
  }
  lastPublished = systemState;
}

void publishTelemetry() {
  if (!mqtt.connected()) return;

  StaticJsonDocument<768> doc;
  doc["deviceId"] = DEVICE_ID;
  if (sensors.dhtOk) {
    doc["temperature"] = sensors.temperature;
    doc["humidity"] = sensors.humidity;
  } else {
    doc["temperature"] = nullptr;
    doc["humidity"] = nullptr;
  }
  doc["temperatureRate"] = sensors.temperatureRate;
  doc["smokeRaw"] = sensors.mq2Analog;
  doc["smokeLevel"] = sensors.smokeCritical ? "CRITICAL" : (sensors.gasDetected ? "WARNING" : "NORMAL");
  doc["flameDetected"] = sensors.flameDetected;
  doc["flameConfirmed"] = sensors.flameConfirmed;
  doc["state"] = stateToString(systemState);
  doc["mode"] = modeToString(systemMode);
  doc["fanOn"] = actuators.fanOn;
  doc["pumpOn"] = actuators.pumpOn;
  doc["buzzerOn"] = actuators.buzzerOn;
  doc["dhtOk"] = sensors.dhtOk;
  doc["wifiRssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  doc["uptimeMs"] = millis();

  char payload[768];
  size_t n = serializeJson(doc, payload, sizeof(payload));
  mqtt.publish(MQTT_TELEMETRY_TOPIC, payload, n);
}

// ============================================================
// OLED / SERIAL
// ============================================================
void showOLED() {
  if (!oledOk) return;

  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);
  display.setTextSize(1);

  display.setCursor(0, 0);
  display.print("STATE:");
  display.println(stateToString(systemState));

  display.setCursor(0, 13);
  if (sensors.dhtOk) {
    display.print("T:"); display.print(sensors.temperature, 1); display.print("C ");
    display.print("H:"); display.print(sensors.humidity, 0); display.println("%");
  } else {
    display.println("DHT: ERROR");
  }

  display.setCursor(0, 26);
  display.print("MQ2:"); display.print(sensors.mq2Analog);
  display.print(" "); display.println(sensors.gasDetected ? "SMOKE" : "OK");

  display.setCursor(0, 39);
  display.print("FLAME:"); display.print(sensors.flameDetected ? "YES" : "NO");
  display.print(" F:"); display.println(actuators.fanOn ? "ON" : "OFF");

  display.setCursor(0, 52);
  display.print("P:"); display.print(actuators.pumpOn ? "ON" : "OFF");
  display.print(" M:"); display.println(modeToString(systemMode));

  display.display();
}

void showSerial() {
  Serial.println("================================================");
  Serial.printf("STATE=%s MODE=%s\n", stateToString(systemState), modeToString(systemMode));
  if (sensors.dhtOk) {
    Serial.printf("TEMP=%.1fC HUM=%.1f%% dT/dt=%.3f C/s\n",
                  sensors.temperature,
                  sensors.humidity,
                  sensors.temperatureRate);
  } else {
    Serial.println("DHT22=ERROR");
  }
  Serial.printf("MQ2_AO=%d MQ2_DO=%d GAS=%s CRITICAL=%s\n",
                sensors.mq2Analog,
                sensors.mq2Digital,
                sensors.gasDetected ? "YES" : "NO",
                sensors.smokeCritical ? "YES" : "NO");
  Serial.printf("FLAME_DO=%d DETECTED=%s CONFIRMED=%s\n",
                sensors.flameDigital,
                sensors.flameDetected ? "YES" : "NO",
                sensors.flameConfirmed ? "YES" : "NO");
  Serial.printf("FAN=%s PUMP=%s BUZZER=%s WIFI=%s MQTT=%s\n",
                actuators.fanOn ? "ON" : "OFF",
                actuators.pumpOn ? "ON" : "OFF",
                actuators.buzzerOn ? "ON" : "OFF",
                WiFi.status() == WL_CONNECTED ? "ONLINE" : "OFFLINE",
                mqtt.connected() ? "ONLINE" : "OFFLINE");
}

// ============================================================
// SETUP / LOOP
// ============================================================
void setup() {
  Serial.begin(115200);

  pinMode(MQ2_AO, INPUT);
  pinMode(MQ2_DO, INPUT);
  pinMode(FLAME_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BOM, OUTPUT);
  pinMode(QUAT, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(MQ2_AO, ADC_11db);

  fanOff();
  pumpOff();
  buzzerOff();
  redLed(false);
  greenLed(false);

  dht.begin();
  Wire.begin(OLED_SDA, OLED_SCL);
  oledOk = display.begin(OLED_ADDRESS, true);

  if (oledOk) {
    display.clearDisplay();
    display.setTextColor(SH110X_WHITE);
    display.setTextSize(1);
    display.setCursor(14, 22);
    display.println("IOT FIRE SYSTEM");
    display.setCursor(28, 38);
    display.println("STARTING...");
    display.display();
  } else {
    Serial.println("[OLED] Not found");
  }

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  if (MQTT_USE_TLS && strlen(MQTT_ROOT_CA) > 0) {
    secureWifiClient.setCACert(MQTT_ROOT_CA);
  }
  mqtt.setSocketTimeout(1);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(1024);

  connectWiFi();
  connectMqtt();

  stateEnteredAt = millis();
  delay(1500);
}

void loop() {
  const unsigned long now = millis();

  // Network reconnect không ảnh hưởng logic an toàn cục bộ.
  static unsigned long previousReconnectAt = 0;
  if (now - previousReconnectAt >= 5000) {
    previousReconnectAt = now;
    if (WiFi.status() != WL_CONNECTED) connectWiFi();
    if (!mqtt.connected()) connectMqtt();
  }
  if (mqtt.connected()) mqtt.loop();

  if (now - previousSensorAt >= SENSOR_INTERVAL_MS) {
    previousSensorAt = now;
    readSensors();
    evaluateStateMachine();
    applyActuators();
    publishStateTransitionEvent();
  }

  if (now - previousTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    previousTelemetryAt = now;
    publishTelemetry();
  }

  if (now - previousOledAt >= OLED_INTERVAL_MS) {
    previousOledAt = now;
    showOLED();
  }

  if (now - previousSerialAt >= SERIAL_INTERVAL_MS) {
    previousSerialAt = now;
    showSerial();
  }
}
