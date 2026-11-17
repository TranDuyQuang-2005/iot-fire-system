#pragma once
#include <Arduino.h>

enum class SystemState {
  NORMAL,
  HOT,
  WARNING,
  HIGH_RISK,
  FIRE,
  SUPPRESSING,
  POST_FIRE
};

enum class SystemMode {
  AUTO,
  MANUAL
};

struct SensorSnapshot {
  float temperature = NAN;
  float humidity = NAN;
  float temperatureRate = 0.0f;
  int mq2Analog = 4095;
  int mq2Digital = 0;
  int flameDigital = 1;
  bool dhtOk = false;
  bool gasDetected = false;
  bool smokeCritical = false;
  bool flameDetected = false;
  bool flameConfirmed = false;
};

struct ActuatorState {
  bool fanOn = false;
  bool pumpOn = false;
  bool buzzerOn = false;
  bool redLedOn = false;
  bool greenLedOn = false;
};

inline const char* stateToString(SystemState s) {
  switch (s) {
    case SystemState::NORMAL: return "NORMAL";
    case SystemState::HOT: return "HOT";
    case SystemState::WARNING: return "WARNING";
    case SystemState::HIGH_RISK: return "HIGH_RISK";
    case SystemState::FIRE: return "FIRE";
    case SystemState::SUPPRESSING: return "SUPPRESSING";
    case SystemState::POST_FIRE: return "POST_FIRE";
    default: return "UNKNOWN";
  }
}

inline const char* modeToString(SystemMode m) {
  return m == SystemMode::AUTO ? "AUTO" : "MANUAL";
}
