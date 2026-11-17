#pragma once

// Copy file này thành secrets.h và điền thông tin thật.
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Cloud: hostname + port 8883 + TLS true.
// Local fallback: a DNS/mDNS hostname + port 1883 + TLS false.
#define MQTT_HOST "e1110a86.ala.asia-southeast1.emqxsl.com"
#define MQTT_PORT 8883
#define MQTT_USE_TLS true
#define MQTT_USERNAME "iot_device"
#define MQTT_PASSWORD "<IOT_DEVICE_PASSWORD>"
